import { StoredToken, Token } from "@silexlabs/grapesjs-data-source/src/types";
import { ArrayExpression, Expression, Literal, Node, ObjectExpression } from "estree";

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
export function isFixed(tok: Token): boolean {
  return tok.type === 'property' && tok.fieldId === 'fixed';
}
export function isHttp(tok: Token): boolean {
  return tok.type === 'property' && tok.dataSourceId === 'http';
}

export function isState(tok: Token): boolean {
  return tok.type === 'state';
}

export function replaceAstExpressions(_v: Node | null, evaluate: (_: Literal, opts: any) => any, path?: string[]): Node | null {
  path ??= [];
  if (!_v) return _v;
  if (_v.type === 'SpreadElement') {
    const v = { ..._v }
    v.argument = replaceAstExpressions(v.argument, evaluate, path) as Expression;
    return v;
  }
  if (_v.type === 'ObjectExpression') {

    /**
     * @type {import('estree').ObjectExpression}
    */
    const v = { ..._v }
    const toRemove = new Set<number>();
    let idx = 0;
    for (const prop of v.properties) {
      if (prop.type === 'Property' && prop.key.type === 'Literal' && typeof prop.key.value === 'string') {


        if (prop.value.type === 'Literal') {

          if (v.properties.length === 1 && prop.key.type === 'Literal' && prop.key.value === '#expr') {
            return evaluate(prop.value, { path })
          }
          else if (prop.key.type === 'Literal' && prop.key.value.charAt(0) === '#') {
            prop.key.value = prop.key.value.slice(1);
            prop.value = evaluate(prop.value, { path });
            if (typeof prop.value !== 'object') {
              toRemove.add(idx);
            }
          }
        }
        prop.value = replaceAstExpressions(prop.value, evaluate, [...path, prop.key.value])! as Expression;
      }
      else if (prop.type === 'SpreadElement') prop.argument = replaceAstExpressions(prop.argument, evaluate, path)! as Expression;
      idx++;
    }
    v.properties = v.properties.filter((_, idx) => !toRemove.has(idx));
    return v;
  } else if (_v.type === 'ArrayExpression') {
    /**
    * @type {import('estree').ArrayExpression}
   */
    const v = { ..._v }
    v.elements = v.elements.map((el, idx) => replaceAstExpressions(el, evaluate, [...path, '' + idx]) as Expression)
    return v;
  }
  return _v;

}
export function replaceObjectExpressions(v, evaluate: (p, opts) => any, path?: string[]) {
  path ??= [];
  evaluate ??= v => "evaluate " + JSON.stringify(v)
  const replace = (v, p) => replaceObjectExpressions(v, evaluate, [...path, p]);
  if (Array.isArray(v)) {
    return v.map(replace);
  }
  else if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '#expr') {
      return evaluate(v["#expr"], { path });
    }
    const ret = {};
    for (let key in v) {
      console.log({ key, v });
      if (!v[key]) continue;
      if (key.charAt(0) === '#') {
        const value = evaluate(replace(v[key], key.slice(1)), { path: [...path, key.slice(1)] });
        if (value) ret[key.slice(1)] = value;
      } else ret[key] = replace(v[key], key)
    }
    return ret;
  } else {
    return v;
  }
}