import { Expression, FIXED_TOKEN_ID, Filter, Property, State, StateId, Token, getPersistantId, getStateVariableName, DataTree, BinariOperator, UnariOperator, getExpressionResultType, toExpression, DataSourceEditor, StoredProperty, StoredFilter } from '@silexlabs/grapesjs-data-source'
import { Component } from 'grapesjs'
import { EleventyDataSourceId } from './DataSource'
import OpenApi from '@silexlabs/grapesjs-data-source/src/datasources/OpenApi'
import snakecase from 'snakecase';
import { isFixed, isHttp, isState, parseEntries, replaceObjectExpressions } from './utils';
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
function reify(e) {
  return e?.length ? e/* .concat({
    type: "filter",
    id: "json",
    filterName: "json"
  } as StoredFilter)  */: [];
}
function reifyBlock(component, b) {
  const last = b[b.length - 1];
  const v = getNextVariableName(component, numNextVar++);
  return [...b, {
    variableName: v,
    liquid: `assign ${v} = ${last.variableName} | json`
  }];
}
function getLiquidBlockReified(component: Component, e: Expression) {
  return reifyBlock(component, getLiquidBlock(component, (e)));
}
const EXPRESSION_HANDLERS = {
  inline: {
    "core": {
      ...Object.fromEntries(['string', 'date', 'bool', 'number'].map(v => [v, (component: Component, token: Property) => {
        if (!token.options?.value) throw new Error("`value` is requird.");
        const parsed = Object.fromEntries(parseEntries(token.options));
        const value = getLiquidBlock(component, parsed.value);
        const last = `${value[value.length - 1].variableName} | ${v}`
        const variableName = getNextVariableName(component, numNextVar++);
        return [...value, {
          variableName, liquid: last
        }]
      }])),
      "ternary"(component: Component, token: Property) {
        if (!token.options?.consequent || !token.options?.testLeft) throw new Error("`testLeft` and `consequent` required for ternaries");
        const parsed = Object.fromEntries(parseEntries(token.options));
        const testRight = getLiquidBlockReified(component, parsed.testRight);
        const testOp = parsed.testOp;
        const testLeft = getLiquidBlockReified(component, parsed.testLeft);
        const consequent = getLiquidBlock(component, parsed.consequent);
        const alternate = getLiquidBlock(component, parsed.alternate);
        const last = `${testLeft[testLeft.length - 1].variableName} | ternary: "${testOp}", ${testRight[testRight.length - 1].variableName}, ${consequent[consequent.length - 1].variableName}, ${alternate[alternate.length - 1].variableName}`
        const variableName = getNextVariableName(component, numNextVar++);
        return [...testLeft, ...testRight, ...consequent, ...alternate, {
          variableName, liquid: last
        }]
      },
      "binop"(component: Component, token: Property) {
        if (!token.options?.left || !token.options?.right || !token.options?.op) throw new Error("`left`,`op` and `right` required for binops");
        const parsed = Object.fromEntries(parseEntries(token.options));
        const left = getLiquidBlockReified(component, parsed.left);
        const right = getLiquidBlockReified(component, parsed.right);
        const last = `${left[left.length - 1].variableName} | binop: "${token.options.op}", ${right[right.length - 1].variableName}`;
        const variableName = getNextVariableName(component, numNextVar++);
        return [...left, ...right, {
          variableName, liquid: last
        }]
      },
      "unop"(component: Component, token: Property) {
        if (!token.options?.argument || !token.options?.op) throw new Error("`op` and `argument` required for unops");
        const parsed = Object.fromEntries(parseEntries(token.options));
        const argument = getLiquidBlockReified(component, parsed.argument);
        const last = `${argument[argument.length - 1].variableName} | unop: "${token.options.op}"`;
        const variableName = getNextVariableName(component, numNextVar++);
        return [...argument, {
          variableName, liquid: last
        }]
      },
      "json"(component: Component, token: Property) {
        if (!token.options?.value) throw new Error("`value` is required");
        const fieldId = getFieldId(component, token);
        const replacements: [string, string][] = [];
        const parsed = JSON.parse(token.options.value as string);
        replaceObjectExpressions(parsed, (v, opts) => {
          if (!v) return v;
          try {
            console.log("encountered", ...arguments);
            const expr: Expression = JSON.parse(v);
            if (expr[0].type === 'state') {
              replacements.push([opts.path.join('/'), getLiquidStatementProperties(component, expr as any)]);
              return;
            }
          } catch (e) {
            console.error("Error parsing JSON token", token, e)
            return;
          }
          return v;
        });
        const last = 'core.' + fieldId + (replacements.length ? ` | with_patches: ${replacements
          .map(
            ([path, replacement]) => ['"' + path + '"', replacement].join(',')
          ).join(',')}` : '');

        const variableName = getNextVariableName(component, numNextVar++);
        return [{
          variableName,
          liquid: `${last}`
        }]
      }
    },
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
      },
      "get_env"(component: Component, token: Property) {
        if (!token?.options?.key) throw new Error("`key` is required.");
        return `env.${token.options.key}`
      }
    }
  },
  // isolated: {
  //   "core": {
  //     "unop"(component: Component, token: Property) {
  //       const r = EXPRESSION_HANDLERS.inline.core.unop(component, token);
  //       return justGetLiquid(r);
  //     },
  //     "binop"(component: Component, token: Property) {
  //       const r = EXPRESSION_HANDLERS.inline.core.binop(component, token);
  //       return justGetLiquid(r);
  //     },
  //     "ternary"(component: Component, token: Property) {
  //       const r = EXPRESSION_HANDLERS.inline.core.ternary(component, token);
  //       return justGetLiquid(r);
  //     },
  //     "json"(component: Component, token: Property) {
  //       const r = EXPRESSION_HANDLERS.inline.core.json(component, token);
  //       return justGetLiquid(r);
  //     },
  //   },
  //   "http": {

  //     "get_session"(component: Component, token: Property) {
  //       if (!token?.options?.key) throw new Error("`key` is required.");
  //       return `session.${token.options.key}`
  //     },
  //     "get_body"(component: Component, token: Property) {
  //       if (!token?.options?.key) throw new Error("`key` is required.");
  //       return `body.${token.options.key}`
  //     },
  //     "get_query"(component: Component, token: Property) {
  //       if (!token?.options?.key) throw new Error("`key` is required.");
  //       return `query.${token.options.key}`
  //     },
  //     "get_cookie"(component: Component, token: Property) {
  //       if (!token?.options?.key) throw new Error("`key` is required.");
  //       return `cookies.${token.options.key}`
  //     },
  //     "get_local"(component: Component, token: Property) {
  //       if (!token?.options?.key) throw new Error("`key` is required.");
  //       return `locals.${token.options.key}`
  //     }
  //   },

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
  // if (
  //   firstTok.type === 'property' &&
  //   EXPRESSION_HANDLERS.isolated?.[firstTok.dataSourceId!]?.[firstTok.fieldId]
  // ) {
  //   return '{% liquid \n' + EXPRESSION_HANDLERS.isolated?.[firstTok.dataSourceId!]?.[firstTok.fieldId](component, firstTok) + '\n %}';
  // }
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
  // if (
  //   firstTok.type === 'property' &&
  //   EXPRESSION_HANDLERS.isolated?.[firstTok.dataSourceId!]?.[firstTok.fieldId]
  // ) {
  //   return '{% ' + EXPRESSION_HANDLERS.isolated?.[firstTok.dataSourceId!]?.[firstTok.fieldId](component, firstTok) + ' %}';
  // }
  const statements = getLiquidBlock(component, expression)
  return `{% ${statements
    .flatMap(({ liquid }) => liquid.split('\n'))
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
  // if (!field) throw new Error(`Expression ${expression.map(token => token.label).join(' -> ')} is invalid`)
  // if (field.kind !== 'list') throw new Error(`Provided property needs to be a list in order to loop, not a ${field.kind}`)
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
function justGetLiquid(stmt) {
  return Array.isArray(stmt) ? stmt[stmt.length - 1].liquid : stmt;
}
/**
 * Convert an expression to liquid code
 */
export function getLiquidBlock(component: Component, expression: Expression): { variableName: string, liquid: string }[] {
  if (!expression || !expression.length) return [{ variableName: 'EMPTY', liquid: "" }];
  const token = expression[0];
  const result = [] as { variableName: string, liquid: string }[]
  if (expression.length === 0) return []
  expression = expression.slice();
  const firstToken = expression[0]
  let lastVariableName = ''
  if (
    token.type === 'property' &&
    EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId]
  ) {
    const stmt = EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token);;
    if (Array.isArray(stmt)) {
      result.push(...stmt)
      const last = result[result.length - 1];
      last.liquid = `assign ${last.variableName} = ${last.liquid}`
      result.push({
        liquid: '',
        variableName: last.variableName,
      })
    } else {
      result.push({
        variableName: stmt,
        liquid: ''
      });
    }
    expression.splice(0, 1);
    // return [
    //   {
    //     variableName: ref,
    //     liquid: ref
    //   }
    // ]

  }

  else if (firstToken.type === 'filter') throw new Error('Expression cannot start with a filter')
  else if (firstToken.type === 'property' && firstToken.dataSourceId && firstToken.dataSourceId !== 'eleventy') {
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
  const [prepend, filterStr] = getLiquidStatementFilters(component, filters);
  return prepend + `assign ${variableName} = ${lastVariableName ? `${lastVariableName}.` : ''
    }${
    // Add all the properties
    getLiquidStatementProperties(component, properties)
    }${
    // Add all the filters
    filterStr
    }`
}

export function getLiquidStatementProperties(component: Component, properties: (Property | State)[]): string {
  return properties.map((token, index) => {
    if (
      token.type === 'property' &&
      EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId]
    ) {
      return justGetLiquid(EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token));
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

export function getLiquidStatementFilters(component: Component, filters: Filter[]): [string, string] {
  if (!filters.length) return ['', '']
  let prepend = [];
  const filterStr = ' | ' + filters.map(token => {
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
      .map(({ key, value }) => handleFilterOption(component, token, key, value as string, prepend)) : []
    return `${token.filterName ?? token.id}${options.length ? `: ${options.join(', ')}` : ''}`
  })
    .join(' | ')
  return [prepend.length ? '\n' + prepend.join('\n') + '\n' : '', filterStr];
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

function handleFilterOption(component: Component, filter: Filter, key: string, value: string, prepend: string[]): string {
  try {
    const expression = toExpression(value)
    if (expression) {
      const result = expression.map((token, idx) => {
        if (
          token.type === 'property' &&
          EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId]
        ) {
          const res = EXPRESSION_HANDLERS.inline?.[token?.dataSourceId!]?.[token?.fieldId](component, token);
          if (Array.isArray(res)) {

            const last = res.pop();
            res.forEach(e => {
              prepend.push(e.liquid);
            });
            prepend.push(`\nassign ${last.variableName} = ${last.liquid}`);
            return last.variableName
          }
          return res;
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
    console.error("Error generating filter option:", e);
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
  if (true || !firstToken.options) return '';
  const opts = firstToken.options;
  const parsed = parseEntries(opts);
  const serverSideFields = parsed.filter(
    ([k, expr]: [string, any]) =>
      isState(expr[0])
  );
  // const parsedObj = Object.fromEntries(parsed);
  const jsonProps: any = parsed.map(([k, v]) => {
    const tok = v[0];
    if (tok.type === 'property' && tok.dataSourceId === 'core' && tok.fieldId === 'json') {
      return [k, JSON.parse(tok.options?.value as string)]
    }
  }).filter(Boolean)
  jsonProps.forEach(([trunk, parsedObj]) => replaceObjectExpressions(parsedObj, (v, { path }) => {
    if (!v) return v;
    console.log("encountered", ...arguments);

    try {
      const expr = JSON.parse(v);
      if (isState(expr[0])) {
        serverSideFields.push([[trunk, ...path].join('/'), expr])
      }
    } catch (e) {
      console.error("Failed to parse JSON token:", v, path, e);
    }
  }));
  return serverSideFields.map(e => `"${e[0]}", ${getLiquidStatementProperties(component, e[1] as any)}`).join(', ')
}


