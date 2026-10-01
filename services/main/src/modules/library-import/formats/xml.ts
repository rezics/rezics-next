import { DOMParser, type Element } from '@xmldom/xmldom';
import { FileImportInvalid, FILE_IMPORT_COST } from './contract.ts';

export const xmlChildren = (element: Element, name?: string) => Array.from(element.childNodes)
  .filter((node): node is Element => node.nodeType === 1 && (!name || (node as Element).tagName === name));
export const xmlText = (element: Element, name: string) => xmlChildren(element,name)[0]?.textContent?.trim() ?? '';
export const xmlAttributes = (element: Element) => Object.fromEntries(Array.from(element.attributes).map(a => [a.name,a.value]));
export function xmlContent(element: Element) {
  let child = 0;
  return Array.from(element.childNodes).map(node => node.nodeType === 1 ? { child: child++ }
    : { type: node.nodeType,value: node.nodeValue });
}
export function retainedXml(element: Element): unknown {
  return { name: element.tagName,attributes: xmlAttributes(element),
    text: xmlChildren(element).length ? null : element.textContent,children: xmlChildren(element).map(retainedXml),
    content: xmlContent(element) };
}

/** Inert uploaded XML only: no DTDs, entities or network resolution. The pinned
 * maintained DOM parser handles XML syntax; bounded traversal protects all adapters. */
export function parseUploadedXml(file: string): Element {
  if (new TextEncoder().encode(file).length > FILE_IMPORT_COST.bytes) throw new FileImportInvalid('File exceeds 2 MiB');
  if (/<!DOCTYPE|<!ENTITY/i.test(file)) throw new FileImportInvalid('XML entity declarations are unsupported');
  let malformed = false;
  let root: Element | null;
  try { root = new DOMParser({ onError: () => { malformed = true; } }).parseFromString(file,'application/xml').documentElement; }
  catch { throw new FileImportInvalid('Malformed export XML'); }
  if (malformed || !root) throw new FileImportInvalid('Malformed export XML');
  const pending: Array<[Element,number]> = [[root,0]];
  while (pending.length) {
    const [element,depth] = pending.pop()!;
    // Real MAL rows carry dozens of fields and whitespace nodes. Bytes and
    // list-entry counts bound total work; only nesting needs a separate guard.
    if (depth > 64) throw new FileImportInvalid('XML nesting exceeds the import budget');
    for (const child of xmlChildren(element)) pending.push([child,depth+1]);
  }
  return root;
}
