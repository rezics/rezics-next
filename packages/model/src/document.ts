import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';

/** Legacy BlockNote-shaped snapshot; new authoring uses the independent @rezics/document contract. */
export const documentVersion = 'rezics-blocks-v1' as const;
const id = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' });
// Language interpretation belongs to Main's one language module, not this package.
const lang = Type.String({ minLength: 1, maxLength: 256 });
const closed = { additionalProperties: false };

// Each origin pins an ID in exact source bytes, rather than today's head or matching text.
export const BlockLineageSchema = Type.Refine(Type.Object({
  kind: Type.Union([Type.Literal('copy'), Type.Literal('split'), Type.Literal('merge')]),
  origins: Type.Array(Type.Object({ id, digest }, closed), { minItems: 1, uniqueItems: true }),
}, closed), value => value.kind === 'merge' ? value.origins.length >= 2 : value.origins.length === 1);
export type BlockLineage = Static<typeof BlockLineageSchema>;

const marks = Type.Array(Type.Object({
  type: Type.Literal('emphasis'),
  style: Type.Optional(Type.Union([Type.Literal('dot'), Type.Literal('sesame'), Type.Literal('circle')])),
  position: Type.Optional(Type.Union([Type.Literal('over'), Type.Literal('under')])),
}, closed));
export const InlineTextSchema = Type.Object({
  type: Type.Literal('text'), text: Type.String(),
  styles: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.String(), Type.Number()])),
  lang: Type.Optional(lang), marks: Type.Optional(marks),
}, { additionalProperties: true });
export type InlineText = Static<typeof InlineTextSchema>;

// BlockNote's block/text/link structure, reviewed 2026-09-30:
// https://www.blocknotejs.org/docs/foundations/document-structure
// Ruby and cell IDs are REZICS extensions; editor adapters must preserve them.
const inlineTypes = new Set(['text', 'link', 'ruby']);
export const InlineContentSchema = Type.Union([
  InlineTextSchema,
  Type.Object({ type: Type.Literal('link'), href: Type.String(),
    content: Type.Array(InlineTextSchema), lang: Type.Optional(lang) }, { additionalProperties: true }),
  Type.Object({ type: Type.Literal('ruby'), content: Type.Array(InlineTextSchema),
    annotation: Type.Array(InlineTextSchema), lang: Type.Optional(lang) }, { additionalProperties: true }),
  Type.Object({ type: Type.Refine(id, value => !inlineTypes.has(value)),
    lang: Type.Optional(lang) }, { additionalProperties: true }),
]);
export type InlineContent = Static<typeof InlineContentSchema>;

export const TableCellSchema = Type.Object({
  id, type: Type.Literal('tableCell'), content: Type.Array(InlineContentSchema),
  props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  lineage: Type.Optional(BlockLineageSchema),
}, { additionalProperties: true });
export type TableCell = Static<typeof TableCellSchema>;
export const TableContentSchema = Type.Object({
  type: Type.Literal('tableContent'),
  columnWidths: Type.Optional(Type.Array(Type.Union([Type.Number({ minimum: 0 }), Type.Null()]))),
  headerRows: Type.Optional(Type.Integer({ minimum: 0 })),
  headerCols: Type.Optional(Type.Integer({ minimum: 0 })),
  rows: Type.Array(Type.Object({ cells: Type.Array(TableCellSchema) }, { additionalProperties: true })),
}, { additionalProperties: true });
export type TableContent = Static<typeof TableContentSchema>;

export const knownBlockTypes = [
  'paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem',
  'toggleListItem', 'codeBlock', 'table', 'image', 'video', 'audio', 'file', 'divider',
] as const;
const known = new Set<string>(knownBlockTypes);

export interface DocumentBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DocumentBlock[];
  lineage?: BlockLineage;
  [extension: string]: unknown;
}

const blockFields = {
  id, type: id, props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  content: Type.Optional(Type.Unknown()),
  children: Type.Optional(Type.Array(Type.Ref('Block'))),
  lineage: Type.Optional(BlockLineageSchema),
};
export const DocumentBlockSchema = Type.Unsafe<DocumentBlock>(Type.Cyclic({
  Block: Type.Refine(Type.Object(blockFields, { additionalProperties: true }), block => {
    if (!known.has(block.type) || block.content === undefined) return true;
    return Value.Check(block.type === 'table' ? TableContentSchema : Type.Array(InlineContentSchema), block.content);
  }),
}, 'Block'));

export interface DocumentSnapshot {
  version: typeof documentVersion;
  blocks: DocumentBlock[];
}

/** O(JSON tree size), without coercion, stripping, normalizing or cloning fields. */
function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, descriptor]) =>
    !(Array.isArray(value) && key === 'length') && (!descriptor.enumerable || !('value' in descriptor)))) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) && isJson(value[i], ancestors)).every(Boolean)
    : Object.values(value).every(item => isJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function uniqueUnitIds(snapshot: DocumentSnapshot): boolean {
  const seen = new Set<string>();
  const visit = (blocks: DocumentBlock[]): boolean => blocks.every(block => {
    if (seen.has(block.id)) return false;
    seen.add(block.id);
    if (block.type === 'table' && block.content !== undefined) {
      for (const row of (block.content as TableContent).rows) for (const cell of row.cells) {
        if (seen.has(cell.id)) return false;
        seen.add(cell.id);
      }
    }
    return visit(block.children ?? []);
  });
  return visit(snapshot.blocks);
}

export const DocumentSnapshotSchema = Type.Refine(Type.Object({
  version: Type.Literal(documentVersion), blocks: Type.Array(DocumentBlockSchema),
}, closed), value => isJson(value) && uniqueUnitIds(value));

export function checkDocument(value: unknown): value is DocumentSnapshot {
  return isJson(value) && Value.Check(DocumentSnapshotSchema, value);
}

export function parseDocument(value: unknown): DocumentSnapshot {
  if (!checkDocument(value)) throw new TypeError('Invalid rezics-blocks-v1 snapshot');
  return value;
}

/** Unknown block payloads remain verbatim; the report lets a consumer disclose unsupported content. */
export function inspectDocument(value: unknown): {
  snapshot: DocumentSnapshot;
  unknownBlocks: { id: string; type: string }[];
} {
  const snapshot = parseDocument(value);
  const unknownBlocks: { id: string; type: string }[] = [];
  const visit = (blocks: DocumentBlock[]) => {
    for (const block of blocks) {
      if (!known.has(block.type)) unknownBlocks.push({ id: block.id, type: block.type });
      visit(block.children ?? []);
    }
  };
  visit(snapshot.blocks);
  return { snapshot, unknownBlocks };
}
