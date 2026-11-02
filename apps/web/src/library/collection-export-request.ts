import type { FilterDocument } from '@rezics/filter';
import type { CollectionPageResult, CollectionReadProvenance } from './collection-load';
import type { CollectionPublicContext } from './collection-public-document';
import { LIBRARY_PAGE_LIMIT } from './reads';
import { validatePublicOrigin } from '../shell/origin';
import { subjectHref } from '../subject/subject-href';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';

export type ExportPopulation = readonly Readonly<{ id: string; subjectId: string; note: string | null }>[];
export type CollectionExportCapture = Readonly<{
  id: string;
  revision: number;
  provenance: CollectionReadProvenance;
  filter?: FilterDocument;
  dynamic: boolean;
  population: ExportPopulation;
}>;
export type CollectionExportFile = { filename: string; mediaType: string; text: string };
export type CollectionExportResult =
  | { state: 'complete'; file: CollectionExportFile }
  | { state: 'unavailable' | 'changed' | 'preparation-required' | 'cancelled' };
export type CollectionExportRead = (capture: CollectionExportCapture) => Promise<CollectionPageResult>;

/** Only a whole native page is admitted here; preparation must never be replaced with browser pagination. */
export function captureCollectionExport(page: CollectionPageResult): CollectionExportCapture | null {
  const dynamic = 'preparing' in page;
  if (
    !page.provenance ||
    !Number.isSafeInteger(page.revision) || page.revision! < 1 ||
    page.cursor || page.next !== null || page.members.length > LIBRARY_PAGE_LIMIT ||
    page.filterStatus || page.filterIgnored?.length ||
    (page.filterActive && !page.filter) ||
    (dynamic ? page.preparing || page.unavailable : page.memberState !== 'ready' || !page.firstPage) ||
    (!dynamic && page.filter !== undefined)
  ) return null;
  const population: ExportPopulation[number][] = [];
  for (const member of page.members) {
    if (!member.subject) return null;
    const id = 'id' in member ? member.id : member.subject.id;
    if (!id || !member.subject.id || population.some((entry) => entry.id === id)) return null;
    population.push({ id, subjectId: member.subject.id, note: 'note' in member ? member.note : null });
  }
  // A detached copy keeps retry bound to the admitted request, even if a caller mutates its page.
  return structuredClone({
    id: page.id,
    revision: page.revision!,
    provenance: page.provenance,
    ...(page.filter ? { filter: page.filter } : {}),
    dynamic,
    population,
  });
}

/** Treat all browser inputs as claims; only matching current native reads can authorize delivery. */
export function validateCollectionExportCapture(value: unknown): CollectionExportCapture {
  const capture = value as CollectionExportCapture | null;
  if (
    !capture || typeof capture !== 'object' ||
    typeof capture.id !== 'string' || !capture.id || capture.id.length > 128 ||
    !Number.isSafeInteger(capture.revision) || capture.revision < 1 ||
    typeof capture.dynamic !== 'boolean' ||
    !capture.provenance ||
    !['anonymous', 'session'].includes(capture.provenance.mode) ||
    (capture.provenance.mode === 'anonymous'
      ? capture.provenance.viewerId !== null
      : typeof capture.provenance.viewerId !== 'string' || !capture.provenance.viewerId) ||
    typeof capture.provenance.request !== 'string' ||
    !Array.isArray(capture.population) || capture.population.length > LIBRARY_PAGE_LIMIT ||
    capture.population.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id ||
      typeof entry.subjectId !== 'string' || !entry.subjectId ||
      (entry.note !== null && typeof entry.note !== 'string')) ||
    new Set(capture.population.map((entry) => entry.id)).size !== capture.population.length ||
    (!capture.dynamic && capture.filter !== undefined)
  ) throw new Error('Invalid Collection export capture');
  return structuredClone(capture);
}

function matches(capture: CollectionExportCapture, page: CollectionPageResult): boolean {
  const current = captureCollectionExport(page);
  return current !== null && JSON.stringify(current) === JSON.stringify(capture);
}

/** Two bounded native FULL reads: admission and terminal disclosure. No stored allow or partial file. */
export async function finishCollectionExport(
  capture: CollectionExportCapture,
  context: CollectionPublicContext,
  read: CollectionExportRead,
): Promise<CollectionExportResult> {
  try {
    const admitted = await read(capture);
    if (!matches(capture, admitted)) return { state: 'changed' };
    const terminal = await read(capture);
    if (!matches(capture, terminal)) return { state: 'changed' };
    const origin = validatePublicOrigin(context.origin);
    const items = terminal.members.map((member, index) => ({
      '@type': 'ListItem',
      identifier: capture.population[index]!.id,
      position: index + 1,
      ...('note' in member && member.note !== null ? { description: member.note } : {}),
      url: new URL(subjectHref({
        id: member.subject!.id,
        label: pageText(libraryTitleValue(member.subject!.label), context.locale).text,
      }, context.locale).href, origin).href,
    }));
    return { state: 'complete', file: {
      filename: `collection-${capture.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}.jsonld`,
      mediaType: 'application/ld+json',
      text: JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList',
        numberOfItems: items.length, itemListOrder: 'https://schema.org/ItemListOrderAscending',
        itemListElement: items }).replaceAll('<', '\\u003c'),
    } };
  } catch {
    return { state: 'unavailable' };
  }
}

/** Cancel retires one delivery; retry reuses the same detached capture and never recaptures the view. */
export class CollectionExportAttempt {
  private generation = 0;
  private readonly capture: CollectionExportCapture;
  constructor(capture: CollectionExportCapture) { this.capture = structuredClone(capture); }
  cancel() { this.generation++; }
  async run(request: (capture: CollectionExportCapture) => Promise<CollectionExportResult>): Promise<CollectionExportResult> {
    const generation = ++this.generation;
    let result: CollectionExportResult;
    try { result = await request(structuredClone(this.capture)); }
    catch { result = { state: 'unavailable' }; }
    return generation === this.generation ? result : { state: 'cancelled' };
  }
}
