import { Expression, FIXED_TOKEN_ID, Filter, Property, State, StateId, Token, getPersistantId, getStateVariableName, DataTree, BinariOperator, UnariOperator, getExpressionResultType, toExpression, DataSourceEditor, StoredProperty, StoredFilter } from '@silexlabs/grapesjs-data-source'
import { Component } from 'grapesjs'
import { EleventyDataSourceId } from './DataSource'
import OpenApi from '@silexlabs/grapesjs-data-source/src/datasources/OpenApi'
import snakecase from 'snakecase';
import { isFixed, isHttp, isState, parseEntries } from './utils';
export interface BinaryCondition {
  operator: BinariOperator,
  expression: Expression,
  expression2: Expression,
}

export interface UnaryCondition {
  operator: UnariOperator,
  expression: Expression,
}

export type Condition = BinaryCondition | UnaryCondition
const EXPRESSION_HANDLERS = {
  inline: {
    "http": {
      "get_session"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `session.${token.options.key}`
      },
      "get_body"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `body.${token.options.key}`
      },
      "get_query"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `query.${token.options.key}`
      },
      "get_cookie"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `cookies.${token.options.key}`
      },
      "get_local"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `locals.${token.options.key}`
      }
    }
  },
  block: {
    "http": {
      "get_session"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `{{session.${token.options.key}}}`
      },
      "get_body"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `{{body.${token.options.key}}}`
      },
      "get_query"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `{{query.${token.options.key}}}`
      },
      "get_cookie"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `{{cookies.${token.options.key}}}`
      },
      "get_local"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `{{locals.${token.options.key}}}`
      }
    },

  }
}
/**
 * Generate liquid instructions which echo the value of an expression
 */
export function echoBlock(component: Component, expression: Expression): string {
  if (expression.length === 0) throw new Error('Expression is empty')
  if (expression.length === 1 && expression[0].type === 'property' && expression[0].fieldId === FIXED_TOKEN_ID) {
    return expression[0].options?.value as string ?? ''
  }
  const firstTok = expression[0];
  if (
    firstTok.type === 'property' &&
    EXPRESSION_HANDLERS.block[firstTok.dataSourceId!][firstTok.fieldId]
  ) {
    return EXPRESSION_HANDLERS.block[firstTok.dataSourceId!][firstTok.fieldId](component, firstTok);
  }
  const statements = getLiquidBlock(component, expression)
  return `{% liquid
    ${statements
      .map(({ liquid }) => liquid)
      .join('\n\t')
    }
    echo ${statements[statements.length - 1].variableName}
  %}`
}

/**
 * Generate liquid instructions which echo the value of an expression, on 1 line
 */
export function echoBlock1line(component: Component, expression: Expression): string {
  if (expression.length === 0) throw new Error('Expression is empty')
  if (expression.length === 1 && expression[0].type === 'property' && expression[0].fieldId === FIXED_TOKEN_ID) {
    return expression[0].options?.value as string ?? ''
  }
  const firstTok = expression[0];
  if (
    firstTok.type === 'property' &&
    EXPRESSION_HANDLERS.block[firstTok.dataSourceId!][firstTok.fieldId]
  ) {
    return EXPRESSION_HANDLERS.block[firstTok.dataSourceId!][firstTok.fieldId](component, firstTok);
  }
  const statements = getLiquidBlock(component, expression)
  return `{% ${statements
    .map(({ liquid }) => liquid)
    .join(' %}{% ')
    } %}{{ ${statements[statements.length - 1].variableName} }}`
}

/**
 * Generate liquid instructions which define a variable for later use
 * This is used for components states
 */
export function assignBlock(stateId: StateId, component: Component, expression: Expression): string {
  if (expression.length === 0) throw new Error('Expression is empty')
  const statements = getLiquidBlock(component, expression)
  const persistantId = getPersistantId(component)
  if (!persistantId) throw new Error('This component has no persistant ID')
  return `{% liquid
    ${statements
      .map(({ liquid }) => liquid)
      .join('\n\t')
    }
    assign ${getStateVariableName(persistantId, stateId)} = ${statements[statements.length - 1].variableName}
  %}`
}

/**
 * Generate liquid instructions which start and end a loop over the provided expression
 * This is used for components states
 */
export function loopBlock(dataTree: DataTree, component: Component, expression: Expression): [start: string, end: string] {
  if (expression.length === 0) throw new Error('Expression is empty')
  // Check data to loop over
  const field = getExpressionResultType(expression, component, dataTree)
  if (!field) throw new Error(`Expression ${expression.map(token => token.label).join(' -> ')} is invalid`)
  if (field.kind !== 'list') throw new Error(`Provided property needs to be a list in order to loop, not a ${field.kind}`)
  const statements = getLiquidBlock(component, expression)
  const loopDataVariableName = statements[statements.length - 1].variableName
  const persistantId = getPersistantId(component)
  if (!persistantId) {
    console.error('Component', component, 'has no persistant ID. Persistant ID is required to get component states.')
    throw new Error('This component has no persistant ID')
  }
  return [`{% liquid
    ${statements
      .map(({ liquid }) => liquid)
      .join('\n\t')
    }
    %}
    {% for ${getStateVariableName(persistantId, '__data')} in ${loopDataVariableName} %}
  `, '{% endfor %}']
}

/**
 * Generate liquid instructions which define a variable for later use
 * This is used for components states
 */
export function ifBlock(component: Component, condition: Condition): [start: string, end: string] {
  // Check the first expression
  if (condition.expression.length === 0) throw new Error('If block expression is empty')

  // Check the operator
  const unary = Object.values(UnariOperator).includes(condition.operator as UnariOperator) ? condition as UnaryCondition : null
  const binary = Object.values(BinariOperator).includes(condition.operator as BinariOperator) ? condition as BinaryCondition : null
  if (!unary && !binary) throw new Error(`If block operator is invalid: ${condition.operator}`)

  // Check the second expression
  if (binary && binary.expression2.length === 0) return ['', '']

  // Get liquid for the first expression
  const statements = getLiquidBlock(component, condition.expression)
  const lastVariableName = statements[statements.length - 1].variableName

  // Get liquid for the second 
  let lastVariableName2 = ''
  if (binary) {
    statements.push(...getLiquidBlock(component, binary.expression2))
    lastVariableName2 = statements[statements.length - 1].variableName
  }

  // Get liquid for the whole if block
  return [`{% liquid
    ${statements
      .map(({ liquid }) => liquid)
      .join('\n\t')
    }
    %}
    {% if ${unary ? getUnaryOp(lastVariableName, unary.operator) : getBinaryOp(lastVariableName, lastVariableName2, binary!.operator)} %}
  `, '{% endif %}']
}

function getUnaryOp(variableName: string, operator: UnariOperator): string {
  switch (operator) {
    case UnariOperator.TRUTHY: return `${variableName} and ${variableName} != blank and ${variableName} != empty`
    case UnariOperator.FALSY: return `not ${variableName}`
    case UnariOperator.EMPTY_ARR: return `${variableName}.size == 0`
    case UnariOperator.NOT_EMPTY_ARR: return `${variableName}.size > 0`
  }
}

function getBinaryOp(variableName: string, variableName2: string, operator: BinariOperator): string {
  switch (operator) {
    case BinariOperator.EQUAL: return `${variableName} == ${variableName2}`
    case BinariOperator.NOT_EQUAL: return `${variableName} != ${variableName2}`
    case BinariOperator.GREATER_THAN: return `${variableName} > ${variableName2}`
    case BinariOperator.LESS_THAN: return `${variableName} < ${variableName2}`
    case BinariOperator.GREATER_THAN_OR_EQUAL: return `${variableName} >= ${variableName2}`
    case BinariOperator.LESS_THAN_OR_EQUAL: return `${variableName} <= ${variableName2}`
  }
}

let numNextVar = 0
/**
 * Pagination data has no filter and no states in it
 */
export function getPaginationData(component: Component, expression: Property[]): string {
  const statement = getLiquidStatementProperties(component, expression)
  const firstToken = expression[0]
  if (firstToken) {
    if (!firstToken.dataSourceId || firstToken.dataSourceId === EleventyDataSourceId) {
      return statement
    }
    return `${firstToken.dataSourceId}.${statement}`
  } else {
    return ''
  }
}

/**
 * Convert an expression to liquid code
 */
export function getLiquidBlock(component: Component, expression: Expression): { variableName: string, liquid: string }[] {
  const token = expression[0];
  if (
    token.type === 'property' &&
    EXPRESSION_HANDLERS.block?.[token?.dataSourceId!]?.[token?.fieldId]
  ) {
    const ref = EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token);;
    return [
      {
        variableName: ref,
        liquid: ref
      }
    ]
  }
  if (expression.length === 0) return []
  expression = expression.slice();
  const result = [] as { variableName: string, liquid: string }[]
  const firstToken = expression[0]
  let lastVariableName = ''
  if (firstToken.type === 'filter') throw new Error('Expression cannot start with a filter')
  if (firstToken.type === 'property' && firstToken.dataSourceId && firstToken.dataSourceId !== 'eleventy') {
    const optVarName = getOptId(component, firstToken);
    const dsPropRef = `${firstToken.dataSourceId}.${getFieldId(component, firstToken)}`;
    const tempName = snakecase(dsPropRef + '_' + numNextVar++);
    const substitutionPairs: string = getSubstitutionOptions(component, firstToken);

    result.push({
      variableName: tempName,
      liquid: `assign ${tempName} = ${dsPropRef} | call_with_opts: ${optVarName}${substitutionPairs ? ', ' + substitutionPairs : ''}`
    });
    lastVariableName = tempName;
    // expression.splice(filters.length);
    expression.splice(0, 1);
  }
  const rest = [...expression]
  while (rest.length) {
    // Move all tokens until the first filter
    const firstFilterIndex = rest.findIndex(token => token.type === 'filter')
    const variableExpression = firstFilterIndex === -1 ? rest.splice(0) : rest.splice(0, firstFilterIndex)
    // Add all the filters until a property again
    const firstNonFilterIndex = rest.findIndex(token => token.type !== 'filter')
    const filterExpression = firstNonFilterIndex === -1 ? rest.splice(0) : rest.splice(0, firstNonFilterIndex)
    const variableName = getNextVariableName(component, numNextVar++)
    const statement = getLiquidStatement(component, variableExpression.concat(filterExpression), variableName, lastVariableName)
    lastVariableName = variableName
    result.push({
      variableName,
      liquid: statement,
    })
  }
  return result
}

export function getNextVariableName(component: Component, numNextVar: number): string {
  return `var_${component.ccid}_${numNextVar}`
}

/**
 * Get the liquid assign statement for the expression
 * The expression must
 * - start with a property or state
 * - once it has a filter it canot have a property again
 * - state can only be the first token
 * 
 * Example of return value: `countries.continent.countries | first.name`
 */
export function getLiquidStatement(component: Component, expression: Expression, variableName: string, lastVariableName: string = ''): string {
  if (expression.length === 0) throw new Error('Expression cannot be empty')
  // Split expression in 2: properties and filters
  const firstFilterIndex = expression.findIndex(token => token.type === 'filter')
  if (firstFilterIndex === 0) throw new Error('Expression cannot start with a filter')
  const properties = (firstFilterIndex < 0 ? expression : expression.slice(0, firstFilterIndex)) as (Property | State)[]
  const filters = firstFilterIndex > 0 ? expression.slice(firstFilterIndex) as Filter[] : []
  // Check that no properties or state come after filter
  if (filters.find(token => token.type !== 'filter')) {
    throw new Error('A filter cannot be followed by a property or state')
  }
  // Start with the assign statement
  return `assign ${variableName} = ${lastVariableName ? `${lastVariableName}.` : ''
    }${
    // Add all the properties
    getLiquidStatementProperties(component, properties)
    }${
    // Add all the filters
    getLiquidStatementFilters(component, filters)
    }`
}

export function getLiquidStatementProperties(component: Component, properties: (Property | State)[]): string {
  return properties.map((token, index) => {
    if (
      token.type === 'property' &&
      EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId]
    ) {
      return EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token);
    }
    switch (token.type) {
      case 'state': {
        if (index !== 0) throw new Error('State can only be the first token in an expression')
        return getStateVariableName(token.componentId, token.storedStateId)
      }
      case 'property': {
        if (token.fieldId === FIXED_TOKEN_ID) {
          return `"${token.options?.value ?? ''}"`
        }
        return token.fieldId;
      }
      default: {
        throw new Error(`Only state or property can be used in an expression, got ${(token as Token).type}`)
      }
    }
  })
    .join('.')
}

export function getLiquidStatementFilters(component: Component, filters: Filter[]): string {
  if (!filters.length) return ''
  return ' | ' + filters.map(token => {
    const options = token.options ? Object.entries(token.options)
      // Order the filter's options by the order they appear in the filter's optionsKeys
      .map(([key, value]) => ({
        key,
        value: value,
        order: token.optionsKeys?.indexOf(key),
      }))
      .sort((a, b) => {
        if (a.order === undefined && b.order === undefined) return 0
        if (a.order === undefined) return 1
        if (b.order === undefined) return -1
        return a.order - b.order
      })
      // Convert the options to liquid
      .map(({ key, value }) => handleFilterOption(component, token, key, value as string)) : []
    return `${token.filterName ?? token.id}${options.length ? `: ${options.join(', ')}` : ''}`
  })
    .join(' | ')
}

/**
 * Quote a string for liquid
 * Check that the string is not already quoted
 * Escape existing quotes
 */
function quote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function handleFilterOption(component: Component, filter: Filter, key: string, value: string): string {
  try {
    const expression = toExpression(value)
    if (expression) {
      const result = expression.map((token, idx) => {
        if (
          token.type === 'property' &&
          EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId]
        ) {
          return EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token);
        }
        switch (token.type) {
          case 'property': {
            if (token.fieldId === FIXED_TOKEN_ID) {
              return `"${token.options?.value ?? ''}"`
            }
            return token.fieldId;
          }
          case 'state': {
            return getStateVariableName(token.componentId, token.storedStateId)
          }
          case 'filter': {
            throw new Error('Filter cannot be used in a filter option')
          }
        }
      })
        .join('.')
      return filter.quotedOptions?.includes(key) ? quote(result) : result
    }
  } catch (e) {
    // Ignore
  }
  return filter.quotedOptions?.includes(key) ? quote(value) : value
}
export function getTokenDataSource(component: Component, token: Property) {
  const frame = component.frame!;
  if (!frame) throw new Error("Why no component frame...?");
  const editor = frame.em.Editor as DataSourceEditor;
  if (!editor) throw new Error("why no editor..?");
  const dataTree = editor.DataSourceManager.getDataTree();
  return dataTree.dataSources.find(ds => ds.id === token.dataSourceId);
}
export function getFieldId(component: Component, token: Property): any {
  if (!token.dataSourceId) return token.fieldId;

  const wrapper: Component | undefined = getWrapperComponent(component);
  if (!wrapper) throw new Error('why no wrapper?');

  const fieldIds = wrapper.get('fieldIds') || {};
  fieldIds[token.dataSourceId] ??= {};
  fieldIds[token.dataSourceId!][token.fieldId] ??= {}
  const key = (token.options ? OpenApi.toFieldId(token.dataSourceId, token.fieldId, JSON.stringify(token.options)) : '');
  fieldIds[token.dataSourceId!][token.fieldId][key] ??= { fieldId: token.fieldId + '_' + Object.values(fieldIds[token.dataSourceId!][token.fieldId]).length, options: token.options };
  wrapper.set('fieldIds', fieldIds);
  return fieldIds[token.dataSourceId!][token.fieldId][key].fieldId;
}
function getOptId(component, token) {
  return token.dataSourceId + '.' + getFieldId(component, token) + '__opts';
}
function getWrapperComponent(component: Component): Component | undefined {
  return component.frame?.getComponent?.();
}
/**
 * server side tokens:
 *  - fixed
 *  - http
 *  - state 
 */
/**
 * 
 * @param component 
 * @param firstToken 
 */
export function getSubstitutionOptions(component: Component, firstToken: StoredProperty): string {
  if (!firstToken.options) return '';
  const opts = firstToken.options;
  const parsed = parseEntries(opts);
  const serverSideFields = parsed.filter(
    ([k, expr]: [string, any]) =>
      isState(expr[0])
  );
  return serverSideFields.map(e => `"${e[0]}", ${getLiquidStatementProperties(component, e[1] as any)}`).join(', ')
}


