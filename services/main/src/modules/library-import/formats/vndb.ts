import { DOMParser, type Element } from '@xmldom/xmldom';
import { emptyRow, FileImportInvalid, type CanonicalRow } from './contract.ts';
import { sourceDate } from './csv.ts';

/** Reader's native list-export/xml, version 1.0. Official implementation:
 * https://code.blicky.net/yorhel/vndb/src/branch/master/lib/VNWeb/ULists/Export.pm
 * checked 2026-10-01. Only the uploaded file is read; no account/API pull. */
const children = (element: Element, name?: string) => Array.from(element.childNodes)
  .filter((node): node is Element => node.nodeType === 1 && (!name || (node as Element).tagName === name));
const text = (element: Element, name: string) => children(element,name)[0]?.textContent?.trim() ?? '';
function retained(element: Element): unknown {
  let child = 0;
  return { name: element.tagName,attributes: Object.fromEntries(Array.from(element.attributes).map(a => [a.name,a.value])),
    text: children(element).length ? null : element.textContent,children: children(element).map(retained),
    // Preserve mixed text and element order without duplicating nested subtrees.
    content: Array.from(element.childNodes).map(node => node.nodeType === 1 ? { child: child++ }
      : { type: node.nodeType,value: node.nodeValue }) };
}
export function parseVndb(file: string): CanonicalRow[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(file)) throw new FileImportInvalid('XML entity declarations are unsupported');
  let malformed = false;
  let root: Element | null;
  try { root = new DOMParser({ onError: () => { malformed = true; } }).parseFromString(file,'application/xml').documentElement; }
  catch { throw new FileImportInvalid('Malformed VNDB export XML'); }
  if (malformed || !root || root.tagName !== 'vndb-export' || root.getAttribute('version') !== '1.0') {
    throw new FileImportInvalid('Choose a VNDB list export version 1.0');
  }
  const pending: Array<[Element,number]> = [[root,0]];
  let nodes = 0;
  while (pending.length) {
    const [element,depth] = pending.pop()!;
    if (++nodes > 50_000 || depth > 64) throw new FileImportInvalid('XML nesting or node count exceeds the import budget');
    pending.push(...children(element).map(child => [child,depth+1] as [Element,number]));
  }
  const rows: CanonicalRow[] = [];
  const vns = children(root,'vns')[0];
  for (const vn of vns ? children(vns,'vn') : []) {
    const id = vn.getAttribute('id');
    if (!id || !/^v[1-9][0-9]*$/.test(id)) throw new FileImportInvalid('VNDB row needs a VN identifier');
    const row = emptyRow(id,text(vn,'title'),{ xml: retained(vn) });
    row.identifiers = [{ provider: 'https://vndb.org/vn',value: id }];
    row.shelves = [...new Set(children(vn,'label').map(label => label.getAttribute('label') ?? '').filter(Boolean))];
    const statuses = { Playing: 'reading',Finished: 'read',Stalled: 'paused',Dropped: 'dnf',Wishlist: 'want-to-read' } as const;
    row.status = row.shelves.flatMap(label => Object.hasOwn(statuses,label) ? [statuses[label as keyof typeof statuses]] : [])[0] ?? null;
    row.startedOn = sourceDate(text(vn,'started')); row.finishedOn = sourceDate(text(vn,'finished'));
    const vote = Number(text(vn,'vote'));
    if (vote >= 1 && vote <= 10) row.score = { value: vote,min: 1,max: 10,step: 0.1 };
    rows.push(row);
  }
  for (const [index,element] of (vns ? children(vns).filter(child => child.tagName !== 'vn') : []).entries()) {
    const row = emptyRow(`vns-extra:${index}`,'',{ xml: retained(element) }); row.kind = 'retained'; rows.push(row);
  }
  // Notes, releases, length votes, account metadata, reviews and all XML
  // attributes remain private evidence even when they have no Library command.
  for (const container of children(root).filter(c => c.tagName !== 'vns')) {
    const entries = children(container);
    const known = container.tagName === 'reviews' || container.tagName === 'length-votes';
    for (const [index,element] of (known ? entries : [container]).entries()) {
      const vn = children(element,'vn')[0], id = container.tagName === 'length-votes' ? element.getAttribute('id') : vn?.getAttribute('id');
      const row = emptyRow(`${container.tagName}:${element.getAttribute('id') ?? index}`,vn?.textContent ?? text(element,'title'),{ xml: retained(element),
        containerAttributes: Object.fromEntries(Array.from(container.attributes).map(a => [a.name,a.value])) });
      row.kind = known && container.tagName === 'reviews' ? 'source' : 'retained';
      if (id && /^v[1-9][0-9]*$/.test(id)) row.identifiers = [{ provider: 'https://vndb.org/vn',value: id }];
      const review = text(element,'text');
      if (container.tagName === 'reviews' && review) row.review = { text: review,language: 'und',spoiler: element.getAttribute('spoiler') === 'true' };
      rows.push(row);
    }
  }
  const metadata = emptyRow('vndb-export-metadata','',{ attributes: Object.fromEntries(Array.from(root.attributes).map(a => [a.name,a.value])),
    vnsAttributes: vns ? Object.fromEntries(Array.from(vns.attributes).map(a => [a.name,a.value])) : null });
  metadata.kind = 'retained'; rows.push(metadata);
  return rows;
}
