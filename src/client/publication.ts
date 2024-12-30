import * as meriyah from 'meriyah';
import dedent from 'dedent'
import STORE_JS from './store.source.js';
import { Component, Page } from 'grapesjs'
import getFilters from '@silexlabs/grapesjs-data-source/src/filters/liquid'
import { minify_sync } from 'terser'
import { BinariOperator, DataSourceEditor, DataTree, Expression, Filter, IDataSourceModel, NOTIFICATION_GROUP, Options, Properties, Property, PropertyOptions, State, StateId, StoredFilter, StoredProperty, StoredState, StoredStateWithId, StoredToken, Token, UnariOperator, fromStored, getOrCreatePersistantId, getPersistantId, getState, getStateIds, getStateVariableName, toExpression } from '@silexlabs/grapesjs-data-source'
import * as ESTree from 'estree';
import * as AST from 'astring';
import { assignBlock, echoBlock, echoBlock1line, getFieldId, getPaginationData, getSubstitutionOptions, ifBlock, loopBlock } from './liquid'
import { EleventyPluginOptions, Silex11tyPluginWebsiteSettings } from '../client'
import { PublicationTransformer } from '@silexlabs/silex/src/ts/client/publication-transformers'
import { ClientConfig } from '@silexlabs/silex/src/ts/client/config'
import { REACTIVE_ID, UNWRAP_ID } from './traits'
import { EleventyDataSourceId } from './DataSource'
import { ACTIONS_JS } from './actions';
import { isFixed, isHttp, isState, parseEntries, replaceAstExpressions, replaceObjectExpressions, tryParse } from './utils.js';
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
  // console.log("Rendering", component, component.tagName);
  // if (!cache.has('$reactiveStates')) {
  //   const wrapper = config.getEditor().getWrapper();
  //   if (!wrapper) throw new Error("why no wrapper???");
  //   componentIsReactive(wrapper as any);
  //   wrapper.forEachChild(c => c && componentIsReactive(c as any));

  // }
  if (cache.has(componentId)) {
    return cache.get(componentId)
  }
  const attributes = component.getAttributes();
  if (attributes["id"] === 'pagedata' && attributes.type === 'application/json') {
    return '<script type="application/json" id="pagedata">{{ pagedata | json }}</script>'
  }
  let alpineScripts: string[] = [];
  const editor = config.getEditor() as unknown as DataSourceEditor

  const dataTree = editor.DataSourceManager.getDataTree()
  const states = getStatesObj(config, component);
  const { statesObj, statesPrivate, statesPublic } = states;
  const editable = component.get('isEditable');
  const cid = component.get('contentId');
  const reactive = !editable && component.get(REACTIVE_ID); //componentIsReactive(component);
  let isWrapper = false;
  // console.log("Component:", component, "is reactive?", reactive);
  const unwrap = component.get(UNWRAP_ID)
  if (component.get('type') === 'wrapper') {
    isWrapper = true;
    // alpineScripts.unshift();
    // component.addAttributes({ "x-data": true });
    // const existingScript = editor.Components.getById('pagedata');
    // if (!existingScript) {


    //   const [pagedata] = editor.addComponents({
    //     type: "text",
    //     tagName: "script",
    //     attributes: {
    //       type: "application/json",
    //       id: "pagedata"
    //     },
    //     content: "{% pagedata | json %}"
    //   });
    //   pagedata.move(component, { at: 0 });
    //   // component.save();
    //   pagedata.setId("pagedata");
    // }

  }

  if (editable || isWrapper || statesPrivate.length > 0 || statesPublic.length > 0 || unwrap || reactive) {
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
      let beforeBegin, afterBegin, beforeEnd, afterEnd;
      let [ifStart, ifEnd] = hasCondition ? ifBlock(component, condition!) : []
      let reactiveForStart, reactiveForEnd;
      let alpineAttributes;
      let originalAttributes = component.get('attributes') as Record<string, string>
      originalAttributes.class = component.getClasses().join(' ')

      const [forStart, forEnd] = hasData ? loopBlock(dataTree, component, statesObj.__data.tokens) : []
      // console.log("For start/end sh", { forStart, forEnd, component, tagName: component.tagName, reactive })
      const states = statesPublic
        .map(({ stateId, tokens }) => assignBlock(stateId, component, tokens))
        .join('\n')

      const attributeStates = statesPrivate
        // Filter out properties, keep only attributes
        .filter(({ label }) => isAttribute(label) && !label.startsWith('x-'))
        // Make tokens a string
        .map(({ stateId, tokens, label }) => ({
          stateId,
          label,
          value: echoBlock(component, tokens),
        }));
      if (reactive) {

        const fieldId = p => getFieldId(component, p)
        // const parent = component.parent();
        // if (parent && !parent.getAttributes?.()?.['x-data']) {
        //   parent.setAttributes({
        //     'x-data': true
        //   })
        // }
        // component.unset('script');
        // script += '\n' + getAlpineDataScript(component)
        const [dataScript, hasDataScript] = getAlpineDataScript(component, config);
        const [bindScript, hasBindScript] = getAlpineBindScript(component, { config, statesObj, tagName, dataTree, statesPrivate, statesPublic, originalAttributes });
        if (dataScript) {
          alpineScripts.push(dataScript);
        }
        if (hasDataScript) {

          alpineAttributes ??= '';
          alpineAttributes += ` x-data="data_${sanitizeId(getDataId(component))}" `;
        }
        if (bindScript) {
          alpineScripts.push(bindScript);
        }
        if (hasBindScript) {

          alpineAttributes ??= '';
          alpineAttributes += ` x-bind="bind_${sanitizeId(getDataId(component))}" `;
          if (!hasDataScript) alpineAttributes += ' x-data '
        }
        const xmodelAtt = statesPrivate.find(s => s.label === 'x-model');
        if (xmodelAtt) {
          alpineAttributes ??= '';
          alpineAttributes += ` x-model="{{ "${genJs(toJsExpression(xmodelAtt.tokens, { component, optionalMembers: false }), { minify: true })}" | escape }}" `
        }
        // component.set('script', script);
        // component.save({
        //   script: script
        // })
        if (hasCondition) {
          if ([condition?.expression, condition?.expression2].some(expression => expression?.[0] && !isHttp(expression[0] as any))) {

            ifStart = `<template x-data="${!dataScript ? '' : 'data_' + sanitizeId(getDataId(component))}" x-if="` + genJs(toJsCondition(component, condition!), { minify: true }) + `">`;
            ifEnd = '</template>';
          }
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
          const keyExpr = statesPrivate.find(s => s.label === 'key');
          const key = !keyExpr ? '' : ` :key="${gen(keyExpr.tokens, { rawStates: true })}"`
          reactiveForStart = `<template${key} x-data="${!hasAlpineData(component) ? '' : 'data_' + sanitizeId(getDataId(component))}" x-for="` + `${stateVarName} in ${maybeAwaitJs(gen(statesObj.__data.tokens))}` + '">'
          reactiveForEnd = '</template>';
          function gen(expr, opts?) {
            opts ??= {};
            return genJs(ensureFilteredData(toJsExpression(expr, { ...opts, component, liquidFilters: ['escape'], transformers: { ...(opts?.transformers || {}), baseFieldId: fieldId } }), statesObj.__data.tokens), { minify: true })
          }
          // console.log("set reactive for start/end", { reactiveForStart, reactiveForEnd, component });
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
        // alpineAttributes = alpinify(component, { config, statesObj, tagName, dataTree, statesPrivate, statesPublic, originalAttributes });
        // innerHtml = hasInnerHtml ? innerHtml : component.getInnerHTML()
        // console.log("script for", tagName, ":", component.get('script'))
        // console.log("component" + tagName + ":", component)
      }
      let alpineScript = '';
      if (alpineScripts.length) {
        let fullScript = '';
        for (const alpineScript of alpineScripts) {
          fullScript += alpineScript + '\n';
        }
        alpineScript = `{% if flags.render-${getDataId(component)} %}\n${fullScript}\n{% endif %}`;

      }
      let before = (states ?? '') + (forStart ?? '') + (ifStart ?? '')

      let after = (ifEnd ?? '') + (forEnd ?? '')
      if (alpineScript) {
        // if (scriptTop) before += alpineScript + '\n';
        after = `{{ "render-${getDataId(component)}" | set_flag }}` + after;
        // else after = alpineScript + '\n' + after;
        const cachedScripts = cache.get('$alpine-scripts') || {};
        if (!component.frame) throw new Error("Why no frame?");
        cachedScripts[component.frame.getComponent().get('id-plugin-data-source')] ??= '';
        cachedScripts[component.frame.getComponent().get('id-plugin-data-source')] = cachedScripts[component.frame.getComponent().get('id-plugin-data-source')] + '\n' + alpineScript;
        cache.set('$alpine-scripts', cachedScripts);
      }
      // console.log('for stuff or w/e', { forStart, forEnd, reactiveForStart, reactiveForEnd, component });
      // Attributes
      // Add css classes
      // Make the list of attributes
      const atts = { ...(component.get('attributes') as Record<string, any>) };
      if (tagName === 'form') {
        if (atts.action && atts.action.indexOf('://') === -1) {


          if (!attributeStates.find(a => a.label === 'action')) {
            // atts[':action'] ??= `$store.with_csrf("{{\"${atts.action}\" | access }}")`
            // atts.action = `{{ "${atts.action}" | with_csrf }}`
            afterBegin ??= '';
            afterBegin += '\n<input hidden type="text" name="__csrf" value="{{ csrf.id }}" :value="$store.csrf()" />\n'
            // alpineAttributes ??= '';
            // if (!alpineAttributes.indexOf('x-data')) alpineAttributes += ' x-data ';

          }
          // atts['x-data'] ??= true;
        }
      }
      before += beforeBegin ?? '';
      innerHtml = (afterBegin ?? '') + innerHtml;
      innerHtml += beforeEnd ?? '';
      after = (afterEnd ?? '') + after;
      atts.class = component.getClasses().join(' ')
      const attributes = buildAttributes(atts, attributeStates)
      const mkReactiveHtml = reactiveForStart && reactiveForEnd;
      // component.setAttributes(originalAttributes);
      let html = '', reactiveHtml = '';;
      if (editable && cid) {
        const cvar = `content_${toSafeVarName(cid)}`
        const h = i => `${before}<${tagName}${attributes ? ` ${attributes}` : ''}>${i}</${tagName}>${after}`
        const c = [
          `     {% if ${cvar}.content %}`,
          h(`{{ ${cvar}.content }}`),
          `      {% else %}`,
          h(`${innerHtml}`),
          `      {% endif %}`,
        ]
        html = [
          `{% assign ${cvar} = "${cid}" | load_content %}`,

          `{% if req.editor %}`,
          ` <div style="position:relative;">`,
          `  <div style="width:100%;display:flex;justify-content:end">`,
          `   <a href="{{ ${cvar}.url }}" target="_blank">Edit</a></div>`,
          ...c,
          `  </div>`,
          `{% else %}`,
          ...c,
          `{% endif %}`,


        ].join('\n')
      }
      else {

        if (unwrap) {
          html = `${before}${innerHtml}${after}`
          if ((component as any).$$remove) {
            component.remove();
          }
          cache.set(componentId, html)
        } else {
          html = `${before}<${tagName}${attributes ? ` ${attributes}` : ''}${alpineAttributes ? alpineAttributes : ''}${mkReactiveHtml ? ' x-data x-rm' : ''}>${innerHtml}</${tagName}>${after}`
          if (mkReactiveHtml) {
            reactiveHtml = `${ifStart ?? ''}${reactiveForStart}<${tagName}${attributes ? ` ${attributes}` : ''}${alpineAttributes ? alpineAttributes : ''}>${innerHtml}</${tagName}>${reactiveForEnd}${ifEnd ?? ''}`
          }
          if ((component as any).$$remove) {
            component.remove();
          }
        }
      }
      let ret;
      if (reactiveForStart && reactiveForEnd) {
        ret = html + "\n" + reactiveHtml;
      } else {
        ret = html;
      }
      if (isWrapper) {
        console.log('alpine scripts atm:', cache.get('$alpine-scripts'));
        const script = cache.get('$alpine-scripts')?.[component.get('id-plugin-data-source')];
        if (script)
          ret += "\n<script>\n" +
            onAlpineInit([
              getBoilerplateScript(component, config),
              script
            ].join('\n')) +
            '\n</script>\n'
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


const MUTATORS = [
  'increment',
  'decrement',
  'toggle',
  'flag',
  'unflag',
  'set',
  'coalesce_w',
  'append_to',
  'prepend_to',
  'add_to',
  'subtract_from',
  'multiply',
  'divide'
]
  .map(k => [k, 'state'].join('_'));
function componentIsReactive(component: Component) {
  if (hasReactiveAttributes(component)) return true;
  const parent = component.parent();
  // const parentReactive = parent && componentIsReactive(parent);
  // if (parentReactive && component.get('tagName')) return true;
  const events = component.get('events');
  if (events && events.length) return true;
  const states = ((component.get('publicStates') || []) as StoredStateWithId[]).map(s => s.id)
  let reactive = false;
  // console.log("Component:", component);
  const checkReactive = (child: Component) => {
    if (reactive) return;
    const events: any[] = child.get('events');
    // console.log("events:", events);
    const reactiveStates = cache.get('$reactiveStates') || new Set();
    // console.log("child:", child);
    if (events && events.length) {
      for (const event of events) {
        if (!event.expression) continue;
        const expr: Token[] = JSON.parse(event.expression);
        // console.log("looking at event", event, "and expr:", expr);
        const exploded = explode(expr);
        for (const token of exploded) {
          if (token.type === 'property') {
            // console.log("looking property", token, "in", MUTATORS);
            if (
              MUTATORS.includes(token.fieldId) &&
              token?.options?.key && states.includes(token.options.key as any)
            ) {
              reactive = true;
              reactiveStates.add(token.options.key)
            }
          }
        }
      }
    }

    if (!reactive) {
      const privateStates = child.get('privateStates');
      if (privateStates) {

        const conditionState = privateStates.find(s => s.id === 'condition');
        const controlFlowExpressions: any[] = [];
        if (conditionState) {
          controlFlowExpressions.push(...conditionState.expression.concat(conditionState.expression2))
        }
        const loopState = privateStates.find(s => s.id === '__data')
        if (loopState) {
          controlFlowExpressions.push(loopState.expression)
        }
        if (controlFlowExpressions) {
          reactive = reactive || controlFlowExpressions.filter(Boolean).find(s => reactiveStates.has(s.storedStateId))
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

function getAlpineDataScript(component: Component, config: ClientConfig): [string, boolean] {
  const key = 'data_' + sanitizeId(getDataId(component));
  if (cache.has(key)) return ['', cache.get(key)];
  const publicStates: StoredStateWithId[] = (component.get('publicStates') || []);
  // console.log("data script public states:", publicStates, component, component.tagName)
  const dataObj: ESTree.ObjectExpression = {
    type: "ObjectExpression",
    properties: (publicStates).map((s): ESTree.Property => {
      const ret: ESTree.Property = {
        type: "Property",
        key: toLiteral(s.id),
        value: ensureFilteredData(toJsExpression(s.expression, withThis({ component, transformers: { baseFieldId: p => getFieldId(component, p) } })), s.expression as any),
        method: false,
        shorthand: false,
        kind: "init",
        computed: false
      };
      if (s.computed) {
        ret.kind = "get";
        ret.method = true;
        ret.value = {
          type: "FunctionExpression",
          params: [],
          body: {
            type: "BlockStatement",
            body: [
              {
                type: "ReturnStatement",
                argument: ret.value as unknown as ESTree.ReturnStatement['argument']
              }
            ]
          }
        }
      }
      return ret;
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
                type: "AssignmentExpression",
                left: identifier(["opts", "$self"]),
                right: identifier("this"),
                operator: "="
              }
            },
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
                  identifier("opts")
                ]
              }
            }
          ]
        }

      }
    })
  }
  if (!dataObj.properties.length) return ['', (cache.set(key, false), false)];
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
        value: key
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
  const ret = `${[/* getAlpineStoreScript(component, config), */ genJs(callExpr),].join('\n')}`
  // console.log('data script', ret);
  cache.set(key, true);
  return [ret, true];
}
function genJs(ast: ESTree.Node, opts?: { minify: boolean }) {
  // console.log("input Js AST:", ast);
  opts ??= {
    minify: false
  };
  let js = AST.generate(ast);
  if (opts.minify) {
    js = js.replace(/[\n\r]/gi, '');
    js = js.replace(/"/gi, "'");
  }
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
  root ??= opts?.transformers?.root || (v => v);
  if (expr.type === 'filter') {
    return [{
      type: "CallExpression",
      callee: root!({
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
      arguments: [
        ensureJs(currentJs),
        FILTERS[expr.id] ?
          FILTERS[expr.id].getArguments(expr as Filter, opts) :
          pojsoToAST(reifyProperties(expr.options, opts))
      ],
      optional: true,
    }, true]
  }
  return [currentJs!, false]
}
function identifier(path, opts?: { computed?: boolean, optional?: boolean }): ESTree.Identifier {
  if (!(path instanceof Array)) path = [path];
  opts ??= {};
  /**
   * @type {import('estree').Identifier|import('estree').MemberExpression}
   */
  let expr;
  for (let i = 0; i < path.length; i++) {
    const lastExpr = expr;
    expr = {
      type: i === 0 ? 'Identifier' : 'MemberExpression',

    };
    if (expr.type === 'Identifier') {
      expr.name = path[i];
    } else {
      expr.object = lastExpr;
      if (opts.computed) expr.computed = true;
      if (opts.optional) expr.optional = true;
      expr.property = {
        type: expr.computed ? "Literal" : "Identifier",
        name: path[i],
        value: path[i]
      }
    }
  }
  return expr;
}
const STATE_SETTER = {
  getArguments(_expr: Property, opts: ToJsExpressionOpts): ESTree.Expression {
    const expr: Property = _expr as any;
    if (!expr.options) throw new Error("Options required for set_state action")
    const options: any = Object.fromEntries(parseEntries(expr.options));
    const { key, value } = options;
    const valueExpr: Expression = value;
    const prop = options.prop;
    // console.log("Value expr:", valueExpr);
    const root = opts?.transformers?.root || (v => v);

    return {
      type: "ObjectExpression",
      properties: ([
        {
          type: "Property",
          key: {
            type: "Literal",
            value: "$data",
          },
          value: {
            type: "MemberExpression",
            object: {
              type: "Identifier",
              name: "this"
            },
            property: {
              type: "Identifier",
              name: "$data"
            },
          },
          kind: "init",
          shorthand: false,
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
            value: "prop"
          },
          value: {
            type: "Literal",
            value: prop
          },
          kind: "init",
          shorthand: false,
          computed: false,
          method: false,
        },
        value && {
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
          } as ToJsExpressionOpts),
          kind: "init",
          shorthand: false,
          computed: false,
          method: false,
        }
      ] as ESTree.ObjectExpression["properties"]).filter(Boolean)
    }


  }
}
const TEST_OPS: Record<string, (left: () => ESTree.Expression, right: () => ESTree.Expression) => ESTree.Expression> = {
  'truthy'(left, right) {
    return {
      type: "UnaryExpression",
      prefix: true,
      operator: "!",
      argument: {
        type: "UnaryExpression",
        prefix: true,
        operator: "!",
        argument: left()
      }
    }
  },
  'falsy'(left, right) {
    return {
      type: "UnaryExpression",
      prefix: true,
      operator: "!",
      argument: left()
    }
  },
  ...Object.fromEntries((['===', '==', '<=', '<', '>', '>=', "!=", "!=="] as any)
    .map((operator: ESTree.BinaryOperator): [string, (typeof TEST_OPS["key"])] => {
      return [operator, (left, right) => {
        return {
          type: "BinaryExpression",
          operator,
          left: left(),
          right: right()
        }
      }]
    }))
}
const ACTIONS: Record<string, typeof STATE_SETTER> = Object.fromEntries(MUTATORS
  .map(m => [m, STATE_SETTER])
  .concat([
    ['scroll_to', {
      getArguments(_expr, opts) {
        const target: any = _expr.options?.target;
        return {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              key: identifier("target"),
              value: toJsExpression(target, opts),
              computed: false,
            }
          ]
        }

      },
    }

    ],
    ['open', {
      getArguments(_expr, opts) {
        const url: any = _expr.options?.url;
        const target: any = _expr.options?.target;
        return {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              key: identifier("url"),
              value: toJsExpression(url, opts),
              computed: false,
            },
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              key: identifier("target"),
              value: toJsExpression(target, opts),
              computed: false,
            }
          ]
        }

      },
    }

    ],
    ['case', {
      getArguments(_expr, opts) {
        const testLeft: any = _expr.options?.testLeft;
        const testOp: any = _expr.options?.testOp;
        const testRight: any = _expr.options?.testRight;
        const consequent: any = _expr.options?.consequent;
        const alternate: any = _expr.options?.alternate;
        return {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              computed: false,
              key: {
                type: "Identifier",
                name: "test"
              },
              value: TEST_OPS[testOp](() => (toJsExpression(testLeft, opts)), () => (toJsExpression(testRight, opts)))
            },
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              computed: false,
              key: {
                type: "Identifier",
                name: "consequent",
              },
              value: {
                type: "ArrowFunctionExpression",
                params: [],
                body: toJsExpression(consequent, opts),
                expression: true,
              }
            },
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              computed: false,
              key: {
                type: "Identifier",
                name: "alternate",
              },
              value: {
                type: "ArrowFunctionExpression",
                params: [],
                body: toJsExpression(alternate, opts),
                expression: true
              }
            }
          ]
        }

      },
    }],
    ['for_of', {
      getArguments(_expr, opts) {
        const of: any = _expr.options?.of;
        const stmt: any = _expr.options?.stmt;
        const loopVarName: any = _expr.options?.loopVarName;
        return {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              kind: "init",
              method: true,
              shorthand: false,
              computed: false,
              key: {
                type: "Identifier",
                name: "stmt"
              },
              value: {
                type: "FunctionExpression",
                params: [
                  {
                    type: "Identifier",
                    name: loopVarName
                  }
                ],
                body: {
                  type: "BlockStatement",
                  body: [
                    {
                      type: "ReturnStatement",
                      argument: toJsExpression(stmt, opts)
                    }
                  ]
                }
              }
            },
            {
              type: "Property",
              kind: "init",
              method: false,
              shorthand: false,
              computed: false,
              key: {
                type: "Identifier",
                name: "of"
              },
              value: (toJsExpression(of, opts))
            }
          ]
        }

      },
    }]
  ])
)
const FILTERS: Record<string, {
  getArguments(_expr: Filter, opts?: ToJsExpressionOpts): ESTree.Expression
}> = {

}
type ToJsExpressionOpts = {
  rawStates?: boolean;
  optionalMembers?: boolean;
  filtered?: boolean;
  component: Component;
  serverSideEvtCallIdx?: number;
  event?: any
  states?: string[]
  liquidFilters?: string[]
  transformers?: {
    authz?: (v: ESTree.Expression, path: string) => ESTree.Expression
    root?: (v: ESTree.Expression) => ESTree.Expression
    chain?: (v: ESTree.Expression) => ESTree.Expression,
    middleware?: (v: Token, c?: ESTree.Expression) => [ESTree.Expression, boolean],
    baseFieldId?: (v: Property) => string
  },
  reifyOpts?: Parameters<typeof reifyProperties>["2"]
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
function mkLiquidGetter(t: string) {
  return (
    expr: Property,
    opts: ToJsExpressionOpts): ESTree.Expression => {
    return {
      type: "Identifier",
      name: `{{ ${t}.${expr.options!.key as any} | json | render_void }}`
    }
  }
}
function voidguard(v): ((expr: ESTree.Expression) => ESTree.Expression) {
  return (expr) => ({
    type: "ConditionalExpression",

    test: {
      type: "BinaryExpression",
      operator: "===",
      left: {
        type: "LogicalExpression",
        operator: "??",
        left: expr,
        right: {
          type: "UnaryExpression",
          operator: "!",
          prefix: true,
          argument: expr
        }
      },
      right: expr
    },
    consequent: v,
    alternate: expr
  })
}
function fallback(v, expr) {
  return {
    type: "LogicalExpression",
    operator: "||",
    left: v,
    right: expr

  }
}
const EXPRESSION_MAPPERS: Record<string, Record<string, ReturnType<typeof mkLiquidGetter>>> = {
  '__action_loop': {
    'loop_var'(
      expr,
      opts
    ) {

      const key: string = expr.options?.key as any;
      return !key ? {
        type: "Identifier",
        name: "$x"
      } : {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "$x"
        },
        property: {
          type: "Identifier",
          name: key
        },
        computed: false,
        optional: true
      }
    }
  },
  'core': {
    'number'(
      expr,
      opts
    ) {
      if (!expr.options?.value) throw new Error("`value` is required.");
      const value = expr.options.value as any;
      const valueExpr = toJsExpression(value, opts);
      return voidguard({
        type: "CallExpression",
        callee: identifier("Number"),
        arguments: [valueExpr],
        optional: false
      })(valueExpr)
    },
    'string'(
      expr,
      opts
    ) {
      if (!expr.options?.value) throw new Error("`value` is required.");
      let value = expr.options.value as any;

      const valueExpr = value !== '[]' ? toJsExpression(value, opts) : {
        type: "Literal",
        value: ""
      } as ESTree.Literal;
      return voidguard({
        type: "CallExpression",
        callee: identifier("String"),
        arguments: [valueExpr],
        optional: false
      })(valueExpr)
    },
    'bool'(
      expr,
      opts
    ) {
      if (!expr.options?.value) throw new Error("`value` is required.");
      const value = expr.options.value as any;
      const valueExpr = toJsExpression(value, opts);
      return voidguard({
        type: "CallExpression",
        callee: identifier("Boolean"),
        arguments: [valueExpr],
        optional: false
      })(valueExpr)
    },
    'date'(
      expr,
      opts
    ) {
      if (!expr.options?.value) throw new Error("`value` is required.");
      const value = expr.options.value as any;
      const valueExpr = toJsExpression(value, opts);
      return voidguard({
        type: "NewExpression",
        callee: identifier("Date"),
        arguments: [valueExpr],
        optional: false
      })(valueExpr)
    },
    'json'(
      expr,
      opts) {
      if (!expr.options) throw new Error("Invalid JSON expression");
      const jsonString: string = expr.options.value as any;
      const ast = meriyah.parse('(' + jsonString + ')');
      const objAst = (ast.body[0] as ESTree.ExpressionStatement).expression as ESTree.ObjectExpression;
      return replaceAstExpressions(objAst, value => {
        if (typeof value.value !== 'string') return value;
        try {
          const expr: Expression = JSON.parse(value.value);
          let render = true;
          render = (opts?.reifyOpts?.fixed !== false || expr.every((v: any) => !isFixed(v)));
          if (render) render = (opts?.reifyOpts?.state !== false || expr.every((v: any) => !isState(v)));
          if (render) render = (opts?.reifyOpts?.http !== false || expr.every((v: any) => !isHttp(v)));
          if (!render) {
            return;
          }
          return toJsExpression(expr, opts);
        } catch (e) {
          console.error("Error parsing JSON token:", value);
        }

      }) as typeof objAst;
    },
    'ternary'(
      expr,
      opts
    ) {
      const testLeft: any = expr.options?.testLeft;
      const testOp: any = expr.options?.testOp;
      const testRight: any = expr.options?.testRight;
      const consequent: any = expr.options?.consequent;
      const alternate: any = expr.options?.alternate;
      return ({
        type: "ConditionalExpression",
        test: TEST_OPS[testOp](() => toJsExpression(testLeft, opts), () => toJsExpression(testRight, opts)),
        consequent: toJsExpression(consequent, opts),
        alternate: toJsExpression(alternate, opts)
      })
    },
    'binop'(
      expr,
      opts
    ) {
      const left: any = expr.options?.left;
      const op: any = expr.options?.op;
      const right: any = expr.options?.right;
      return ({
        type: "BinaryExpression",
        left: toJsExpression(left, opts),
        operator: op,
        right: toJsExpression(right, opts),
      })
    },
    'unop'(
      expr,
      opts
    ) {
      const argument: any = expr.options?.argument;
      const op: any = expr.options?.op;
      return ({
        type: "UnaryExpression",
        argument: toJsExpression(argument, opts),
        operator: op,
        prefix: true
      })
    },

  },
  'http': {
    'get_session': mkLiquidGetter('session'),
    'get_cookie': mkLiquidGetter('cookies'),
    'get_header': mkLiquidGetter('headers'),
    'get_local': mkLiquidGetter('locals'),
    'get_body': mkLiquidGetter('body'),
    'get_query': mkLiquidGetter('query'),
    'get_env': mkLiquidGetter('env'),
  }
}
function awaited(ast: ESTree.Expression): ESTree.AwaitExpression {
  return {
    type: "AwaitExpression",
    argument: ast
  }
}
export function toJsExpression(expression: Expression | null | undefined, opts: ToJsExpressionOpts): ESTree.Expression {
  if (!expression) return { type: "Identifier", name: "null" };
  if (typeof expression === 'string') {
    try {

      expression = JSON.parse(expression);
    } catch (e) {
      console.warn("Failed to parse expression:", expression);
      console.warn("Returning literal");
      return { type: "Literal", value: expression as any }
    }
  }
  if (!expression || !expression.length) return { type: "Identifier", name: "null" }
  // console.log("Input expression:", expression);
  const first = expression[0];
  let lastChained;
  let { authz, root, chain: _chain, middleware, baseFieldId: baseFieldId } = opts?.transformers! || {};
  root ??= v => v;
  _chain ??= VALUEOF_CHAINER;
  middleware ??= CHAIN_FILTERS(root, opts);
  authz ??= v => v
  baseFieldId ??= t => t.fieldId
  if (first.type === 'property' && first.dataSourceId === 'actions') {
    const actionsId = (cache.get('actionsId') ?? 0) + 1;
    let hasFromServer;
    cache.set('actionsId', actionsId);
    const ret = {
      type: "CallExpression",
      optional: false,
      callee: {
        type: "MemberExpression",
        object: {
          type: "MemberExpression",
          object: root({
            type: "Identifier",
            name: "$store"
          }),
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
      arguments: (expression as any[])
        .filter(e => Boolean(e.dataSourceId))
        // .filter(e => )
        .reduce((exprs: { value: ESTree.Expression[], state: any }, e: Property, idx, arr) => {
          const prev = arr[idx - 1];
          if (false && e.fieldId === 'email') {
            const _payload: any = e.options?.expression;
            const template: string = e.options?.template as any;
            if (_payload && template) {
              const payload = JSON.parse(_payload);
              const ast = toJsExpression(payload, opts);
              exprs.value.push({
                type: "CallExpression",
                optional: false,
                callee: {
                  type: "Identifier",
                  name: "fetch"
                },
                arguments: [
                  {
                    type: "Literal",
                    value: template
                  },
                  {
                    type: "ObjectExpression",
                    properties: [
                      {
                        type: "Property",
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        method: false,
                        key: {
                          type: "Identifier",
                          name: "method"
                        },
                        value: {
                          type: "Literal",
                          value: "post"
                        }
                      },
                      {
                        type: "Property",
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        method: false,
                        key: {
                          type: "Identifier",
                          name: "body"
                        },
                        value: {
                          type: "CallExpression",
                          optional: false,
                          callee: {
                            type: "MemberExpression",
                            optional: false,
                            computed: false,
                            object: {
                              type: "Identifier",
                              name: "JSON"
                            },
                            property: {
                              type: "Identifier",
                              name: "stringify"
                            }
                          },
                          arguments: [
                            ast
                          ]
                        }
                      }
                    ]
                  }
                ]
              })

            } else {
              throw new Error("`body` and `template` required.");
            }
          }
          else if (ACTIONS[e.fieldId]) {
            const firstFromServerCall = fromserver(e) && (!prev || !fromserver(prev)) && (opts.states as any)?.actionsId !== actionsId;
            let states: string[];
            if (firstFromServerCall) {
              hasFromServer = true;
              states = [];
              (states as any).actionsId = actionsId;
              opts.states = states;
              opts.transformers ??= {};
              const oldAuthz = authz!;
              authz = opts.transformers.authz = (v, path) => ({
                type: "CallExpression",
                optional: false,
                callee: {
                  type: "MemberExpression",
                  optional: false,
                  computed: false,

                  object: {
                    type: "CallExpression",
                    optional: false,
                    callee: root(identifier(["$store", "ensure_csrf"])),
                    arguments: [identifier(`{{ "${path}" "${path}" | to_access  }}`)]
                  },
                  property: identifier("then"),
                },
                arguments: [{
                  type: "ArrowFunctionExpression",
                  params: [],
                  body: oldAuthz(v, path),
                  expression: true
                }]
              } as ESTree.CallExpression);
              (authz as any).prev = oldAuthz;
            }
            const expr: ESTree.Expression = {
              type: "CallExpression",
              callee: {
                type: "MemberExpression",
                computed: false,
                optional: false,
                object: root({
                  type: "Identifier",
                  name: "$store"
                }),
                property: {
                  type: "MemberExpression",
                  object: {
                    type: "Identifier",
                    name: (e as any).dataSourceId
                  },
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
            };


            exprs.value.push(expr);
            if (firstFromServerCall) {
              const last = expr;

              exprs.value[exprs.value.length - 1] = ((close) => ({
                type: "Identifier",
                name: `{% fromserver ${getDataId(opts.component)}-${Math.random() * Date.now()} ${states./* map(s => `"${s}"`). */join(' ')} %}` +
                  genJs({
                    type: "MemberExpression",
                    optional: false,
                    computed: false,
                    object: root(identifier(['$store', 'actions'])),
                    property: {
                      type: "Identifier",
                      name: "run_all"
                    }
                  }, { minify: false }) + "(() => " +
                  genJs(last, { minify: false }) +
                  (close ? "){% endfromserver %}" : '')
              })) as any
            }
            else if (opts.states) {
              exprs.value[exprs.value.length - 1] = ((close) => !close ? ({
                type: "Identifier",
                name: genJs(expr, { minify: false }) /* + `{% "wtf? ${close} ${(opts.states as any).actionsId} ${actionsId}" %}` */
              }) : ({
                type: "Identifier",
                name: genJs(expr, { minify: false }) + "){% endfromserver %}"
              })) as any;
            }


          } else if (opts?.event) {
            if (!prev || ACTIONS[prev.fieldId]) {
              const last: any = exprs.value[exprs.value.length - 1];
              if (last && fromserver(prev)) {
                delete opts.states;
                authz = opts.transformers!.authz = (opts.transformers!.authz as any).prev
                exprs.value[exprs.value.length - 1] = {
                  type: "Identifier",
                  name: genJs(last instanceof Function ? last(idx === arr.length - 1) : last, { minify: false })
                }
              }
              opts.serverSideEvtCallIdx ??= 0;
              exprs.state.options = [];
              const path = [
                opts?.component?.get?.('id-plugin-data-source'),
                opts?.event?.name.replace(/[:]/gi, '_'),
                opts.serverSideEvtCallIdx++
              ].join('_');

              exprs.value.push(authz!({
                type: "CallExpression",
                optional: false,
                callee: {
                  type: "MemberExpression",
                  object: {
                    type: "Identifier",
                    name: "window"
                  },
                  property: {
                    type: "Identifier",
                    name: "fetch"
                  },
                  optional: false,
                  computed: false
                },
                arguments: [
                  {
                    type: "Identifier",
                    name: backticked(access("/" + path))
                  },
                  {
                    type: "ObjectExpression",
                    properties: [
                      {
                        type: "Property",
                        key: {
                          type: "Identifier",
                          name: "method"
                        },
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        method: false,
                        value: {
                          type: "Literal",
                          value: "post"
                        }
                      },
                      {
                        type: "Property",
                        key: {
                          type: "Identifier",
                          name: "credentials"
                        },
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        method: false,
                        value: {
                          type: "Literal",
                          value: "same-origin"
                        }
                      },
                      {
                        type: "Property",
                        method: false,
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        key: identifier("headers"),
                        value: {
                          type: "ObjectExpression",
                          properties: [
                            {
                              type: "Property",
                              method: false,
                              kind: "init",
                              shorthand: false,
                              computed: false,
                              key: {
                                type: "Literal",
                                value: "content-type"
                              },
                              value: {
                                type: "Literal",
                                value: "application/json"
                              }
                            }
                          ]
                        }
                      },
                      {
                        type: "Property",
                        key: {
                          type: "Identifier",
                          name: "body"
                        },
                        kind: "init",
                        shorthand: false,
                        computed: false,
                        method: false,
                        value: {
                          type: "CallExpression",
                          callee: {
                            type: "MemberExpression",
                            optional: false,
                            computed: false,
                            object: {
                              type: "Identifier",
                              name: "JSON"
                            },
                            property: {
                              type: "Identifier",
                              name: "stringify"
                            }
                          },
                          arguments: [
                            {
                              type: "ObjectExpression",
                              properties: exprs.state.options
                            }
                          ],
                          optional: false
                        }
                      },
                    ]
                  }
                ]
              }, path))
            }
            const options: ESTree.ObjectExpression["properties"] = exprs.state.options;
            const parsed = parseEntries(e?.options || {});
            parsed.forEach(function extractStates([k, v]: [string, any]) {
              let expression;
              if (v && Array.isArray(v) && v.length && v[0] && v[0].type && v[0].label && ['property', 'filter', 'state'].includes(v[0].type)) {
                expression = v;
              }
              if (!expression) return;
              for (const token of expression as Expression) {
                console.log("checking",token,"for states");
                if (token.type === 'property') {
                  opts.component && getFieldId(opts.component, token);
                  if (token.fieldId === 'json') {
                    return token.options?.value &&
                      replaceObjectExpressions(JSON.parse(token.options!.value as any), (v, { path }) => {
                        if (typeof v === 'string') (v) = JSON.parse(v);
                        return v && extractStates([path, v]);
                      });
                  }
                  Object.values(token.options || {}).forEach(v => {
                    try {
                      const obj = JSON.parse(v as any);
                      if (Array.isArray(obj)) return extractStates(['', obj]);

                    } catch (e) {

                    }
                  })
                }
                else if (token.type === 'state') {
                  const stateId = stateVarName(token);
                  options.push({
                    type: "Property",
                    computed: false,
                    shorthand: false,
                    method: false,
                    kind: "init",
                    key: {
                      type: "Literal",
                      value: stateId
                    },
                    value: {
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
                      optional: true,
                    }
                  });
                }
              }
            })
          }
          return exprs;
        }, { value: [] as ESTree.Expression[], state: {} }).value
        .map((e, idx, arr): ESTree.ArrowFunctionExpression => ({
          type: "ArrowFunctionExpression",
          expression: true,
          body: e instanceof Function ? e(hasFromServer && idx === arr.length - 1) : e,
          params: []
        }))

    }
    return ret as ESTree.Expression;
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
          if (opts.states) {
            const states = getPropertyStates(expr);
            console.log("Adding states...", ...states);
            opts.states.push(...states);
          }
          const mapper = EXPRESSION_MAPPERS?.[expr.dataSourceId]?.[expr.fieldId]
          if (mapper) {
            currentJs = mapper(expr, opts)
          } else if (i === 0 && isDataSourceField(expr)) {
            if (!opts?.component) throw new Error("`opts.component` required.");
            const after = expression.slice(i);
            const end = after.findIndex(t => (t.type !== 'property' || t.dataSourceId !== expr.dataSourceId) && t.type !== 'filter');
            const liquidExpr = after.slice(0, end === -1 ? undefined : end);
            i += liquidExpr.length;
            console.log({ after, end, liquidExpr });
            if (liquidExpr.length) {

              currentJs = {
                type: "Identifier",
                name: echoBlock1line(opts.component, liquidExpr).slice(0, -2) + `| json | render_void ${opts?.liquidFilters?.length ?
                  '| ' + opts.liquidFilters.join(' | ') + ' ' :
                  ''
                  }}}`
              }
            }
          } else {
            if (!currentJs) {
              currentJs = {
                type: "Identifier",
                name: expr.dataSourceId as string
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
              optional: opts.optionalMembers ?? true,
            }
            chain();

          }
          //   if (!currentJs) {
          //     currentJs = {
          //       type: "MemberExpression",
          //       object: root({
          //         type: "Identifier",
          //         name: "$store"
          //       }),
          //       property: {
          //         type: "Literal",
          //         value: expr.dataSourceId
          //       },
          //       optional: true,
          //       computed: true,
          //     }

          //   }
          //   currentJs = {
          //     type: "MemberExpression",
          //     object: currentJs,
          //     property: {
          //       type: "Literal",
          //       value: i !== 0 ? expr.fieldId : baseFieldId(expr)
          //     },
          //     computed: true,
          //     optional: true,
          //   }
          //   chain();

          //   if (expr.options && Object.keys(expr.options).length) {
          //     currentJs = {
          //       type: "CallExpression",
          //       callee: currentJs,
          //       arguments: [pojsoToAST(reifyProperties(expr.options, opts, { fixed: false, http: false, })),],
          //       optional: true,
          //     }
          //   }
          // }

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

        const stateId = stateVarName(expr);
        if (opts?.states) {
          console.log("from server state:", stateId);
          opts.states.push(stateId);
        }
        currentJs = !opts?.rawStates ? {
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
          optional: opts?.optionalMembers ?? true
        } : {
          type: "Identifier",
          name: stateId
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
              FILTERS[expr.id].getArguments(expr as Filter, opts) :
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
  if (opts?.filtered) {
    currentJs = ensureFilteredData(currentJs!, expression as any);
  }
  // console.log("output JS AST:", currentJs);
  return ensureJs(currentJs);
}

const withSelf = (opts: ToJsExpressionOpts): ToJsExpressionOpts => ({
  ...(opts || {}),
  transformers: {
    ...(opts?.transformers || {}),
    root(expr: ESTree.Expression): ESTree.Expression {
      return {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "self"
        },
        property: expr,
        optional: false,
        computed: false,
      }
    }
  }
})

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
        optional: false,
        computed: false,
      }
    }
  }
})
function getAlpineBindScript(
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
  }): [string, boolean] {
  const key = `bind_${sanitizeId(getDataId(component))}`;
  if (cache.has(key)) return ['', cache.get(key)];
  if (!opts.statesObj || !opts.statesPrivate || !opts.statesPublic) {
    if (!opts.config) throw new Error("Config or states required.");
    const states = getStatesObj(opts.config, component);
    Object.assign(opts, states);
  }
  if (!opts.originalAttributes) {
    opts.originalAttributes = component.get('attributes') as Record<string, string>

  }
  // component.forEachChild(child => child && alpinify(child, { ...opts, statesObj: undefined, statesPrivate: undefined, statesPublic: undefined, originalAttributes: undefined }));
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
  // console.log("alpinify:", opts);
  const boundAttributes = getBoundAttributes(component, opts);
  const attrs: any = {
    ...opts.originalAttributes,
    ...(boundAttributes),
    // 'x-data': !hasData ? true : sanitizeId(getDataId(component)),
    'x-html': maybeAwaitJs(genJs(
      ensureFilteredData(
        toJsExpression(
          opts?.statesObj?.innerHTML?.tokens,
          withThis({
            component,
            transformers: {
              middleware: CHAIN_FILTERS(undefined, withThis({ component })),
              baseFieldId: fieldId,
            }
          })
        ), opts?.statesObj?.innerHTML?.tokens!), { minify: false })),
    ...(Object.fromEntries(
      (events || [])
        .map((e: any) => e.toJSON instanceof Function ? e.toJSON() : e)
        .filter(e => e.expression)
        .map(e => {
          // console.log("Event:", e);
          return ([
            'x-on:' + [e.name, ...(e.modifiers ? e.modifiers.map(m => m.name || m.get('name')) : [])].join('.'),
            genJs(toJsExpression(JSON.parse(e.expression), withThis({ event: e, component, transformers: { baseFieldId: fieldId } })), { minify: false })
          ])
        })
    )),
  };
  if (!attrs['x-html'] || attrs['x-html'] === 'null') {
    delete attrs['x-html']
  }
  if (hasReactiveProps(component) || component.defaults.script) {
    // if (typeof attrs['x-data'] !== 'string' || attrs['x-data'].length === 0) attrs['x-data'] = sanitizeId(getDataId(component));
    attrs["x-init"] = `this.$$init.bind(this)(${getInitializerOpts(component)})`;
  }
  // component.removeAttributes(Object.keys(component.getAttributes()));
  // component.addAttributes(attrs);
  const attrEntries = Object.entries(attrs);
  if (!attrEntries.some(entry => entry[0].startsWith('x-') || entry[0].startsWith(':'))) {
    return ['', (cache.set(key, false), false)];
  }
  cache.set(key, true);
  return [`Alpine.bind('${key}',() => ({\n${attrEntries
    .map(e => (e[0].startsWith('x-') || e[0].startsWith(':')) ? `'${e[0]}': async function () {\n${`const self=this;\nreturn ${e[1]};`
      }\n},` : ``)
    .filter(Boolean)
    .join('\n')}\n}));\n`, true]
}

function toJsCondition(component: Component, condition: { expression: Token[]; expression2?: Token[]; operator: UnariOperator | BinariOperator; }): ESTree.Expression {
  const exprs = [condition.expression, condition.expression2].filter(Boolean).map(e => toJsExpression(e!, { component, transformers: { baseFieldId: p => getFieldId(component, p) } }));
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
function isLoopKey(component: Component, label: string) {
  return component.get('privateStates')?.find?.(s => s.id === '__data') && label === 'key';
}
function getBoundAttributes(component: Component, opts: Parameters<typeof getAlpineBindScript>["1"]) {
  return Object.fromEntries(
    opts
      .statesPrivate!
      .filter(({ label }) => isAttribute(label) && label !== 'x-model' && !isLoopKey(component, label))
      .map(
        s => {
          const expr = genJs(ensureFilteredData(
            toJsExpression(
              s.tokens,
              withThis({
                component,
                transformers: {
                  middleware: CHAIN_FILTERS(undefined, withThis({ component })),
                  baseFieldId: t => getFieldId(component, t)
                }
              })
            ), s.tokens), { minify: false });
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

function reifyProperties(options: any, genOpts: ToJsExpressionOpts | undefined, overrides?: { fixed?: boolean; http?: boolean; state?: boolean; }): Options {
  const opts = overrides || genOpts?.reifyOpts || {};
  let entries =
    (parseEntries(options) as any)
      .filter((e: [string, Expression]) =>
        (opts?.fixed !== false || e[1].every((v: any) => !isFixed(v))) &&
        (opts?.state !== false || e[1].every((v: any) => !isState(v))) &&
        (opts?.http !== false || e[1].every((v: any) => !isHttp(v)))
      )
  if (!entries.length) {
    return {
      $$empty: true
    }
  }
  return Object.fromEntries(entries.map(e => [e[0], toJsExpression(e[1], { ...genOpts, reifyOpts: { ...(genOpts?.reifyOpts || {}), ...(overrides || {}) } } as ToJsExpressionOpts)]))
}



function ensureFilteredData(arg0: ESTree.Expression, tokens: Token[], forceEnsure: boolean = false): ESTree.Expression {
  if (!tokens || !tokens.length) return arg0;
  let ensure = forceEnsure || tokens?.[0]?.type === 'property' && Boolean(tokens[0].dataSourceId) && isExternalDataSource(tokens[0].dataSourceId as string) && !isHttp(tokens[0]);
  // ensure = ensure || tokens?.[0]?.type === 'state';
  const filtered = tokens.find(t => t.type === 'filter');

  if (false && ensure) {
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
  if (false && filtered) {
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
  return arg0;
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
    const stmts: ESTree.BlockStatement["body"] = [];
    stmts.push({
      type: "IfStatement",
      test: {
        prefix: true,
        type: "UnaryExpression",
        operator: "!",
        argument: {
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
              value: dataSourceId
            }
          ],
          optional: false
        }
      },
      consequent: {
        type: "ExpressionStatement",
        expression: {
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
              value: dataSourceId
            },
            {
              type: "ObjectExpression",
              properties: []
            }
          ],
          optional: false
        }
      }
    });
    stmts.push(...dsRefs.map((dsRef): ESTree.Statement => {
      const httpMethod = getHttpMethod(dsRef as Property, config).toLowerCase();
      const pathLiteral = {
        type: "Identifier",
        name: backticked(access("/" + dsRef.variant))
      };
      const dsPropRef = `${dsRef.dataSourceId}.${dsRef.variant}`;
      const substitutionPairs = getSubstitutionOptions(component, dsRef);
      const optVarName = dsPropRef + "__opts";
      const $value: ESTree.Expression = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "reloadable"
        },
        arguments: [
          /* {
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
          } */{
            type: "Identifier",
            name: `{{ ${dsPropRef} | call_with_opts: ${optVarName}${substitutionPairs ? ', ' + substitutionPairs : ''}  | json | render_void }}`
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
              callee:/* {
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
                } */{
                type: "MemberExpression",
                object: {
                  type: "Identifier",
                  name: "window"
                },
                property: {
                  type: "Identifier",
                  name: "fetch"
                },
                optional: false,
                computed: false
              },
              arguments: ([
                !["get", "options", "delete", "head"].includes(httpMethod) ? pathLiteral : {
                  type: "BinaryExpression",
                  left: pathLiteral,
                  right: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      object: {
                        type: "Identifier",
                        name: "Qs"
                      },
                      property: {
                        type: "Identifier",
                        name: "stringify"
                      },
                      optional: false,
                      computed: false
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
                              type: "Identifier",
                              name: "arrayFormat"
                            },
                            value: {
                              type: "Literal",
                              value: "brackets"
                            },
                            kind: "init",
                            computed: false,
                            shorthand: false
                          }
                        ]
                      }
                    ]
                  },
                  operator: "+"
                },
                {
                  type: "ObjectExpression",
                  properties: ([
                    {
                      type: "Property",
                      key: {
                        type: "Identifier",
                        name: "method"
                      },
                      value: {
                        type: "Literal",
                        value: httpMethod
                      },
                      kind: "init",
                      method: false,
                      shorthand: false,
                      computed: false
                    },
                    !["get", "options", "delete", "head"].includes(httpMethod) ? ({
                      type: "Property",
                      key: {
                        type: "Identifier",
                        name: "body"
                      },
                      value: {
                        type: "CallExpression",
                        callee: {
                          type: "MemberExpression",
                          object: {
                            type: "Identifier",
                            name: "JSON"
                          },
                          property: {
                            type: "Identifier",
                            name: "stringify"
                          },
                          optional: false,
                          computed: false,
                        },
                        arguments: [
                          {
                            type: "Identifier",
                            name: "opts"
                          }
                          // {
                          //   type: "ObjectExpression",
                          //   properties: [
                          //     {
                          //       type: "SpreadElement",
                          //       argument: {
                          //         type: "Identifier",
                          //         name: "opts"
                          //       },
                          //     },
                          //   ]
                          // }
                        ]
                      }

                    } as ESTree.Property) : null
                  ]).filter(Boolean)
                }
              ] as /*  unknown as   */ESTree.Expression[]),
              optional: false,
            }
          }
        ],
        optional: false,
      };
      return {
        type: "ExpressionStatement",
        expression: {
          type: "AssignmentExpression",
          left: {
            type: "MemberExpression",
            object: {
              type: "Identifier",
              name: "Alpine"
            },
            property: {
              type: "MemberExpression",
              object: {
                type: "CallExpression",
                callee: {
                  type: "Identifier",
                  name: "store"
                },
                arguments: [{
                  type: "Literal",
                  value: dataSourceId!
                }],
                optional: false,
              },
              property: {
                type: "Literal",
                value: dsRef.variant
              },
              optional: false,
              computed: true
            },
            computed: false,
            optional: false
          },
          right: $value,
          operator: "??=",
        }
      }
    }))

    js += genJs({
      type: "BlockStatement",
      body: stmts

    }) + ';\n'
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
  // component.forEachChild(component => {
  //   childExprs.push(...getAllExpressions(component));
  // })

  const events = component.get('events') || [];
  // console.log("Events:", events);
  const eventExpressions = events
    ?.flatMap?.(
      e => getExpr(e) ?
        JSON.parse(getExpr(e))
          ?.flatMap(
            e => Object.values(e.options)
              .map((v: any) => tryParse('' + v))
              .filter(v => Array.isArray(v))
              .flatMap(v => explode(v))
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

function isDataSource(dataSourceId?: import("@silexlabs/grapesjs-data-source").DataSourceId): unknown {
  return dataSourceId && String(dataSourceId).indexOf('ds-') === 0
}
const toSafeVarName = (str) => {
  return str
    .replace(/[^a-zA-Z0-9_]/g, '_') // Replace invalid chars with underscore
    .replace(/^[0-9]/, '_$&')       // Prefix with underscore if starts with number
    .replace(/^$/, '_');            // Use underscore for empty string
};

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
function isDataSourceField(expr: Property) {
  if (!expr.dataSourceId || !isDataSource(expr.dataSourceId)) return;
  if (!expr.fieldId) return;
  // const ret = METHODS.includes(expr.fieldId.split(' ')[0])
  // console.log("data source?", expr, expr.fieldId);
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
  /*   const dataStores = getAlpineStoreScript(component, config);
    const dataMethods = getAlpineDataScripts(component, config); */
  const scripts = [STORE_JS, actions, filters, /* dataStores, dataMethods */];
  const ret = scripts.join('\n');
  // console.log("boilerplate", ret);
  // console.log("boilerplates", scripts);
  return ret;
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
  const componentId = sanitizeId(getDataId(component));
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

/* function getAlpineDataScripts(component: Component, config?: ClientConfig) {
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
} */
function getInitializerOpts(component: Component) {
  if (!component.defaults.script /* || !component.defaults['script-props'] */) return '';
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
  const _props: Array<Backbone.Model<{ id: string, name: string, expression: string, modelable: boolean }>> = component.get('props');
  return _props.flatMap(p => {

    const expr = JSON.parse(getExpr(p)) as Expression;
    const getter = {
      type: "Property",
      kind: "get",
      method: true,
      computed: false,
      shorthand: false,
      key: {
        type: "Literal",
        value: (p as any).name || p?.get?.('name')!,
      },
      value: {
        type: "FunctionExpression",
        params: [],
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: ensureFilteredData(toJsExpression(expr, withSelf({ component, filtered: true, transformers: { baseFieldId: p => getFieldId(component, p) } })), expr as any)

            }
          ]
        }
      }
    };
    const setter: ESTree.Property | false = expr[0].type === 'state' &&
      ((p as any).modelable || p?.get?.('modelable')) &&
    {
      type: "Property",
      kind: "set",
      method: true,
      computed: false,
      shorthand: false,
      key: getter.key,
      value: {
        type: "FunctionExpression",
        params: [{
          type: "Identifier",
          name: "v"
        }],
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: {
                type: "AssignmentExpression",
                operator: "=",
                left: ensureFilteredData(toJsExpression(expr, withSelf({ optionalMembers: false, component, filtered: true, transformers: { baseFieldId: p => getFieldId(component, p) } })), expr as any),
                right: {
                  type: "Identifier",
                  name: "v"
                }
              }
            }
          ]
        }
      }
    }
    return [getter, setter].filter(Boolean) as any;
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

function quoted(v) {
  return '"' + v + '"';
}
function backticked(v) {
  return '`' + v + '`';
}
function access(p) {
  if (p.charAt(0) === '/') p = p.slice(1);
  return `{{ "${p}" | access }}`;
}

function isExternalDataSource(dataSourceId: string) {
  return dataSourceId.indexOf('ds-') === 0;
}

function filterEmptyExpressions(e) {
  return Array.isArray(e) && e.length
}
function explode(expr) {
  return expr.flatMap(e => {
    if (e.type === 'property') {

      switch (e.fieldId) {
        case 'for_of': {

          return [e.options?.stmt].filter(Boolean).map((s: any) => JSON.parse(s)).filter(filterEmptyExpressions);
        }
        case 'ternary':
        case 'case': {
          return [e.options?.test, e.options?.consequent, e.options?.alternate].filter(Boolean).map((s: any) => JSON.parse(s)).filter(filterEmptyExpressions);
        }
        default:
          return [e];
      }
    }
  })
}
function stateVarName(expr) {
  return (expr.componentId && expr.storedStateId === '__data') ?
    toJsVarName(getStateVariableName(expr.componentId || "", "__data")) :
    expr.storedStateId;
}
function getDataId(component: Component) {
  const cId = getOrCreatePersistantId(component);
  return [component.cid, cId].join('_')
}
function escapeQuotesForHtmlAttribute(str) {
  return str.replace(/"/g, '&quot;');
}

function fromserver(e: Property): boolean {
  const parsed = parseEntries(e?.options || {});
  let fromserver;
  parsed.forEach(function checkfromserver([k, v]: [string, any]) {
    if (fromserver) return;

    let expression;
    if (v && Array.isArray(v) && v.length && v[0] && v[0].type && v[0].label && ['property', 'filter', 'state'].includes(v[0].type)) {
      expression = v;
    }
    if (!expression) return;
    for (const token of expression as Expression) {
      console.log("checking if", token, "is fromserver....");
      if (token.type === 'property') {
        if (token.fieldId === 'json') {

          const obj = JSON.parse(token.options?.value as any);
          replaceObjectExpressions(obj, (v, { path }) => {
            if (typeof v === 'string') (v) = JSON.parse(v);
            return v && checkfromserver([path, v]);
          });
        } else if (isDataSource(token.dataSourceId) || isHttp(token)) {
          fromserver = true;
          console.log("Token is from server", token);
        }
        Object.values(token.options || {}).forEach((v: any) => {
          try {
            const obj = JSON.parse(v);
            if (Array.isArray(obj)) return checkfromserver(['', obj])
            // replaceObjectExpressions(obj, (v, { path }) => {
            //    if (typeof v === 'string') (v) = JSON.parse(v);
            //    return v && walkExpr(v);
            // });
          } catch (e) {

          }
        })
      }
    }

  });
  return fromserver;
}
function getPropertyStates(e: Property): string[] {
  const parsed = parseEntries(e?.options || {});
  const states: string[] = [];
  parsed.forEach(function checkfromserver([k, v]: [string, any]) {
    let expression;
    if (v && Array.isArray(v) && v.length && v[0] && v[0].type && v[0].label && ['property', 'filter', 'state'].includes(v[0].type)) {
      expression = v;
    }
    if (!expression) return;
    for (const token of expression as Expression) {
      if (token.type === 'property') {
        if (token.fieldId === 'json') {

          const obj = JSON.parse(token.options?.value as any);
          replaceObjectExpressions(obj, (v, { path }) => {
            if (typeof v === 'string') (v) = JSON.parse(v);
            return v && checkfromserver([path, v]);
          });
        }
      } else if (token.type === 'state') {
        states.push(stateVarName(token))
      }
    }
  });
  return states;
}

