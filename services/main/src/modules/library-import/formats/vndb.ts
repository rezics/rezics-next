import { emptyRow, FILE_IMPORT_COST, FileImportInvalid, type CanonicalRow } from './contract.ts';
import { importRowBudget } from './bounds.ts';
import { sourceDate } from './csv.ts';
import { parseUploadedXml, xmlChildren as children, xmlText as text, retainedXml as retained } from './xml.ts';

/** Reader's native list-export/xml, version 1.0. Official implementation:
 * https://code.blicky.net/yorhel/vndb/src/branch/master/lib/VNWeb/ULists/Export.pm
 * checked 2026-10-01. Only the uploaded file is read; no account/API pull. */
export function parseVndb(file: string): CanonicalRow[] {
  const root = parseUploadedXml(file);
  if (root.tagName !== 'vndb-export' || root.getAttribute('version') !== '1.0') {
    throw new FileImportInvalid('Choose a VNDB list export version 1.0');
  }
  const rows: CanonicalRow[] = [];
  const admit = importRowBudget();
  const next = () => {
    // Reserve the final export metadata row before materializing more XML.
    if (rows.length >= FILE_IMPORT_COST.rows-1) throw new FileImportInvalid('Choose a file with at most 5,000 source rows');
  };
  const vns = children(root,'vns')[0];
  for (const vn of vns ? children(vns,'vn') : []) {
    next();
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
    rows.push(admit(row));
  }
  for (const [index,element] of (vns ? children(vns).filter(child => child.tagName !== 'vn') : []).entries()) {
    next();
    const row = emptyRow(`vns-extra:${index}`,'',{ xml: retained(element) }); row.kind = 'retained'; rows.push(admit(row));
  }
  // Notes, releases, length votes, account metadata, reviews and all XML
  // attributes remain private evidence even when they have no Library command.
  for (const container of children(root).filter(c => c.tagName !== 'vns')) {
    const entries = children(container);
    const known = container.tagName === 'reviews' || container.tagName === 'length-votes';
    for (const [index,element] of (known ? entries : [container]).entries()) {
      next();
      const vn = children(element,'vn')[0], id = container.tagName === 'length-votes' ? element.getAttribute('id') : vn?.getAttribute('id');
      const row = emptyRow(`${container.tagName}:${element.getAttribute('id') ?? index}`,vn?.textContent ?? text(element,'title'),{ xml: retained(element),
        containerAttributes: Object.fromEntries(Array.from(container.attributes).map(a => [a.name,a.value])) });
      row.kind = known && container.tagName === 'reviews' ? 'source' : 'retained';
      if (id && /^v[1-9][0-9]*$/.test(id)) row.identifiers = [{ provider: 'https://vndb.org/vn',value: id }];
      const review = text(element,'text');
      if (container.tagName === 'reviews' && review) row.review = { text: review,language: 'und',spoiler: element.getAttribute('spoiler') === 'true' };
      rows.push(admit(row));
    }
  }
  const metadata = emptyRow('vndb-export-metadata','',{ attributes: Object.fromEntries(Array.from(root.attributes).map(a => [a.name,a.value])),
    vnsAttributes: vns ? Object.fromEntries(Array.from(vns.attributes).map(a => [a.name,a.value])) : null });
  metadata.kind = 'retained'; rows.push(admit(metadata));
  return rows;
}
