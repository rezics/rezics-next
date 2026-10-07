import { FILE_IMPORT_COST, FileImportInvalid } from './contract.ts';

/** The bounded CSV state machine is shared with the legacy browser import;
 * RFC 4180 https://www.rfc-editor.org/rfc/rfc4180 checked 2026-10-01. */
export function csvRecords(file: string): { headers: string[]; records: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, ended = false;
  const pushCell = () => { row.push(cell); cell = ''; ended = false;
    if (row.length > FILE_IMPORT_COST.columns) throw new FileImportInvalid('CSV has more than 64 columns'); };
  const pushRow = () => { pushCell(); if (row.some(v => v.trim())) rows.push(row); row = [];
    if (rows.length > FILE_IMPORT_COST.rows + 1) throw new FileImportInvalid('File has more than 5,000 rows'); };
  file = file.replace(/^\uFEFF/, '');
  for (let i = 0; i < file.length; i++) {
    const ch = file[i]!;
    if (quoted) {
      if (ch === '"') { if (file[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; ended = true; } }
      else cell += ch;
    } else if (ch === ',' ) pushCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && file[i + 1] === '\n') i++; pushRow(); }
    else if (ch === '"' && !cell && !ended) quoted = true;
    else { if (ended || ch === '"') throw new FileImportInvalid('Malformed CSV quote'); cell += ch; }
    if (cell.length > FILE_IMPORT_COST.cellCharacters) throw new FileImportInvalid('CSV cell exceeds 20,000 characters');
  }
  if (quoted) throw new FileImportInvalid('Unclosed CSV quote');
  pushRow();
  if (rows.length < 2) throw new FileImportInvalid('File has no data rows');
  const headers = rows.shift()!.map(v => v.trim());
  if (headers.some(v => !v) || new Set(headers).size !== headers.length) throw new FileImportInvalid('CSV headers must be distinct and nonempty');
  const headerBytes = 2 + headers.reduce((bytes,header) => bytes+Buffer.byteLength(JSON.stringify(header))+2,0);
  let evidenceBytes = 0;
  return { headers, records: rows.map((values, index) => {
    if (values.length > headers.length) throw new FileImportInvalid(`CSV row ${index + 2} has extra cells`);
    const bytes = headerBytes + headers.reduce((size,_header,i) => size+Buffer.byteLength(JSON.stringify(values[i] ?? '')),0);
    if (bytes > FILE_IMPORT_COST.rowBytes) throw new FileImportInvalid('CSV row exceeds its evidence byte budget');
    evidenceBytes += bytes;
    if (evidenceBytes > FILE_IMPORT_COST.parsedBytes) throw new FileImportInvalid('Parsed CSV evidence exceeds its byte budget');
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  }) };
}
export function sourceDate(raw: string): string | null {
  const value = raw.trim().replaceAll('/', '-');
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) || value.startsWith('0000')) return null;
  const parts = value.split('-'), full = `${parts[0]}-${parts[1] ?? '01'}-${parts[2] ?? '01'}`;
  const parsed = new Date(`${full}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === full ? value : null;
}
export function sourceIsbn(raw: string): string | null {
  let value = raw.replace(/^="?/, '').replace(/"$/, '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const checksum = (digits: string) => (10 - [...digits].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  if (/^\d{9}[\dX]$/.test(value)) {
    if ([...value].reduce((n, d, i) => n + (10 - i) * (d === 'X' ? 10 : Number(d)), 0) % 11) return null;
    value = `978${value.slice(0, 9)}`; value += checksum(value);
  }
  return /^\d{13}$/.test(value) && checksum(value.slice(0, 12)) === Number(value[12]) ? value : null;
}
export function sourceShelves(raw: string): string[] {
  const names = [...new Set(raw.split(',').map(v => v.trim()).filter(Boolean))];
  if (names.length > 20 || names.some(v => v.length > 300)) throw new FileImportInvalid('Row has too many or oversized shelves');
  return names;
}
