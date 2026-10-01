import { emptyRow, FileImportInvalid, FILE_IMPORT_COST, type CanonicalRow } from './contract.ts';
import { sourceDate, sourceShelves } from './csv.ts';
import { parseUploadedXml, xmlChildren, xmlText, xmlAttributes, xmlContent, retainedXml } from './xml.ts';

/** Reader's native anime/manga list XML: https://myanimelist.net/panel.php?go=export
 * checked 2026-10-01 (export requires account access). Field mapping is guarded
 * by uploaded-file fixtures; no live MAL API calls or account scraping. */
const statuses = { Watching: 'reading',Reading: 'reading',Completed: 'read','On-Hold': 'paused',
  Dropped: 'dnf','Plan to Watch': 'want-to-read','Plan to Read': 'want-to-read' } as const;
function malDate(value: string) {
  // Zero components encode unknown precision, rather than the first day/month.
  return sourceDate(value.replace(/-00-00$/, '').replace(/-00$/, ''));
}
export function parseMal(file: string): CanonicalRow[] {
  const root = parseUploadedXml(file);
  if (root.tagName !== 'myanimelist') throw new FileImportInvalid('Choose a MyAnimeList anime or manga export');
  const rows: CanonicalRow[] = [];
  for (const element of xmlChildren(root)) {
    if (rows.length >= FILE_IMPORT_COST.rows) throw new FileImportInvalid('Choose a file with at most 5,000 source rows');
    if (element.tagName !== 'anime' && element.tagName !== 'manga') {
      const row = emptyRow(`mal-metadata:${rows.length}`,'',{ xml: retainedXml(element) });
      row.kind = 'retained'; rows.push(row); continue;
    }
    const anime = element.tagName === 'anime';
    const id = xmlText(element,anime ? 'series_animedb_id' : 'manga_mangadb_id');
    const title = xmlText(element,anime ? 'series_title' : 'manga_title');
    if (!/^[1-9][0-9]*$/.test(id) || !title) throw new FileImportInvalid('MyAnimeList row needs its identifier and title');
    const row = emptyRow(`${element.tagName}:${id}`,title,{ xml: retainedXml(element) });
    row.identifiers = [{ provider: `https://myanimelist.net/${element.tagName}`,value: id }];
    const status = xmlText(element,'my_status');
    row.status = Object.hasOwn(statuses,status) ? statuses[status as keyof typeof statuses] : null;
    row.startedOn = malDate(xmlText(element,'my_start_date')); row.finishedOn = malDate(xmlText(element,'my_finish_date'));
    const score = Number(xmlText(element,'my_score'));
    if (Number.isInteger(score) && score >= 1 && score <= 10) row.score = { value: score,min: 1,max: 10,step: 1 };
    row.shelves = sourceShelves(xmlText(element,'my_tags'));
    const comments = xmlText(element,'my_comments');
    if (comments) row.review = { text: comments,language: 'und',spoiler: false };
    const times = xmlText(element,anime ? 'my_times_watched' : 'my_times_read'), count = Number(times);
    if (times && Number.isSafeInteger(count) && count >= 0) row.readCount = count;
    // Chapters, volumes and episodes are source evidence, never page locators.
    // Repeat counters lack attempt dates and cannot create additional sessions.
    rows.push(row);
  }
  if (!rows.some(row => row.kind === 'source')) throw new FileImportInvalid('MyAnimeList export has no list entries');
  const metadata = emptyRow('mal-export-metadata','',{ attributes: xmlAttributes(root),content: xmlContent(root) });
  metadata.kind = 'retained'; rows.push(metadata);
  return rows;
}
