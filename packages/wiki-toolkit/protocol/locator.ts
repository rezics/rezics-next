// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 REZICS contributors
// Deliberately imports only typebox, independently of service implementations.
import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';

export const locatorVersion = 'rezics-locator-v1' as const;
const closed = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 256 });
const sha256 = Type.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' });
const offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const HostedSourceSchema = Type.Object({
  type: Type.Literal('hosted'), revision: Type.String({ minLength: 1, maxLength: 2048 }), digest: sha256,
}, closed);
export const ExternalSourceSchema = Type.Object({
  type: Type.Literal('external'), representationSha256: sha256,
  mediaType: Type.Refine(Type.String({ maxLength: 256, pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' }),
    value => !/\s/.test(value)),
}, closed);
export type HostedSource = Static<typeof HostedSourceSchema>;
export type ExternalSource = Static<typeof ExternalSourceSchema>;

// W3C quote JSON is retained exactly; offsets below explicitly select different units.
// https://www.w3.org/TR/annotation-model/#text-quote-selector (reviewed 2026-09-30)
export const TextQuoteSelectorSchema = Type.Object({
  type: Type.Literal('TextQuoteSelector'), exact: Type.String({ minLength: 1 }),
  prefix: Type.Optional(Type.String()), suffix: Type.Optional(Type.String()),
}, closed);
export type TextQuoteSelector = Static<typeof TextQuoteSelectorSchema>;
// Half-open, zero-based Unicode code points in the selected block/cell's inline text:
// concatenate text and link labels, include ruby bases, exclude ruby annotations and children.
// No implicit separators; opaque inline content cannot supply a range without an adapter.
const codePointRange = Type.Refine(Type.Object({
  unit: Type.Literal('code-point'), start: offset, end: offset,
}, closed), value => value.start <= value.end);
export const BlockSelectorSchema = Type.Object({
  type: Type.Literal('BlockSelector'), blockId: id, cellId: Type.Optional(id),
  range: Type.Optional(codePointRange),
}, closed);
export type BlockSelector = Static<typeof BlockSelectorSchema>;
export const ByteRangeSelectorSchema = Type.Refine(Type.Object({
  type: Type.Literal('ByteRangeSelector'), unit: Type.Literal('byte'), start: offset, end: offset,
}, closed), value => value.start < value.end);

/** Opaque CFI range envelope, not an EPUB parser. Assertions and escapes are preserved.
 * The toolkit's EPUB library must check paths, ordering and edition-local resolution.
 * https://idpf.org/epub/linking/cfi/#sec-ranges (reviewed 2026-09-30). */
function isRangeCfi(value: string): boolean {
  if (!value.startsWith('epubcfi(') || !value.endsWith(')') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let bracket = false;
  let escaped = false;
  let part = '';
  const parts: string[] = [];
  for (const char of value.slice(8, -1)) {
    if (escaped) { escaped = false; part += char; continue; }
    if (char === '^') { escaped = true; part += char; continue; }
    if (char === '[') { if (bracket) return false; bracket = true; }
    if (char === ']') { if (!bracket) return false; bracket = false; }
    if ((char === '(' || char === ')') && !bracket) return false;
    if (char === ',' && !bracket) { parts.push(part); part = ''; }
    else part += char;
  }
  parts.push(part);
  return !bracket && !escaped && parts.length === 3
    && parts[0]!.startsWith('/') && parts.every(item => item.length > 1)
    && parts.slice(1).every(item => item.startsWith('/') || item.startsWith(':'));
}
export const EpubCfiSelectorSchema = Type.Object({
  type: Type.Literal('EpubCfiSelector'),
  cfi: Type.Refine(Type.String({ minLength: 1, maxLength: 8192 }), isRangeCfi),
}, closed);
export const ScriptSelectorSchema = Type.Object({
  type: Type.Literal('ScriptSelector'), label: Type.Refine(id, value => !/\s/.test(value)),
  // Zero-based literal utterance ordinal within the pinned label; never executes script.
  unit: Type.Literal('utterance'), utterance: offset,
  route: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
}, closed);

export const LocatorSchema = Type.Refine(Type.Object({
  version: Type.Literal(locatorVersion),
  source: Type.Union([HostedSourceSchema, ExternalSourceSchema]),
  selector: Type.Union([BlockSelectorSchema, ByteRangeSelectorSchema,
    EpubCfiSelectorSchema, ScriptSelectorSchema, TextQuoteSelectorSchema]),
  quote: Type.Optional(TextQuoteSelectorSchema),
}, closed), value => {
  if (value.selector.type === 'ByteRangeSelector') return value.source.type === 'external'
    && value.source.mediaType.toLowerCase() === 'text/plain';
  if (value.selector.type === 'EpubCfiSelector') return value.source.type === 'external'
    && value.source.mediaType.toLowerCase() === 'application/epub+zip';
  if (value.selector.type === 'ScriptSelector') return value.source.type === 'external';
  return true;
});
export type Locator = Static<typeof LocatorSchema>;
export function checkLocator(value: unknown): value is Locator { return Value.Check(LocatorSchema, value); }
export function parseLocator(value: unknown): Locator {
  if (!checkLocator(value)) throw new TypeError('Invalid rezics-locator-v1 locator');
  return value;
}

// Structural inputs avoid importing the snapshot implementation or a service owner.
export interface ResolvableBlock {
  id: string;
  type: string;
  content?: unknown;
  children?: readonly ResolvableBlock[];
  lineage?: { kind: 'copy' | 'split' | 'merge'; origins: readonly { id: string; digest: string }[] };
}
export interface ResolvableSnapshot { blocks: readonly ResolvableBlock[] }
export type BlockResolution =
  | { status: 'unchanged' | 'moved'; id: string }
  | { status: 'changed'; candidates: string[] }
  | { status: 'deleted'; candidates: [] }
  | { status: 'ambiguous'; candidates: string[] };

interface Entry {
  block: ResolvableBlock;
  kind: 'block' | 'cell';
  parent: string | null;
  siblings: string[];
  rowPeers?: string[];
}
function index(snapshot: ResolvableSnapshot): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const add = (block: ResolvableBlock, kind: 'block' | 'cell', parent: string | null,
    siblings: string[], rowPeers?: string[]) => {
    if (entries.has(block.id)) throw new TypeError('Duplicate snapshot unit ID');
    entries.set(block.id, { block, kind, parent, siblings, rowPeers });
  };
  const visit = (blocks: readonly ResolvableBlock[], parent: string | null) => {
    const siblings = blocks.map(block => block.id);
    for (const block of blocks) {
      add(block, 'block', parent, siblings);
      if (block.type === 'table' && block.content) {
        const rows = (block.content as { rows: { cells: ResolvableBlock[] }[] }).rows;
        const cells = rows.flatMap(row => row.cells);
        const cellIds = cells.map(cell => cell.id);
        for (const row of rows) {
          const rowPeers = row.cells.map(cell => cell.id);
          for (const cell of row.cells) add(cell, 'cell', block.id, cellIds, rowPeers);
        }
      }
      visit(block.children ?? [], block.id);
    }
  };
  visit(snapshot.blocks, null);
  return entries;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, i) => equal(value, b[i]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}
function payload(block: ResolvableBlock): unknown {
  const { id: _id, children: _children, lineage: _lineage, ...content } = block;
  return content;
}
function moved(id: string, before: Map<string, Entry>, after: Map<string, Entry>): boolean {
  const old = before.get(id)!;
  const current = after.get(id)!;
  if (old.parent !== current.parent) return true;
  const retained = new Set(old.siblings.filter(sibling => after.has(sibling)
    && after.get(sibling)!.parent === current.parent));
  if (old.rowPeers && current.rowPeers) {
    const oldPeers = new Set(old.rowPeers.filter(peer => retained.has(peer)));
    const currentPeers = current.rowPeers.filter(peer => retained.has(peer));
    if (oldPeers.size !== currentPeers.length || currentPeers.some(peer => !oldPeers.has(peer))) return true;
  }
  const preceding = new Set(old.siblings.slice(0, old.siblings.indexOf(id)).filter(sibling => retained.has(sibling)));
  const currentPreceding = current.siblings.slice(0, current.siblings.indexOf(id)).filter(sibling => retained.has(sibling));
  if (preceding.size !== currentPreceding.length || currentPreceding.some(sibling => !preceding.has(sibling))) return true;
  return old.parent !== null && moved(old.parent, before, after);
}

/** O(nodes + payload bytes) for indexing/comparison, plus sibling lists along the target path.
 * Inputs are validated snapshots; callers verify the pinned bytes against source.digest/hash.
 * Insertions/deletions before a unit do not move it. Relative reordering/reparenting does.
 * Lineage is evidence for review, never an automatic range or quotation carry-forward. */
export function resolveBlock(locator: Locator, pinned: ResolvableSnapshot, later: ResolvableSnapshot): BlockResolution {
  parseLocator(locator);
  if (locator.selector.type === 'TextQuoteSelector') return { status: 'ambiguous', candidates: [] };
  if (locator.selector.type !== 'BlockSelector') throw new TypeError('Locator does not select a block');
  const before = index(pinned);
  const after = index(later);
  const selector = locator.selector;
  const id = selector.cellId ?? selector.blockId;
  const original = before.get(id);
  const selectedBlock = before.get(selector.blockId);
  if (!original || selectedBlock?.kind !== 'block'
    || (selector.cellId && (selectedBlock.block.type !== 'table'
      || original.kind !== 'cell' || original.parent !== selector.blockId))) {
    throw new TypeError('Block selector is absent from the pinned snapshot');
  }
  const digest = locator.source.type === 'hosted' ? locator.source.digest : locator.source.representationSha256;
  const descendants = [...after.values()].filter(entry => entry.kind === original.kind && entry.block.lineage
    && entry.block.lineage.kind !== 'copy'
    && entry.block.lineage.origins.some(origin => origin.id === id && origin.digest === digest))
    .map(entry => entry.block.id);
  const current = after.get(id);
  if (descendants.length) {
    return { status: 'changed', candidates: [...new Set([...(current ? [id] : []), ...descendants])] };
  }
  if (!current) return { status: 'deleted', candidates: [] };
  if (original.kind !== current.kind || !equal(payload(original.block), payload(current.block))) {
    return { status: 'changed', candidates: [id] };
  }
  return { status: moved(id, before, after) ? 'moved' : 'unchanged', id };
}
