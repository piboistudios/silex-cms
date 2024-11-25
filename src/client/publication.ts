import dedent from 'dedent'
import STORE_JS from './store.source.js';
import { Component, Page } from 'grapesjs'
import getFilters from '@silexlabs/grapesjs-data-source/src/filters/liquid'
import { minify_sync } from 'terser'
import { BinariOperator, DataSourceEditor, DataTree, Expression, Filter, IDataSourceModel, NOTIFICATION_GROUP, Options, Properties, Property, PropertyOptions, State, StateId, StoredState, StoredStateWithId, StoredToken, Token, UnariOperator, fromStored, getOrCreatePersistantId, getPersistantId, getState, getStateIds, getStateVariableName, toExpression } from '@silexlabs/grapesjs-data-source'
import * as ESTree from 'estree';
import * as AST from 'astring';
import { assignBlock, echoBlock, echoBlock1line, getFieldId, getPaginationData, ifBlock, loopBlock } from './liquid'
import { EleventyPluginOptions, Silex11tyPluginWebsiteSettings } from '../client'
import { PublicationTransformer } from '@silexlabs/silex/src/ts/client/publication-transformers'
import { ClientConfig } from '@silexlabs/silex/src/ts/client/config'
import { UNWRAP_ID } from './traits'
import { EleventyDataSourceId } from './DataSource'
import { ACTIONS_JS } from './actions';
import { isFixed, isHttp, isState, parseEntries, tryParse } from './utils.js';
//import { ClientSideFile, ClientSideFileType, ClientSideFileWithContent, PublicationData } from '@silexlabs/silex/src/ts/types'
const minify = minify_sync;
// FIXME: should be imported from silex
type ClientSideFile = {
  path: string,
  type: string,
}
type ClientSideFileWithContent = ClientSideFile & {
  content: string,
}
type PublicationData = {
  files?: ClientSideFile[],
}
enum ClientSideFileType {
  HTML = 'html',
  CSS = 'css',
  ASSET = 'asset',
  OTHER = 'other',
}

const ATTRIBUTE_MULTIPLE_VALUES = ['class', 'style']

/**
 * A memoization mechanism to avoid rendering the same component multiple times
 * The cache is cleared every time the publication is done
 * This is a workaround because grapesjs editor.getHtml will call each component's toHtml method multiple times
 */
export const cache = new Map<string, any>()

/**
 * A state with the real tokens instead of the stored tokens
 */
interface RealState {
  stateId: StateId,
  label?: string,
  tokens: Token[]
}

function getFetchPluginOptions(options: EleventyPluginOptions, settings: Silex11tyPluginWebsiteSettings): object | false {
  if (settings.eleventyFetch) {
    return options.fetchPlugin || {}
  }
  return options.fetchPlugin ?? false
}

export default function (config: ClientConfig, options: EleventyPluginOptions) {
  config.on('silex:startup:end', () => {
    const editor = config.getEditor() as unknown as DataSourceEditor
    // Generate the liquid when the site is published
    config.addPublicationTransformers({
      // Render the components when they are published
      // Will run even with enable11ty = false in order to enable HTML attributes
      renderComponent: (component, toHtml) => withNotification(() => renderComponent(config, component as any, toHtml), editor, component.getId()),
      // Transform the paths to be published according to options.urls
      transformPermalink: options.enable11ty ? (path, type) => withNotification(() => transformPermalink(editor, path, type, options), editor, null) : undefined,
      // Transform the paths to be published according to options.dir
      transformPath: options.enable11ty ? (path, type) => withNotification(() => transformPath(editor, path, type, options), editor, null) : undefined,
      // Transform the files content
      //transformFile: (file) => transformFile(file),
    })
    editor.on('silex:publish:start', () => {
      editor.getWrapper()?.unset?.('fieldIds');
    })

    if (options.enable11ty) {
      // Generate 11ty data files
      // FIXME: should this be in the publication transformers
      // editor.on('silex:publish:page', data => withNotification(() => transformPage(editor, data), editor, null))
      // editor.on('silex:publish:data', (data) => withNotification(() => transformFiles(editor, options, data), editor, null))
      editor.on('silex:publish:end', () => {
        cache.clear();
      })
    }
  })
}

/**
 * Check if the 11ty publication is enabled
 */
function enable11ty(editor: DataSourceEditor): boolean {
  return editor
    .DataSourceManager
    .getAll()
    .filter(ds => ds.id !== EleventyDataSourceId)
    .length > 0
}

/**
 * Make html attribute
 * Quote strings, no values for boolean
 */
function makeAttribute(key, value): string {
  switch (typeof value) {
    case 'boolean': return value ? key : ''
    default: return `${key}="${value}"`
  }
}

/**
 * Comes from silex but didn't manage to import
 * FIXME: expose this from silex
 */
function transformPaths(editor: DataSourceEditor, path: string, type): string {
  const config = editor.getModel().get('config')
  return config.publicationTransformers.reduce((result: string, transformer: PublicationTransformer) => {
    try {
      return transformer.transformPath ? transformer.transformPath(result, type) ?? result : result
    } catch (e) {
      console.error('Publication transformer: error transforming path', result, e)
      return result
    }
  }, path)
}

/**
 * Transform the file name to be published
 */
function slugify(text) {
  return text.toString().toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^a-z0-9-]/g, '') // Remove all non-word chars
    .replace(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, '') // Trim - from end of text
}

export function getPermalink(page: Page, permalink: Token[], isCollectionPage: boolean, slug: string): string | null {
  const isHome = slug === 'index'
  // User provided a permalink explicitely
  if (permalink && permalink.length > 0) {
    const body = page.getMainComponent() as Component
    return echoBlock1line(body, permalink.map(token => {
      // Replace states which will be one from ./states.ts
      if (token.type === 'state') {
        const state = getState(body, token.storedStateId, true)
        if (!state) throw new Error('State not found on body')
        return {
          ...state.expression[0],
          dataSourceId: undefined,
          fieldId: token.label,
        } as Property
      }
      return token
    }))
  } else if (isCollectionPage) {
    // Let 11ty handle the permalink
    return null
  } else if (isHome) {
    // Normal home page
    return '/index.html'
  } else {
    // Use the page name
    return `/${slug}/index.html`
  }
}

/**
 * Get the front matter for a given page
 */
export function getFrontMatter(page: Page, settings: Silex11tyPluginWebsiteSettings, slug: string, collection, lang = ''): string {
  const data = (function () {
    if (!settings.eleventyPageData) return undefined
    const expression = toExpression(settings.eleventyPageData)
    if (expression) {
      if (expression.filter(token => token.type !== 'property').length > 0) {
        console.warn('Expression for pagination data has to contain only properties', expression.map(token => token.type))
      }
      return getPaginationData(page.getMainFrame().getComponent(), expression as Property[])
    } else {
      // Probably not JSON (backward compat)
      return settings.eleventyPageData
    }
  })()

  const isCollectionPage = !!data && data.length > 0
  const permalinkExpression = toExpression(settings.eleventyPermalink)
  // Here permalinkExpression contains filters and properties. It contains 11ty data source states too
  const permalink = getPermalink(page, permalinkExpression as (Property | Filter)[], isCollectionPage, slug)
    // Escape quotes in permalink
    // because it is in double quotes in the front matter
    ?.replace(/"/g, '\\"')

  return dedent`---
    ${data && data.length > 0 ? `pagination:
      addAllPagesToCollections: true
      data: ${data}
      size: ${settings.eleventyPageSize ? settings.eleventyPageSize : '1'}
      ${settings.eleventyPageReverse ? 'reverse: true' : ''}
    ` : ''}
    ${permalink ? `permalink: "${permalink}"` : ''}
    ${lang ? `lang: "${lang}"` : ''}
    ${collection ? `collection: "${collection}"` : ''}
    ${settings?.eleventyNavigationKey ? `eleventyNavigation:
      key: ${settings.eleventyNavigationKey}
      ${settings.eleventyNavigationTitle ? `title: ${settings.eleventyNavigationTitle}` : ''}
      ${settings.eleventyNavigationOrder ? `order: ${settings.eleventyNavigationOrder}` : ''}
      ${settings.eleventyNavigationParent ? `parent: ${settings.eleventyNavigationParent}` : ''}
      ${settings.eleventyNavigationUrl ? `url: ${settings.eleventyNavigationUrl}` : ''}
    ` : ''}
  `
    // Prettify
    .split('\n')
    .filter(line => line.trim().length > 0)
    .concat(['', '---', ''])
    .join('\n')
}

/**
 * Get the body states for a given page
 */
export function getBodyStates(page: Page): string {
  // Render the body states
  const body = page.getMainComponent() as Component
  const pagination = getState(body, 'pagination', true)
  if (pagination && pagination.expression.length > 0) {
    //const block = getLiquidBlock(body, pagination.expression)
    const bodyId = getPersistantId(body)
    if (bodyId) {
      return dedent`
        {% assign ${getStateVariableName(bodyId, 'pagination')} = pagination %}
        {% assign ${getStateVariableName(bodyId, 'items')} = pagination.items %}
        {% assign ${getStateVariableName(bodyId, 'pages')} = pagination.pages %}
      `
    } else {
      console.error('body has no persistant ID => do not add liquid for 11ty data')
    }
  }
  return ''
}

export function transformPage(editor: DataSourceEditor, data: { page, siteSettings, pageSettings }): void {
  // Do nothing if there is no data source, just a static site
  if (!enable11ty(editor)) return

  const { pageSettings, page } = data
  const body = page.getMainComponent()
  if (pageSettings.eleventySeoTitle) {
    const expression = toExpression(pageSettings.eleventySeoTitle)
    if (expression && expression.length) pageSettings.title = echoBlock(body, expression)
  }
  if (pageSettings.eleventySeoDescription) {
    const expression = toExpression(pageSettings.eleventySeoDescription)
    if (expression && expression.length) pageSettings.description = echoBlock(body, expression)
  }
  if (pageSettings.eleventyFavicon) {
    const expression = toExpression(pageSettings.eleventyFavicon)
    if (expression && expression.length) pageSettings.favicon = echoBlock(body, expression)
  }
  if (pageSettings.eleventyOGImage) {
    const expression = toExpression(pageSettings.eleventyOGImage)
    if (expression && expression.length) pageSettings['og:image'] = echoBlock(body, expression)
  }
  if (pageSettings.eleventyOGTitle) {
    const expression = toExpression(pageSettings.eleventyOGTitle)
    if (expression && expression.length) pageSettings['og:title'] = echoBlock(body, expression)
  }
  if (pageSettings.eleventyOGDescription) {
    const expression = toExpression(pageSettings.eleventyOGDescription)
    if (expression && expression.length) pageSettings['og:description'] = echoBlock(body, expression)
  }
}

/**
 * Transform the files to be published
 * This hook is called just before the files are written to the file system
 * Exported for unit tests
 */
export function transformFiles(editor: DataSourceEditor, options: EleventyPluginOptions, data: PublicationData): void {
  // Do nothing if there is no data source, just a static site
  if (!enable11ty(editor)) return

  // Type safe data source manager
  const dsm = editor.DataSourceManager

  editor.Pages.getAll().forEach(page => {
    // Get the page properties
    const slug = slugify(page.getName() || 'index')
    const settings = (page.get('settings') ?? {}) as Silex11tyPluginWebsiteSettings
    const languages = settings.silexLanguagesList?.split(',').map(lang => lang.trim()).filter(lang => !!lang)

    // Create the data file for this page
    const query = dsm.getPageQuery(page)
    // Remove empty data source queries
    Object.entries(query).forEach(([key, value]) => {
      if (value.length === 0) {
        delete query[key]
      }
    })

    // Find the page in the published data
    if (!data.files) throw new Error('No files in publication data')
    const path = transformPaths(editor, `/${slug}.html`, 'html')
    const pageData = data.files.find(file => file.path === path) as ClientSideFileWithContent | undefined
    if (!pageData) throw new Error(`No file for path ${path}`)
    if (pageData.type !== ClientSideFileType.HTML) throw new Error(`File for path ${path} is not HTML`)
    const dataFile = Object.keys(query).length > 0 ? {
      type: ClientSideFileType.OTHER,
      path: transformPaths(editor, `/${slugify(page.getName() || 'index')}.11tydata.mjs`, 'html'),
      //path: `/${page.getName() || 'index'}.11tydata.mjs`,
      content: getDataFile(editor, page, null, query, options),
    } : null

    if (languages && languages.length > 0) {
      const pages: ClientSideFileWithContent[] = languages.flatMap(lang => {
        // Change the HTML
        const frontMatter = getFrontMatter(page, settings, slug, page.getName(), lang)
        const bodyStates = getBodyStates(page)
        const pageFile = {
          type: ClientSideFileType.HTML,
          path: path.replace(/\.html$/, `-${lang}.html`),
          content: frontMatter + bodyStates + pageData.content,
        }

        // Create the data file for this page
        if (dataFile) {
          return [pageFile, {
            ...dataFile,
            path: dataFile.path.replace(/\.11tydata\.mjs$/, `-${lang}.11tydata.mjs`),
            content: getDataFile(editor, page, lang, query, options),
          }] // It is important to keep pageFile first, see bellow
        }
        return pageFile
      })

      // Update the existing page
      const [existingPage, ...newPages] = pages
      pageData.content = existingPage.content
      pageData.path = existingPage.path

      // Add the other pages
      data.files.push(...newPages)
    } else {
      // Change the HTML
      const frontMatter = getFrontMatter(page, settings, slug, page.getName())
      const bodyStates = getBodyStates(page)

      // Update the page before it is published
      const content = frontMatter + bodyStates + pageData.content
      pageData.content = content

      // Add the data file
      if (dataFile) {
        // There is at least 1 query in this page
        data.files.push(dataFile)
      }
    }
  })
}

/**
 * Generate the data file for a given silex page
 * This file will be used by 11ty to generate the final website's page
 * 11ty will use this file to get the data from the data sources
 * - Language
 * - Native fetch or 11ty-fetch plugin
 * - esModule or commonjs
 * - Cache buster
 *
 */
function getDataFile(editor: DataSourceEditor, page: Page, lang: string | null, query: Record<string, string>, options: EleventyPluginOptions): string {
  const esModule = options.esModule === true || typeof options.esModule === 'undefined'
  const fetchPlugin = getFetchPluginOptions(options, editor.getModel().get('settings') || {})
  const fetchImportStatement = fetchPlugin ? (esModule ? 'import EleventyFetch from \'@11ty/eleventy-fetch\'' : 'const EleventyFetch = require(\'@11ty/eleventy-fetch\')') : ''
  const exportStatement = esModule ? 'export default' : 'module.exports ='
  const dsm = editor.DataSourceManager

  const content = Object.entries(query).map(([dataSourceId, queryStr]) => {
    const dataSource = dsm.get(dataSourceId)
    if (dataSource) {
      return queryToDataFile(dataSource, queryStr, options, page, lang, fetchPlugin)
    } else {
      console.error('No data source for id', dataSourceId)
      throw new Error(`No data source for id ${dataSourceId}`)
    }
  }).join('\n')
  return `
${fetchImportStatement}
${exportStatement} async function (configData) {
  const data = {
    ...configData,
    lang: '${lang || ''}',
  }
  const result = {}
  ${content}
  return result
}
  `
}

/**
 * Exported for unit tests
 */
export function queryToDataFile(dataSource: IDataSourceModel, queryStr: string, options: EleventyPluginOptions, page: Page, lang: string | null, fetchPlugin: object | false): string {
  if (dataSource.get('type') !== 'graphql') {
    console.info('not graphql', dataSource)
    return ''
  }
  const s2s = dataSource.get('serverToServer')
  const url = s2s ? s2s.url : dataSource.get('url')
  const urlWithCacheBuster = options.cacheBuster ? `${url}${url.includes('?') ? '&' : '?'}page_id_for_cache=${page.getId()}${lang ? `-${lang}` : ''}` : url
  const method = s2s ? s2s.method : dataSource.get('method')
  const headers = s2s ? s2s.headers : dataSource.get('headers')
  if (headers && !Object.keys(headers).find(key => key.toLowerCase() === 'content-type')) {
    console.warn('11ty plugin for Silex: no content-type in headers of the graphql query. I will set it to application/json for you. To avoid this warning, add a header with key "content-type" and value "application/json" in silex config.')
    headers['content-type'] = 'application/json'
  }
  const headersStr = headers ? Object.entries(headers).map(([key, value]) => `'${key}': \`${value}\`,`).join('\n') : ''

  const fetchOptions = {
    key: dataSource.id as string,
    method,
    url: urlWithCacheBuster,
    headers: headersStr,
    query: `JSON.stringify({
      query: \`${queryStr}\`,
    })`, // Let 11ty interpolate the query wich let us add variables in the plugin config
  }
  return fetchPlugin ? makeFetchCallEleventy(fetchOptions, fetchPlugin) : makeFetchCall(fetchOptions)
}

export function makeFetchCall(options: { key: string, url: string, method: string, headers: string, query: string }): string {
  return dedent`
  try {
    const response = await fetch(\`${options.url}\`, {

    headers: {
      ${options.headers}
    },
    method: '${options.method}',
    body: ${options.query}
    })

    if (!response.ok) {
      throw new Error(\`Error fetching graphql data: HTTP status code \${response.status}, HTTP status text: \${response.statusText}\`)
    }

    const json = await response.json()

    if (json.errors) {
      throw new Error(\`GraphQL error: \\n> \${json.errors.map(e => e.message).join('\\n> ')}\`)
    }

    result['${options.key}'] = json.data
  } catch (e) {
    console.error('11ty plugin for Silex: error fetching graphql data', e, '${options.key}', '${options.url}')
    throw e
  }
`
}

export function makeFetchCallEleventy(options: { key: string, url: string, method: string, headers: string, query: string }, fetchPlugin: object): string {
  return dedent`
  try {
    const json = await EleventyFetch(\`${options.url}\`, {
    ...${JSON.stringify(fetchPlugin)},
    type: 'json',
    fetchOptions: {
      headers: {
        ${options.headers}
      },
      method: '${options.method}',
      body: ${options.query},
    }
    })

    if (json.errors) {
      throw new Error(\`GraphQL error: \\n> \${json.errors.map(e => e.message).join('\\n> ')}\`)
    }

    result['${options.key}'] = json.data
  } catch (e) {
    console.error('11ty plugin for Silex: error fetching graphql data', e, '${options.key}', '${options.url}')
    throw e
  }
`
}

/**
 * Make stored states into real states
 * Filter out hidden states and empty expressions
 */
function getRealStates(dataTree: DataTree, states: { stateId: StateId, state: StoredState }[]): { stateId: StateId, label: string, tokens: State[] }[] {
  return states
    .filter(({ state }) => !state.hidden)
    .filter(({ state }) => state.expression.length > 0)
    // From expression of stored tokens to tokens (with methods not only data)
    .map(({ stateId, state }) => ({
      stateId,
      label: state.label || stateId,
      tokens: state.expression.map(token => {
        const componentId = state.expression[0].type === 'state' ? state.expression[0].componentId : null
        return fromStored(token, dataTree, componentId)
      }),
    }))
}

/**
 * Check if a state is an attribute
 * Exported for unit tests
 */
export function isAttribute(label: string): boolean {
  if (!label) return false
  return !Object.values(Properties).includes(label as Properties)
}

/**
 * Build the attributes string for a given component
 * Handle attributes which appear multiple times (class, style)
 * Append to the original attributes
 * Exported for unit tests
 */
export function buildAttributes(originalAttributes: Record<string, string>, attributeStates: { stateId: StateId, label: string, value: string }[]): string {
  const attributesArr = Object.entries(originalAttributes)
    // Start with the original attributes
    .map(([label, value]) => ({
      stateId: label,
      label,
      value,
    }))
    // Override or add state attributes
    .concat(attributeStates)
    // Handle attributes which appear multiple times
    .reduce((final, { stateId, label, value }) => {
      const existing = final.find(({ label: existingLabel }) => existingLabel === label)
      if (existing) {
        if (label.indexOf('x-') === 0) return final;
        if (ATTRIBUTE_MULTIPLE_VALUES.includes(label)) {
          // Add to the original value
          existing.value += ' ' + value
        } else {
          // Override the original value
          existing.value = value
        }
      } else {
        // First time we see this attribute
        final.push({
          stateId,
          label,
          value,
        })
      }
      // Return the original array
      return final
    }, [] as ({ stateId: StateId, value: string | boolean, label: string })[])
  // Build final result
  return attributesArr
    // Convert to key="value" string
    .map(({ label, value }) => makeAttribute(label, value))
    // Back to string
    .join(' ')
}

function withNotification<T>(cbk: () => T, editor: DataSourceEditor, componentId: string | null): T {
  try {
    return cbk()
  } catch (e) {
    editor.runCommand('notifications:add', {
      type: 'error',
      message: `Error rendering component: ${e.message}`,
      group: NOTIFICATION_GROUP,
      componentId,
    })
    throw e
  }
}

/**
 * Render the components when they are published
 */
function renderComponent(config: ClientConfig, component: Component, toHtml: () => string): string | undefined {
  const componentId = component.getId();
  console.log("Rendering", component, component.tagName);
  if (cache.has(componentId)) {
    return cache.get(componentId)
  }
  const attributes = component.getAttributes();
  if (attributes["id"] === 'pagedata' && attributes.type === 'application/json') {
    return '<script type="application/json" id="pagedata">{{ pagedata | json }}</script>'
  }
  let script = String(component.defaults?.script) || ''
  const editor = config.getEditor() as unknown as DataSourceEditor

  const dataTree = editor.DataSourceManager.getDataTree()
  const states = getStatesObj(config, component);
  const { statesObj, statesPrivate, statesPublic } = states;

  const reactive = componentIsReactive(component);
  // console.log("Component:", component, "is reactive?", reactive);
  const unwrap = component.get(UNWRAP_ID)
  if (component.get('type') === 'wrapper') {

    component.unset('script');
    script = getBoilerplateScript(component, config);
    component.set('script', script);
    // component.addAttributes({ "x-data": true });
    const existingScript = editor.Components.getById('pagedata');
    if (!existingScript) {


      const [pagedata] = editor.addComponents({
        type: "text",
        tagName: "script",
        attributes: {
          type: "application/json",
          id: "pagedata"
        },
        content: "{% pagedata | json %}"
      });
      pagedata.move(component, { at: 0 });
      // component.save();
      pagedata.setId("pagedata");
    }

  }

  if (statesPrivate.length > 0 || statesPublic.length > 0 || unwrap || reactive) {
    const tagName = component.get('tagName')?.toLowerCase()
    if (tagName) {
      // Convenience key value object


      const hasInnerHtml = !!statesObj.innerHTML?.tokens.length
      const hasCondition = !!statesObj.condition?.tokens.length
      const hasData = !!statesObj.__data?.tokens.length

      // Style attribute
      let innerHtml = hasInnerHtml ? echoBlock(component, statesObj.innerHTML.tokens) : component.getInnerHTML()
      const operator = component.get('conditionOperator') ?? UnariOperator.TRUTHY
      const binary = operator && Object.values(BinariOperator).includes(operator)
      const win: any = window;
      win._debug = {
        statesObj,
        component,

      }
      const condition = hasCondition ? (binary ? {
        expression: statesObj.condition.tokens,
        expression2: statesObj.condition2?.tokens ?? [],
        operator,
      } : {
        expression: statesObj.condition.tokens,
        operator,
      }) : undefined;
      let [ifStart, ifEnd] = hasCondition ? ifBlock(component, condition!) : []
      let reactiveForStart, reactiveForEnd;
      let originalAttributes = component.get('attributes') as Record<string, string>
      originalAttributes.class = component.getClasses().join(' ')

      const [forStart, forEnd] = hasData ? loopBlock(dataTree, component, statesObj.__data.tokens) : []
      console.log("For start/end sh", { forStart, forEnd, component, tagName: component.tagName, reactive })
      const states = statesPublic
        .map(({ stateId, tokens }) => assignBlock(stateId, component, tokens))
        .join('\n')

      const attributeStates = statesPrivate
        // Filter out properties, keep only attributes
        .filter(({ label }) => isAttribute(label))
        // Make tokens a string
        .map(({ stateId, tokens, label }) => ({
          stateId,
          label,
          value: echoBlock(component, tokens),
        }));
      if (reactive) {
        const fieldId = p => getFieldId(component, p)
        const parent = component.parent();
        if (parent && !parent.getAttributes?.()?.['x-data']) {
          parent.setAttributes({
            'x-data': true
          })
        }
        // component.unset('script');
        // script += '\n' + getAlpineDataScript(component)
        // component.set('script', script);
        // component.save({
        //   script: script
        // })
        if (hasCondition) {
          ifStart = `<template x-data="${!hasAlpineData(component) ? '' : sanitizeId(getOrCreatePersistantId(component))}" x-if="` + genJs(toJsCondition(component, condition!), { minify: true }) + `">`;
          ifEnd = '</template>';
          // let clone = component.clone();
          // (clone as any).$$conditionHandled = true;
          // (clone as any).$$loopHandled = (component as any).$$loopHandled;
          // clone = alpinify(clone, { config, statesObj, tagName, dataTree, statesPrivate, statesPublic, originalAttributes });
          // // const template = editor.addComponents({
          // //   tagName: 'template',
          // //   attributes: {
          // //     "x-data": true,
          // //     'x-if': genJs(toJsCondition(component, condition!), { minify: true })
          // //   },
          // //   components: [clone],
          // //   // content: clone.toHTML(),

          // // })[0];
          // const html = renderComponent(config, template, template.toHTML.bind(template)) || '';
          // template.remove();
          // cache.set(componentId, html);
          // return html;
        }
        if (forStart && forEnd) {
          const persistentId = getPersistantId(component);
          if (!persistentId) {
            console.error('Component', component, 'has no persistant ID. Persistant ID is required to get component states.')
            throw new Error('This component has no persistant ID')
          }
          const stateVarName: string = toJsVarName(getStateVariableName(persistentId, '__data'))
          reactiveForStart = `<template x-data="${!hasAlpineData(component) ? '' : sanitizeId(getOrCreatePersistantId(component))}" x-for="` + `${stateVarName} in ${maybeAwaitJs(genJs(ensureFilteredData(toJsExpression(statesObj.__data.tokens, { transformers: { baseFieldId: fieldId } }), statesObj.__data.tokens), { minify: true }))}` + '">'
          reactiveForEnd = '</template>';
          console.log("set reactive for start/end", { reactiveForStart, reactiveForEnd, component });
          // let clone = component.clone();
          // (clone as any).$$loopHandled = true;
          // (clone as any).$$conditionHandled = (component as any).$$conditionHandled;
          // clone = alpinify(clone, { config, statesObj, tagName, dataTree, statesPrivate, statesPublic, originalAttributes });
          // const attributes = clone.getAttributes();
          // delete attributes['x-rm'];
          // attributes['id'] = componentId;
          // clone.setAttributes(attributes);

          // clone.unset('script');
          // const template = editor.addComponents({
          //   tagName: 'template',
          //   attributes: {
          //     "x-data": true,
          //     "x-for": `${stateVarName} in ${maybeAwaitJs(genJs(ensureFilteredData(toJsExpression(statesObj.__data.tokens), statesObj.__data.tokens), { minify: true }))}`
          //   },
          //   components: [clone],
          //   // content: clone.toHTML()
          // })[0];
          // const html = renderComponent(config, template, template.toHTML.bind(template)) || '';
          // before = html + '\n' + before;
          // template.remove();

        }
        component = alpinify(component, { config, statesObj, tagName, dataTree, statesPrivate, statesPublic, originalAttributes });
        innerHtml = hasInnerHtml ? innerHtml : component.getInnerHTML()
        // console.log("script for", tagName, ":", component.get('script'))
        // console.log("component" + tagName + ":", component)
      }
      let before = (states ?? '') + (forStart ?? '') + (ifStart ?? '')
      let after = (ifEnd ?? '') + (forEnd ?? '')
      console.log('for stuff or w/e', { forStart, forEnd, reactiveForStart, reactiveForEnd, component });
      // Attributes
      // Add css classes
      // Make the list of attributes
      const atts = component.get('attributes') as Record<string, string>
      atts.class = component.getClasses().join(' ')
      const attributes = buildAttributes(atts, attributeStates)
      const mkReactiveHtml = reactiveForStart && reactiveForEnd;
      component.setAttributes(originalAttributes);
      let html = '', reactiveHtml = '';;
      if (unwrap) {
        html = `${before}${innerHtml}${after}`
        if ((component as any).$$remove) {
          component.remove();
        }
        cache.set(componentId, html)
      } else {
        html = `${before}<${tagName}${attributes ? ` ${attributes}` : ''}${mkReactiveHtml ? ' x-data x-rm' : ''}>${innerHtml}</${tagName}>${after}`
        if (mkReactiveHtml) {
          reactiveHtml = `${ifStart ?? ''}${reactiveForStart}<${tagName}${attributes ? ` ${attributes}` : ''}>${innerHtml}</${tagName}>${reactiveForEnd}${ifEnd ?? ''}`
        }
        if ((component as any).$$remove) {
          component.remove();
        }
      }
      let ret;
      if (reactiveForStart && reactiveForEnd) {
        ret = reactiveHtml + '\n' + html;
      } else {
        ret = html;
      }
      cache.set(componentId, ret);

      return ret;
    } else {
      // Not a real component
      // FIXME: understand why
      throw new Error('Why no tagName?')
    }
  } else {
    const html = toHtml()
    cache.set(componentId, html)
    return html
  }
}

function toPath(path: (string | undefined)[]) {
  return '/' + path
    .filter(p => !!p)
    .map(p => p?.replace(/(^\/|\/$)/g, ''))
    .join('/')
}

function transformPermalink(editor: DataSourceEditor, path: string, type: string, options: EleventyPluginOptions): string {
  // Do nothing if there is no data source, just a static site
  if (!enable11ty(editor)) return path

  switch (type) {
    case 'html':
      return toPath([
        path
      ])
    case 'asset':
      return toPath([
        options.urls?.assets,
        path.replace(/^\/?assets\//, ''),
      ])
    case 'css': {
      return toPath([
        options.urls?.css,
        path.replace(/^\.?\/?css\//, ''),
      ])
    }
    default:
      console.warn('Unknown file type in transform permalink:', type)
      return path
  }
}

function transformPath(editor: DataSourceEditor, path: string, type: string, options: EleventyPluginOptions): string {
  // Do nothing if there is no data source, just a static site
  if (!enable11ty(editor)) return path

  switch (type) {
    case 'html':
      return toPath([
        options.dir?.input,
        options.dir?.silex,
        options.dir?.html,
        path,
      ])
    case 'css':
      return toPath([
        options.dir?.input,
        options.dir?.silex,
        options.dir?.css,
        path.replace(/^\/?css\//, ''),
      ])
    case 'asset':
      return toPath([
        options.dir?.input,
        options.dir?.silex,
        options.dir?.assets,
        path.replace(/^\/?assets\//, ''),
      ])
    default:
      console.warn('Unknown file type in transform path:', type)
      return path
  }
}


const MUTATORS = ['set_state', 'coalesce_w_state']
function componentIsReactive(component: Component) {
  if (hasReactiveAttributes(component)) return true;
  const parent = component.parent();
  const parentReactive = parent && componentIsReactive(parent);
  if (parentReactive && component.get('tagName')) return true;
  const events = component.get('events');
  if (events && events.length) return true;
  const states = ((component.get('publicStates') || []) as StoredStateWithId[]).map(s => s.id)
  let reactive = false;
  // console.log("Component:", component);
  const checkReactive = (child: Component) => {
    if (reactive) return;
    const events: any[] = child.get('events');
    // console.log("events:", events);
    // console.log("child:", child);
    if (events && events.length) {
      for (const event of events) {
        if (!event.expression) continue;
        const expr: Token[] = JSON.parse(event.expression);
        // console.log("looking at event", event, "and expr:", expr);
        for (const token of expr) {
          if (token.type === 'property') {
            // console.log("looking property", token, "in", MUTATORS);
            if (
              MUTATORS.includes(token.fieldId) &&
              token?.options?.key && states.includes(token.options.key as any)
            ) {
              reactive = true;
              return;
            }
          }
        }
      }
    }
    child.forEachChild(checkReactive);
  };
  checkReactive(component);
  return reactive;
}

function getValue(value: any) {
  while (typeof value === 'string') {
    value = JSON.parse(value);
  }
  return value;
}

function getAlpineDataScript(component: Component): string {
  const publicStates: StoredStateWithId[] = (component.get('publicStates') || []);
  console.log("data script public states:", publicStates, component, component.tagName)
  const dataObj: ESTree.ObjectExpression = {
    type: "ObjectExpression",
    properties: (publicStates).map((s): ESTree.Property => {
      return {
        type: "Property",
        key: toLiteral(s.id),
        value: ensureFilteredData(toJsExpression(s.expression, withThis({ component, transformers: { baseFieldId: p => getFieldId(component, p) } })), s.expression as any),
        method: false,
        shorthand: false,
        kind: "init",
        computed: false
      }
    })
  }

  if (component.defaults.script) {
    // component.set('script', '');
    dataObj.properties.push({
      type: "Property",
      kind: "init",
      method: true,
      shorthand: false,
      computed: false,
      key: {
        type: "Identifier",
        name: "$$init"
      },
      value: {
        type: "FunctionExpression",
        params: [
          {
            type: "Identifier",
            name: "opts"
          }
        ],
        body: {
          type: "BlockStatement",

          body: [
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                optional: false,
                callee: {
                  type: "MemberExpression",
                  object: {
                    type: "Identifier",
                    name: '(' + component.defaults.script.toString() + ')',
                  },
                  property: {
                    type: "Identifier",
                    name: "call"
                  },
                  optional: false,
                  computed: false
                },
                arguments: [
                  {
                    type: "MemberExpression",
                    object: {
                      type: "Identifier",
                      name: "this"
                    },
                    property: {
                      type: "Identifier",
                      name: "$el"
                    },
                    computed: false,
                    optional: false
                  },
                  {
                    type: "Identifier",
                    name: "opts"
                  }
                ]
              }
            }
          ]
        }

      }
    })
  }
  if (!dataObj.properties.length) return '';
  const callExpr: ESTree.CallExpression = {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "Alpine"
      },
      property: {
        type: "Identifier",
        name: "data"
      },
      computed: false,
      optional: false
    },
    arguments: [
      {
        type: "Literal",
        value: sanitizeId(getOrCreatePersistantId(component))
      },
      {
        type: "FunctionExpression",
        params: [],
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: dataObj
            }
          ]
        }
      }
    ],
    optional: false
  }
  const ret = (genJs(callExpr));
  console.log('data script', ret);
  return ret;
}
function genJs(ast: ESTree.Expression, opts?: { minify: boolean }) {
  // console.log("input Js AST:", ast);
  opts ??= {
    minify: false
  };
  let js = AST.generate(ast);
  if (opts.minify) {
    js = js.replace(/[\n\r]/gi, '');
  }
  js = js.replace(/"/gi, "'");
  if (js.slice(-1) === ';') js = js.slice(0, -1);
  // console.log("output js:", js);
  return js;
}
function toLiteral(id: string): ESTree.Property["key"] {
  return {
    type: "Literal",
    value: id
  }
}
const CHAIN_FILTERS = (
  root: ((v: ESTree.Expression) => ESTree.Expression) | undefined, opts: ToJsExpressionOpts | undefined
): (
  (v: Token, c?: ESTree.Expression) => [ESTree.Expression, boolean]
) | undefined => (expr, currentJs): [ESTree.Expression, boolean] => {
  root ??= v => v;
  if (expr.type === 'filter') {
    return [{
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: ensureJs(currentJs),
        property: {
          type: "Identifier",
          name: "withFilter",
        },
        optional: true,
        computed: false,
      },
      arguments: [
        root!({
          type: "MemberExpression",
          object: {
            type: "Identifier",
            name: "$store",
          },
          property: {
            type: "MemberExpression",
            object: {
              type: "Identifier",
              name: "filters"
            },
            property: {
              type: "Literal",
              value: expr.id
            },
            computed: true,
            optional: true
          },
          optional: false,
          computed: false
        })!,
        FILTERS[expr.id] ?
          FILTERS[expr.id].getArguments(expr as Token, opts) :
          pojsoToAST(reifyProperties(expr.options, opts))
      ],
      optional: true,
    }, true]
  }
  return [currentJs!, false]
}

const STATE_SETTER = {
  getArguments(_expr: Token, opts?: ToJsExpressionOpts): ESTree.Expression {
    const expr: Property = _expr as any;
    if (!expr.options) throw new Error("Options required for set_state action")
    const options: any = expr.options;
    const { key, value } = options;
    const valueExpr: Expression = JSON.parse(value);
    // console.log("Value expr:", valueExpr);
    const root = opts?.transformers?.root || (v => v);

    return {
      type: "ObjectExpression",
      properties: [
        {
          type: "Property",
          key: {
            type: "Literal",
            value: "$data",
          },
          value: {
            type: "Identifier",
            name: "$data"
          },
          kind: "init",
          shorthand: true,
          computed: false,
          method: false
        },
        {
          type: "Property",
          key: {
            type: "Literal",
            value: "key"
          },
          value: {
            type: "Literal",
            value: key
          },
          kind: "init",
          shorthand: false,
          computed: false,
          method: false,
        },
        {
          type: "Property",
          key: {
            type: "Literal",
            value: "value"
          },
          value: toJsExpression(valueExpr, {
            ...opts,
            transformers: {
              ...opts?.transformers,
              chain: v => v,
              middleware: CHAIN_FILTERS(root, opts)
            }
          }),
          kind: "init",
          shorthand: false,
          computed: false,
          method: false,
        }
      ]
    }


  }
}
const ACTIONS: Record<string, typeof STATE_SETTER> = {
  "set_state": STATE_SETTER,
  "coalesce_w_state": STATE_SETTER
}
const FILTERS: typeof ACTIONS = {

}
type ToJsExpressionOpts = {
  component?: Component
  transformers?: {
    root?: (v: ESTree.Expression) => ESTree.Expression
    chain?: (v: ESTree.Expression) => ESTree.Expression,
    middleware?: (v: Token, c?: ESTree.Expression) => [ESTree.Expression, boolean],
    baseFieldId?: (v: Property) => string
  }
};
const VALUEOF_CHAINER: (v: ESTree.Expression) => ESTree.Expression = v => v;
// currentJs => currentJs.type === 'Literal' ?
//   currentJs :
//   ({
//     type: "CallExpression",
//     callee: {
//       type: "MemberExpression",
//       object: currentJs!,
//       property: {
//         type: "Identifier",
//         name: "valueOf"
//       },
//       optional: true,
//       computed: false,
//     },
//     arguments: [],
//     optional: true
//   })
const ensureJs = v => v || { type: "Identifier", name: "undefined" }

export function toJsExpression(expression?: Expression, opts?: ToJsExpressionOpts): ESTree.Expression {
  if (!expression || !expression.length) return { type: "Identifier", name: "null" }
  // console.log("Input expression:", expression);
  const first = expression[0];
  let lastChained;
  let { root, chain: _chain, middleware, baseFieldId: baseFieldId } = opts?.transformers! || {};
  root ??= v => v;
  _chain ??= VALUEOF_CHAINER;
  middleware ??= CHAIN_FILTERS(root, opts);
  baseFieldId ??= t => t.fieldId
  if (first.type === 'property' && first.dataSourceId === 'actions') {
    return {
      type: "CallExpression",
      optional: false,
      callee: {
        type: "MemberExpression",
        object: {
          type: "MemberExpression",
          object: {
            type: "Identifier",
            name: "$store"
          },
          property: {
            type: "Identifier",
            name: "actions"
          },
          optional: false,
          computed: false,
        },
        property: {
          type: "Identifier",
          name: "run_all",
        },
        optional: false,
        computed: false
      },
      arguments: (expression as Property[])
        .filter(e => Boolean(e.dataSourceId))
        .map((e): ESTree.CallExpression => ({
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            optional: false,
            object: {
              type: "Identifier",
              name: "$store"
            },
            property: {
              type: "MemberExpression",
              object: root({
                type: "Identifier",
                name: (e as any).dataSourceId
              }),
              property: {
                type: "Literal",
                value: e.fieldId
              },
              computed: true,
              optional: true
            },
          },
          arguments: [
            ACTIONS[e.fieldId].getArguments(e, opts)
          ],
          optional: true
        }))
        .map((e): ESTree.ArrowFunctionExpression => ({
          type: "ArrowFunctionExpression",
          expression: true,
          body: e,
          params: []
        }))
    }
  }
  let currentJs: ESTree.Expression | undefined;
  for (let i = 0; i < expression.length; i++) {
    const expr = expression[i];
    if (middleware) {
      const [ast, halt] = middleware(expr as Token, currentJs);
      if (ast) currentJs = ast;
      if (halt) continue;
    }
    switch (expr.type) {
      case 'property': {
        if (expr.dataSourceId) {

          if (!currentJs) {
            currentJs = {
              type: "MemberExpression",
              object: root({
                type: "Identifier",
                name: "$store"
              }),
              property: {
                type: "Literal",
                value: expr.dataSourceId
              },
              optional: true,
              computed: true,
            }

          }
          currentJs = {
            type: "MemberExpression",
            object: currentJs,
            property: {
              type: "Literal",
              value: i !== 0 ? expr.fieldId : baseFieldId(expr)
            },
            computed: true,
            optional: true,
          }
          chain();

          if (expr.options && Object.keys(expr.options).length) {
            currentJs = {
              type: "CallExpression",
              callee: currentJs,
              arguments: [{ type: "Literal", value: { $$empty: true } as any }],
              optional: true,
            }
          }
        } else {
          if (expr.fieldId === 'fixed') {
            if (!expr.options) throw new Error("Fixed value must have... well, a value");
            currentJs = {
              type: "Literal",
              value: expr.options.value as any
            }
          }
          else throw new Error("Non OpenAPI property access not allowed");
        }
        break;
      }
      case "state": {
        const stateId = (expr.componentId && expr.storedStateId === '__data') ?
          toJsVarName(getStateVariableName(expr.componentId || "", "__data")) :
          expr.storedStateId
        currentJs = {
          type: "MemberExpression",
          object: root({
            type: "Identifier",
            name: "$data"
          }),
          property: {
            type: "Literal",
            value: stateId
          },
          computed: true,
          optional: true
        }
        break;
      }
      case "filter": {
        currentJs = {
          type: "CallExpression",
          callee: root({
            type: "MemberExpression",
            object: {
              type: "Identifier",
              name: "$store",
            },
            property: {
              type: "MemberExpression",
              object: {
                type: "Identifier",
                name: "filters"
              },
              property: {
                type: "Literal",
                value: expr.id
              },
              computed: true,
              optional: true
            },
            optional: false,
            computed: false
          }),
          arguments: [
            ensureJs(currentJs),
            FILTERS[expr.id] ?
              FILTERS[expr.id].getArguments(expr as Token, opts) :
              pojsoToAST(reifyProperties(expr.options, opts))
          ],
          optional: true,
        }
        break;
      }
    }
    chain();

  }
  function chain() {
    if (lastChained === currentJs) return currentJs;
    lastChained = currentJs = _chain!(currentJs!)
  }
  // console.log("output JS AST:", currentJs);
  return ensureJs(currentJs);
}



const withThis = (opts: ToJsExpressionOpts): ToJsExpressionOpts => ({
  ...(opts || {}),
  transformers: {
    ...(opts?.transformers || {}),
    root(expr: ESTree.Expression): ESTree.Expression {
      return {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "this"
        },
        property: expr,
        optional: true,
        computed: false,
      }
    }
  }
})
function alpinify(
  component: Component,
  opts: {
    config?: ClientConfig,
    statesObj?: Record<Properties, RealState>;
    tagName?: string; dataTree?: DataTree;
    statesPrivate?: { stateId: StateId; label: string; tokens: State[]; }[];
    statesPublic?: {
      stateId: StateId; label: string; tokens: State[];

    }[];
    originalAttributes?: Record<string, string>;
  }) {
  if (!opts.statesObj || !opts.statesPrivate || !opts.statesPublic) {
    if (!opts.config) throw new Error("Config or states required.");
    const states = getStatesObj(opts.config, component);
    Object.assign(opts, states);
  }
  if (!opts.originalAttributes) {
    opts.originalAttributes = component.get('attributes') as Record<string, string>

  }
  component.forEachChild(child => child && alpinify(child, { ...opts, statesObj: undefined, statesPrivate: undefined, statesPublic: undefined, originalAttributes: undefined }));
  const events: (Backbone.Model<{}> | {
    id: string,
    name: string,
    expression: string,
    modifiers: {
      id: string,
      name: string
    }[]
  })[] = component.get('events');
  const hasData = component.get('publicStates')?.length;
  const fieldId = (prop: Property) => getFieldId(component, prop);
  console.log("alpinify:", opts);
  const boundAttributes = getBoundAttributes(component, opts);
  const attrs: any = {
    ...opts.originalAttributes,
    ...(boundAttributes),
    'x-data': !hasData ? true : sanitizeId(getOrCreatePersistantId(component)),
    'x-html': maybeAwaitJs(genJs(
      ensureFilteredData(
        toJsExpression(
          opts?.statesObj?.innerHTML?.tokens,
          {
            component,
            transformers: {
              middleware: CHAIN_FILTERS(undefined, { component }),
              baseFieldId: fieldId,
            }
          }
        ), opts?.statesObj?.innerHTML?.tokens!), { minify: true })),
    ...(Object.fromEntries(
      (events || [])
        .map((e: any) => e.toJSON instanceof Function ? e.toJSON() : e)
        .filter(e => e.expression)
        .map(e => {
          // console.log("Event:", e);
          return ([
            'x-on:' + [e.name, ...(e.modifiers ? e.modifiers.map(m => m.name) : [])].join('.'),
            genJs(toJsExpression(JSON.parse(e.expression), { component, transformers: { baseFieldId: fieldId } }), { minify: true })
          ])
        })
    )),
  };
  if (!attrs['x-html'] || attrs['x-html'] === 'null') {
    delete attrs['x-html']
  }
  if (hasReactiveProps(component) || component.defaults.script) {
    if (typeof attrs['x-data'] !== 'string' || attrs['x-data'].length === 0) attrs['x-data'] = sanitizeId(getOrCreatePersistantId(component));
    attrs["x-init"] = `$$init(${getInitializerOpts(component).replace(/"/gi, "'")})`;
  }
  component.removeAttributes(Object.keys(component.getAttributes()));
  component.addAttributes(attrs);
  return component;
}

function toJsCondition(component: Component, condition: { expression: Token[]; expression2?: Token[]; operator: UnariOperator | BinariOperator; }): ESTree.Expression {
  const exprs = [condition.expression, condition.expression2].filter(Boolean).map(e => toJsExpression(e!, { transformers: { baseFieldId: p => getFieldId(component, p) } }));
  switch (condition.operator) {
    case UnariOperator.NOT_EMPTY_ARR:
    case UnariOperator.EMPTY_ARR:
      const lengthExpr: ESTree.MemberExpression = {
        type: "MemberExpression",
        object: exprs[0],
        property: {
          type: "Literal",
          value: "length"
        },
        computed: false,
        optional: true,
      };
      return condition.operator === UnariOperator.NOT_EMPTY_ARR ?
        lengthExpr :
        {
          type: "UnaryExpression",
          prefix: true,
          operator: "!",
          argument: lengthExpr
        }
    case UnariOperator.FALSY:
      return {
        type: "UnaryExpression",
        prefix: true,
        operator: "!",
        argument: exprs[0]
      }
    case UnariOperator.TRUTHY:
      return exprs[0];
    default:
      return {
        type: "BinaryExpression",
        operator: condition.operator,
        left: exprs[0],
        right: exprs[1]
      }
  }
}

function toJsVarName(arg0: string): string {
  return arg0.replace(/-/gi, '$');
}

function sanitizeId(arg0: string): string {
  return arg0.replace(/-/gi, '_');
}

function getBoundAttributes(component: Component, opts: Parameters<typeof alpinify>["1"]) {
  return Object.fromEntries(
    opts
      .statesPrivate!
      .filter(({ label }) => isAttribute(label))
      .map(
        s => {
          const expr = genJs(ensureFilteredData(
            toJsExpression(
              s.tokens,
              {
                component,
                transformers: {
                  middleware: CHAIN_FILTERS(undefined, { component }),
                  baseFieldId: t => getFieldId(component, t)
                }
              }
            ), s.tokens), { minify: true });
          return [
            (s.label.indexOf('x-') === 0 ? '' : ':') + s.label,
            s.label === 'x-model' ? expr : maybeAwaitJs(expr)
          ]
        })
  )
}





function pojsoToAST(options: Options): ESTree.ObjectExpression {
  return/*  (({ type: "Literal", value: options as any } as ESTree.Literal) as any) || */ {
    type: "ObjectExpression",
    properties: Object.entries(options).map((e: any[]): ESTree.Property => ({
      type: "Property",
      key: {
        type: "Literal",
        value: e[0]
      },
      value: e[1].type ? e[1] as ESTree.Expression : {
        type: "Literal",
        value: e[1] as any
      },
      shorthand: false,
      kind: "init",
      computed: false,
      method: false
    }))
  }
}

function reifyProperties(options: any, genOpts: ToJsExpressionOpts | undefined): Options {
  let entries =
    (parseEntries(options) as any)
      // .filter((e: [string, Expression]) => !isFixed(e[1][0] as any) &&  !isState(e[1][0] as any) &&  !isHttp(e[1][0] as any))
  if (!entries.length) {
    return {
      $$empty: true
    }
  }
  return Object.fromEntries(entries.map(e => [e[0], toJsExpression(e[1], genOpts)]))
}



function ensureFilteredData(arg0: ESTree.Expression, tokens: Token[], forceEnsure: boolean = false): ESTree.Expression {
  if (!tokens || !tokens.length) return arg0;
  let ensure = forceEnsure || tokens?.[0]?.type === 'property' && Boolean(tokens[0].dataSourceId);
  // ensure = ensure || tokens?.[0]?.type === 'state';
  const filtered = tokens.find(t => t.type === 'filter');

  if (ensure) {
    arg0 = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: arg0,
        property: {
          type: "Identifier",
          name: "$ENSURE"
        },
        optional: true,
        computed: false
      },
      arguments: [],
      optional: true
    }
  }
  if (filtered) {
    arg0 = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: arg0,
        property: {
          type: "Identifier",
          name: "filtered"
        },
        optional: true,
        computed: false
      },
      optional: true,
      arguments: []
    }
  }
  return arg0;
}


const ints = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(String);
const primitiveLiterals = ['true', 'false', 'null', 'undefined', '{', '[']
function maybeAwaitJs(arg0: string) {
  arg0 = arg0.trimStart();
  if (ints.includes(arg0.charAt(0)) || primitiveLiterals.findIndex(l => arg0.indexOf(l) === 0) !== -1) {
    return arg0;
  }
  return "await " + arg0;

}

function getAlpineStoreScript(component: Component, config: ClientConfig): string {
  const exprs: (Token & { index: number })[] = getAllExpressions(component);
  // console.log("all expressions:", exprs);
  const dsRefs: Property[] = exprs.filter((expr) => isDataSourceField(expr as any) && expr?.type === 'property' && expr?.dataSourceId) as any[];
  const fieldId = p => getFieldId(component, p);
  // console.log("Data source refs...", dsRefs);
  const dsRefsGrouped = dsRefs
    .filter(dsRef => {
      const doc = getOpenApiDoc(dsRef, config);
      return Boolean(doc.fieldMappings[dsRef.fieldId])
    })
    .reduce((obj, ref) => {
      obj[ref.dataSourceId!] ??= [] as any;
      const refFieldId = getFieldId(component, ref);
      if (!obj[ref.dataSourceId!].find(r => r.variant === refFieldId)) {
        obj[ref.dataSourceId!].push({ ...ref, variant: refFieldId });
      }
      return obj;
    }, {} as Record<string, (Property & { variant: string })[]>)
  let js = '';
  Object.entries(dsRefsGrouped).forEach(([dataSourceId, dsRefs]) => {
    const dataObj: ESTree.ObjectExpression = {
      type: "ObjectExpression",
      properties: dsRefs.map(dsRef => {
        return ({
          type: "Property",
          key: {
            type: "Literal",
            value: dsRef.variant
          },
          value: {
            type: "CallExpression",
            callee: {
              type: "Identifier",
              name: "reloadable"
            },
            arguments: [
              {
                type: "MemberExpression",
                object: {
                  type: "MemberExpression",
                  object: {
                    type: "Identifier",
                    name: "$pagedata"
                  },
                  property: {
                    type: "Literal",
                    value: dsRef.dataSourceId!
                  },
                  computed: true,
                  optional: true,
                },
                property: {
                  type: "Literal",
                  value: dsRef.variant
                },
                computed: true,
                optional: true
              },
              {
                type: "ArrowFunctionExpression",
                params: [
                  {
                    type: "Identifier",
                    name: "opts"
                  }
                ],
                expression: true,
                body: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    object: {
                      type: "Identifier",
                      name: "this"
                    },
                    optional: true,
                    computed: false,
                    property: {
                      type: "MemberExpression",
                      object: {
                        type: "Identifier",
                        name: "$store"
                      },
                      property: {
                        type: "Identifier",
                        name: "fetch"
                      },
                      optional: false,
                      computed: false
                    }
                  },
                  arguments: [
                    {
                      type: "Identifier",
                      name: "opts"
                    },
                    {
                      type: "ObjectExpression",
                      properties: [
                        {
                          type: "Property",
                          key: {
                            type: "Literal",
                            value: "method"
                          },
                          value: {
                            type: "Literal",
                            value: getHttpMethod(dsRef as Property, config)
                          },
                          kind: "init",
                          method: false,
                          shorthand: false,
                          computed: false
                        }
                      ]
                    }
                  ],
                  optional: false,
                }
              }
            ],
            optional: false,
          },
          kind: "init",
          computed: false,
          shorthand: false,
          method: false
        } as unknown as ESTree.ObjectExpression['properties']["0"])
      }),
    };
    const storeStmt: ESTree.CallExpression = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "Alpine"
        },
        property: {
          type: "Identifier",
          name: "store"
        },
        optional: false,
        computed: false
      },
      arguments: [
        {
          type: "Literal",
          value: dataSourceId!
        },
        dataObj
      ],
      optional: false
    }
    js += genJs(storeStmt) + ';\n'
  });
  return js;
}
function onAlpineInit(js: string) {
  return `document.addEventListener('alpine:init', () => {\n${js}\n})`;
}
function getExpr(e) {
  return typeof e.get === 'function' ? (e.get('expression') || e.expression) : e.expression;
}
function getAllExpressions(component: Component): (Token & { index: number })[] {
  const childExprs = [] as any;
  component.forEachChild(component => {
    childExprs.push(...getAllExpressions(component));
  })

  const events = component.get('events') || [];
  // console.log("Events:", events);
  const eventExpressions = events
    ?.flatMap?.(
      e => getExpr(e) ?
        JSON.parse(getExpr(e))
          ?.flatMap(
            e => Object.values(e.options)
              .map((v: any) => tryParse('' + v))
              .filter(v => v instanceof Array)
              .flatMap(v => v)
              ?.map?.((v, i) => ({ ...v, index: i })
              )) : []);
  const props = component.get('props') || [];
  const propsExpressions = props.map(p => JSON.parse(getExpr(p)))
  // console.log("event expressions:", eventExpressions);
  const exprs = ((component.get('publicStates') || [])
    ?.flatMap?.(e => getExpr(e)?.map?.((v, i) => ({ ...v, index: i }))))
    .concat(
      ((component.get('privateStates') || [])
        ?.flatMap?.(e => getExpr(e)?.map?.((v, i) => ({ ...v, index: i }))))
    )
    /**
     * @todo fuck me make this recursive...
     */
    .concat(
      eventExpressions
    )
    .concat(
      propsExpressions
    )

  const ret = exprs.concat(childExprs)
  // console.log("exprs:", ret);
  return ret;



}

function isDataSource(dataSourceId: import("@silexlabs/grapesjs-data-source").DataSourceId): unknown {
  return String(dataSourceId).indexOf('ds-') === 0
}

function getHttpMethod(dsRef: Property, config: ClientConfig): string {
  const doc = getOpenApiDoc(dsRef, config);
  // console.log("doc:", doc);
  const mappings = doc?.fieldMappings;
  // console.log('mappings:', mappings);
  const mapping = mappings?.[dsRef.fieldId];
  // console.log('mapping:', mapping);
  const method = mapping?.method;
  // console.log('method', method);
  return method;
  /**
   * @todo handle openapi field mappings....
   */
  // if (!src.fieldMappings) {
  //   src.fieldMappings = Object.fromEntries(Object.entries(src.get('doc').path).map( => [snakecase(v), {
  //     path: v,
  //     method: 
  //   }]));
  // }
  // return dsRef.fieldId.split(' ').shift()!;
}
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'QUERY']
function isDataSourceField(expr: Property & { index: number; }) {
  if (!expr.dataSourceId || !isDataSource(expr.dataSourceId)) return;
  if (!expr.fieldId) return;
  // const ret = METHODS.includes(expr.fieldId.split(' ')[0])
  console.log("data source?", expr, expr.fieldId);
  return true;
}

function getBoilerplateScript(component: Component, config: ClientConfig): string {

  const actions =
    `Alpine.store('actions', {
    ${Object.entries(ACTIONS_JS).map(e => `
      "${e[0]}": ${e[1].toString().trim()}`)}
  })`
  const filterFns = getFilters(null as any);
  // console.log("filter fns:", filterFns.map(f => [f.id, f.apply.toString().trim()]))
  const filters =
    `Alpine.store('filters', {
      ${filterFns.map(fn =>
      `
        "${fn.id}": ${fn.apply.toString().trim()}`
    )}
    })`
  const dataStores = getAlpineStoreScript(component, config);
  const dataMethods = getAlpineDataScripts(component, config);
  const scripts = [STORE_JS, actions, filters, dataStores, dataMethods];
  const ret = scripts.join('\n');
  console.log("boilerplate", ret);
  console.log("boilerplates", scripts);
  return onAlpineInit(ret);
}

function getOpenApiDoc(dsRef: Property, config: ClientConfig) {
  const editor: DataSourceEditor = config.getEditor() as any;
  const mgr = editor.DataSourceManager;
  const src: any = mgr.get(dsRef.dataSourceId!);
  const doc = src.get('doc');
  return doc;
}
function getStatesObj(config: ClientConfig, component: Component) {
  const editor = config.getEditor() as unknown as DataSourceEditor

  const dataTree = editor.DataSourceManager.getDataTree()
  const componentId = sanitizeId(getOrCreatePersistantId(component));
  const statesPrivate = withNotification(() => getRealStates(dataTree, getStateIds(component, false)
    .map(stateId => ({
      stateId,
      state: getState(component, stateId, false)!,
    }))), editor, componentId)

  const statesPublic = withNotification(() => getRealStates(dataTree, getStateIds(component, true)
    .map(stateId => ({
      stateId,
      state: getState(component, stateId, true)!,
    }))), editor, componentId)
  const statesObj = statesPrivate
    // Filter out attributes, keep only properties
    .filter(({ label }) => !isAttribute(label))
    // Add states
    .concat(statesPublic)
    .reduce((final, { stateId, label, tokens }) => ({
      ...final,
      [stateId]: {
        stateId,
        label,
        tokens,
      },
    }), {} as Record<Properties, RealState>)
  return { statesObj, statesPrivate, statesPublic };
}

function getAlpineDataScripts(component: Component, config?: ClientConfig) {
  let script = '';
  function recurse(component: Component) {
    component.forEachChild(recurse);
    const reactive = componentIsReactive(component);
    if (reactive) {
      const dataScript = getAlpineDataScript(component);
      if (!dataScript) return;
      script += '\n' + dataScript
    }
  }
  recurse(component);
  console.log("data scripts...", script);
  return script;
}
function getInitializerOpts(component: Component) {
  if (!component.defaults.script || !component.defaults['script-props']) return '';
  const reactiveProps = getReactiveProps(component);
  if (reactiveProps) {
    const staticProps = getStaticProps(component);
    const expr: ESTree.ObjectExpression = {
      type: "ObjectExpression",
      properties: [{
        type: "SpreadElement",
        argument: {
          type: "Literal",
          value: staticProps as any
        }
      }].concat(reactiveProps as any) as ESTree.ObjectExpression["properties"]
    }
    const opts = AST.generate(expr);
    return opts;
  }
  return '';
}
// function getInitializerStore(component: Component, config: ClientConfig) {
//   let script = '';
//   function recurse(component: Component) {
//     component.forEachChild(recurse);
//     if (!component.defaults.script || !component.defaults['script-props']) return;
//     const reactiveProps = hasReactiveProps(component);
//     if (reactiveProps) {

//     }
//   }
//   recurse(component);
// }

function getReactiveProps(component: Component): ESTree.ObjectExpression["properties"] {
  const _props: Array<Backbone.Model<{ id: string, name: string, expression: string }>> = component.get('props');
  return _props.map(p => {
    const expr = JSON.parse(getExpr(p)) as Expression;
    return {
      type: "Property",
      kind: "init",
      method: false,
      computed: false,
      shorthand: false,
      key: {
        type: "Identifier",
        name: (p as any).name || p.get('name')!,
      },
      value: {
        type: "AwaitExpression",
        argument: ensureFilteredData(toJsExpression(expr, { transformers: { baseFieldId: p => getFieldId(component, p) } }), expr as any)
      }
    }
  })
}

function getStaticProps(component: Component) {
  const scriptProps = component.defaults["script-props"];
  const r = {};
  for (const prop of scriptProps) {
    r[prop] = component.get(prop);
  }
  return r;
}

function hasReactiveProps(component: Component): boolean {
  return component.get('props')?.find?.(p => getExpr(p) && getExpr(p) !== '[]');
}
function hasReactiveAttributes(component: Component): boolean {
  return component.get('privateStates')?.find?.(s => s?.label?.indexOf?.('x-') === 0);
}

function hasAlpineData(component: Component): boolean {
  return component.defaults.script || component.get('publicStates')?.length;
}
//function transformFile(file: ClientSideFile/*, options: EleventyPluginOptions*/): ClientSideFile {
//  //const fileWithContent = file as ClientSideFileWithContent
//  switch (file.type) {
//  case 'html':
//  case 'css':
//  case 'asset':
//    return file
//  default:
//    console.warn('Unknown file type in transform file:', file.type)
//    return file
//  }
//}
