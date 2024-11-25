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