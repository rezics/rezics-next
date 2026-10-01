import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId } from '../../work/read-contract.ts';
import { sessionDate, sessionStatus, selectionInput, sessionLocator } from '../../session/contract.ts';

export const FILE_IMPORT_COST = { bytes: 2 * 1024 * 1024, rowBytes: 1024 * 1024, rows: 5_000, columns: 64,
  cellCharacters: 20_000, page: 8, statuses: 50, searchPages: 4, candidates: 80 } as const;
const closed = { additionalProperties: false };
export const sourceStatus = t.Union([t.Literal('want-to-read'), t.Literal('reading'), t.Literal('read'), t.Literal('paused'), t.Literal('dnf')]);
export const csvMapping = t.Object({ title: t.String({ minLength: 1 }),
  author: t.Optional(t.String()), status: t.Optional(t.String()), progress: t.Optional(t.String()),
  progressUnit: t.Optional(t.Union([t.Literal('page'), t.Literal('percentage')])),
  startedOn: t.Optional(t.String()), finishedOn: t.Optional(t.String()),
  statuses: t.Record(t.String(), t.Nullable(sourceStatus)) }, closed);
export type CsvMapping = Static<typeof csvMapping>;
export const portableSession = t.Object({ target: readId, state: sessionStatus,
  startedOn: sessionDate, finishedOn: sessionDate,
  selections: t.Array(selectionInput, { minItems: 1, maxItems: 16 }),
  locators: t.Array(sessionLocator, { maxItems: 16 }) }, closed);
export const canonicalRow = t.Object({
  kind: t.Union([t.Literal('source'), t.Literal('entry'), t.Literal('session'), t.Literal('shelf'), t.Literal('retained')]),
  sourceId: t.String({ minLength: 1, maxLength: 1000 }), title: t.String({ maxLength: 20_000 }),
  creators: t.Array(t.String(), { maxItems: 64 }), work: t.Nullable(readId), target: t.Nullable(readId),
  identifiers: t.Array(t.Object({ provider: t.String(), value: t.String() }, closed), { maxItems: 64 }),
  status: t.Nullable(sourceStatus), startedOn: sessionDate, finishedOn: sessionDate,
  score: t.Nullable(t.Object({ value: t.Number(), min: t.Number(), max: t.Number(), step: t.Number({ exclusiveMinimum: 0 }) }, closed)),
  review: t.Nullable(t.Object({ text: t.String({ maxLength: 8000 }), language: t.String(), spoiler: t.Boolean() }, closed)),
  shelves: t.Array(t.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
  readCount: t.Nullable(t.Integer({ minimum: 0 })),
  progress: t.Nullable(t.Object({ unit: t.Union([t.Literal('page'), t.Literal('percentage')]), value: t.Number({ minimum: 0 }) }, closed)),
  session: t.Nullable(portableSession), raw: t.Record(t.String(), t.Unknown()),
}, closed);
export type CanonicalRow = Static<typeof canonicalRow>;
export type LibraryFileFormat = 'goodreads' | 'storygraph' | 'generic-csv' | 'vndb' | 'mal' | 'rezics';
export type FormatAdapter = (file: string, mapping?: CsvMapping) => CanonicalRow[];
export class FileImportInvalid extends Error {}
export class FileImportUnsupported extends Error {}
export function emptyRow(sourceId: string, title: string, raw: Record<string, unknown>): CanonicalRow {
  return { kind: 'source', sourceId, title, creators: [], work: null, target: null, identifiers: [],
    status: null, startedOn: null, finishedOn: null, score: null, review: null, shelves: [],
    readCount: null, progress: null, session: null, raw };
}
