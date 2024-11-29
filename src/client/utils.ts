import { StoredToken, Token } from "@silexlabs/grapesjs-data-source/src/types";

export function tryParse(arg0: string): any {
  try {
    return (arg0 as string).trim().charAt(0) === '[' ? JSON.parse(arg0) : arg0
  } catch (e) {
    return arg0;
  }
}

export function parseEntries(options: any): [string, StoredToken[]][] {
  return Object.entries(options)
    .map(e => [e[0], tryParse(e[1] as any)])
    .filter(e => e[1].length) as any;
}
export function isFixed(tok:Token):boolean {
  return tok.type === 'property' && tok.fieldId === 'fixed';
}
export function isHttp(tok:Token):boolean {
  return tok.type === 'property' && tok.dataSourceId === 'http';
}

export function isState(tok:Token):boolean {
  return tok.type === 'state';
}

/**
 * 
 * @param {import('estree').ObjectExpression|import('estree').ArrayExpression} _v
 * @param evaluate 
 */
export function replaceAstExpressions(_v, evaluate) {
  if (_v.type === 'ObjectExpression') {

      /**
       * @type {import('estree').ObjectExpression}
      */
      const v = { ..._v }
      for (const prop of v.properties) {
          if (prop.type === 'Property' && prop.value.type === 'Literal') {

              if (v.properties.length === 1 && prop.key.type === 'Literal' && prop.key.value === '#expr') {
                  return evaluate(prop.value)
              }
              else if (prop.key.type === 'Literal' && prop.key.value.charAt(0) === '#') {
                  prop.key.value = prop.key.value.slice(1);
                  prop.value = evaluate(prop.value);
              }
          }
          prop.value = replaceAstExpressions(prop.value, evaluate)
      }
      return v;
  } else if (_v.type === 'ArrayExpression') {
      /**
      * @type {import('estree').ArrayExpression}
     */
      const v = { ..._v }
      v.elements = v.elements.map(el => replaceAstExpressions(el, evaluate));
      return v;
  }
  return _v;

}
export function replaceObjectExpressions(v, evaluate) {
  evaluate ??= v => "evaluate " + JSON.stringify(v)
  const replace = v => replaceObjectExpressions(v, evaluate);
  if (Array.isArray(v)) {
      return v.map(replace);
  }
  else if (typeof v === 'object' && v !== null) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '#expr') {
          return evaluate(v["#expr"]);
      }
      const ret = {};
      for (const key in v) {
          console.log({key});
          if (key.charAt(0) === '#') {
              ret[key] = evaluate(replace(v[key]));
          } else ret[key] = replace(v[key])
      }
      return ret;
  } else {
      return v;
  }
}