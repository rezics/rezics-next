// SPDX-License-Identifier: Apache-2.0
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { identifiableNodeNames, schemaForProfile, topLevelNodeNames, wireNodeChecker } from './schema.ts';
import {
  documentVersion,
  type DocumentNode,
  type DocumentParagraph,
  type DocumentProfile,
  type DocumentSnapshot,
} from './types.ts';

export * from './types.ts';
export * from './schema.ts';
export { fromMarkdown } from './markdown.ts';

/** Reject data that JSON would silently omit or coerce before entering a snapshot. */
function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        !(Array.isArray(value) && key === 'length') &&
        (!descriptor.enumerable || !('value' in descriptor)),
    )
  )
    return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(
        { length: value.length },
        (_, i) => Object.hasOwn(value, i) && isJson(value[i], ancestors),
      ).every(Boolean)
    : Object.values(value).every((item) => isJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

/*
 * Editing produces a new snapshot on every keystroke, so validation, normalization and
 * serialization work block by block: the profile schemas constrain nothing across top-level
 * blocks except unique identities and the document's content expression, which are checked over
 * the whole sequence. Normalized output is deeply frozen, so a block or snapshot this module has
 * produced can be recognized by identity and never needs checking again. Unchanged blocks keep
 * their identity between keystrokes, which keeps the work proportional to the edit rather than
 * to the document.
 */
interface CheckedBlock {
  ids: readonly string[];
  node: ProseMirrorNode;
}

const normalizedBlocks: Record<DocumentProfile, WeakMap<object, CheckedBlock>> = {
  text: new WeakMap(),
  blocks: new WeakMap(),
};
const normalizedSnapshots = new WeakSet<object>();
const wireChecks = { text: wireNodeChecker('text'), blocks: wireNodeChecker('blocks') };
const topLevel = { text: topLevelNodeNames('text'), blocks: topLevelNodeNames('blocks') };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** A plain object or array carrying only enumerable data properties, as JSON would round-trip it. */
function plainContainer(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(
    ([key, descriptor]) =>
      (Array.isArray(value) && key === 'length') || (descriptor.enumerable && 'value' in descriptor),
  );
}

function blockIds(block: DocumentNode): string[] | null {
  const ids: string[] = [];
  const visit = (node: DocumentNode): boolean => {
    if (identifiableNodeNames.has(node.type)) {
      const id = node.attrs?.id;
      if (typeof id !== 'string' || !id) return false;
      ids.push(id);
    }
    return (node.content ?? []).every(visit);
  };
  return visit(block) ? ids : null;
}

/** One top-level block, validated as the only block of a snapshot. */
function checkBlock(profile: DocumentProfile, block: unknown): CheckedBlock | null {
  if (typeof block === 'object' && block !== null) {
    const known = normalizedBlocks[profile].get(block);
    if (known) return known;
  }
  if (!isJson(block) || !wireChecks[profile](block)) return null;
  if (!topLevel[profile].has((block as DocumentNode).type)) return null;
  const ids = blockIds(block as DocumentNode);
  if (!ids) return null;
  const node = schemaForProfile(profile).nodeFromJSON(block);
  node.check();
  let validTables = true;
  const tables = (child: ProseMirrorNode) => {
    if (child.type.name === 'table' && TableMap.get(child).problems?.length) validTables = false;
  };
  tables(node);
  node.descendants(tables);
  return validTables ? { ids, node } : null;
}

/** The checked blocks of a snapshot, or null when it is not a valid snapshot. */
function checkBlocks(value: unknown): CheckedBlock[] | null {
  if (!plainContainer(value)) return null;
  const { version, profile, doc, ...rest } = value;
  if (Object.keys(rest).length || version !== documentVersion) return null;
  if (profile !== 'text' && profile !== 'blocks') return null;
  if (!plainContainer(doc) || doc.type !== 'doc') return null;
  const { type: _type, content, ...docRest } = doc;
  if (Object.keys(docRest).length || !Array.isArray(content) || !plainContainer(content)) return null;
  if (Object.keys(content).length !== content.length || !content.length) return null;
  const checked: CheckedBlock[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < content.length; index++) {
    if (!Object.hasOwn(content, index)) return null;
    const block = checkBlock(profile, content[index]);
    if (!block) return null;
    for (const id of block.ids) {
      if (seen.has(id)) return null;
      seen.add(id);
    }
    checked.push(block);
  }
  const schema = schemaForProfile(profile);
  return schema.topNodeType.validContent(Fragment.fromArray(checked.map((block) => block.node)))
    ? checked
    : null;
}

export function checkDocument(value: unknown): value is DocumentSnapshot {
  if (typeof value === 'object' && value !== null && normalizedSnapshots.has(value)) return true;
  try {
    return checkBlocks(value) !== null;
  } catch {
    return false;
  }
}

/** Validate without stripping attributes, coercing values or changing extension payloads. */
export function parseDocument(value: unknown): DocumentSnapshot {
  if (!checkDocument(value)) throw new TypeError('Invalid rezics-document-v1 snapshot');
  return value;
}

/** Editor/import helper. Existing unique IDs survive; duplicate or absent IDs become new units. */
export function withDocumentIds(
  doc: DocumentNode,
  generateId: () => string = () => crypto.randomUUID(),
): DocumentNode {
  const used = new Set<string>();
  const visit = (node: DocumentNode): DocumentNode => {
    let attrs = node.attrs;
    if (identifiableNodeNames.has(node.type)) {
      let id = attrs?.id;
      if (typeof id !== 'string' || !id || used.has(id)) {
        id = generateId();
        if (!id || used.has(id))
          throw new TypeError('Document ID generator must return a new nonempty ID');
      }
      used.add(id);
      attrs = { ...attrs, id };
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc);
}

/**
 * Apply ProseMirror's defaults, mark ordering and adjacent-text merging to validated JSON. The
 * result is deeply frozen; blocks that were already normalized are reused as they are.
 */
export function normalizeDocument(snapshot: DocumentSnapshot): DocumentSnapshot {
  if (normalizedSnapshots.has(snapshot)) return snapshot;
  let checked: CheckedBlock[] | null;
  try {
    checked = checkBlocks(snapshot);
  } catch {
    checked = null;
  }
  if (!checked) throw new TypeError('Invalid rezics-document-v1 snapshot');
  const known = normalizedBlocks[snapshot.profile];
  const content = snapshot.doc.content!.map((block, index) => {
    if (known.has(block)) return block;
    const normalized = deepFreeze(checked[index]!.node.toJSON() as DocumentNode);
    known.set(normalized, checked[index]!);
    return normalized;
  });
  const result: DocumentSnapshot = Object.freeze({
    version: documentVersion,
    profile: snapshot.profile,
    doc: Object.freeze({ type: 'doc', content: Object.freeze(content) as DocumentNode[] }),
  });
  normalizedSnapshots.add(result);
  return result;
}

/** Each line becomes a paragraph; a trailing newline remains a final empty paragraph. */
export function fromPlainText(text: string, profile: DocumentProfile = 'text'): DocumentSnapshot {
  const content: DocumentNode[] = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    }));
  return normalizeDocument({
    version: documentVersion,
    profile,
    doc: withDocumentIds({ type: 'doc', content }),
  });
}

/** Base text excludes ruby annotations; hard breaks and opaque fallbacks remain visible. */
function inlineText(node: DocumentNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'extensionInline' || node.type === 'extensionBlock')
    return String(node.attrs?.fallback ?? '');
  if (node.type === 'image') return String(node.attrs?.alt ?? '');
  if (node.type === 'media') return String(node.attrs?.caption ?? '');
  return (node.content ?? []).map(inlineText).join('');
}

const blockParagraphs = new WeakMap<object, readonly DocumentParagraph[]>();

function paragraphsOf(block: DocumentNode): readonly DocumentParagraph[] {
  const cached = blockParagraphs.get(block);
  if (cached) return cached;
  const units: DocumentParagraph[] = [];
  const visit = (node: DocumentNode): void => {
    if (
      ['paragraph', 'heading', 'codeBlock', 'image', 'media', 'extensionBlock'].includes(node.type)
    ) {
      units.push({ id: String(node.attrs?.id), text: inlineText(node) });
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(block);
  if (Object.isFrozen(block)) blockParagraphs.set(block, units);
  return units;
}

/** Ordered leaf text units for reading, indexing and revision-bound paragraph locators. */
export function documentParagraphs(snapshot: DocumentSnapshot): DocumentParagraph[] {
  parseDocument(snapshot);
  return (snapshot.doc.content ?? []).flatMap((block) => paragraphsOf(block).map((unit) => ({ ...unit })));
}

export function documentText(snapshot: DocumentSnapshot): string {
  return documentParagraphs(snapshot)
    .map((unit) => unit.text)
    .join('\n');
}

export function hasDocumentContent(snapshot: DocumentSnapshot): boolean {
  parseDocument(snapshot);
  const visit = (node: DocumentNode): boolean =>
    node.type === 'text'
      ? Boolean(node.text?.trim())
      : ['image', 'media', 'extensionBlock', 'extensionInline', 'horizontalRule', 'table'].includes(
          node.type,
        ) || (node.content ?? []).some(visit);
  return visit(snapshot.doc);
}

const serialized = new WeakMap<object, string>();
/** Recently serialized texts, so a draft read back right after it was written is not parsed again. */
const recentTexts = new Map<string, DocumentSnapshot>();

/** JSON with sorted keys. Frozen values cannot change, so their text is computed once. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const cached = serialized.get(value);
  if (cached !== undefined) return cached;
  const text = Array.isArray(value)
    ? `[${value.map(sortedJson).join(',')}]`
    : `{${Object.keys(value)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
        .join(',')}}`;
  if (Object.isFrozen(value)) serialized.set(value, text);
  return text;
}

/** Deterministic JSON after model normalization. This is not an RFC 8785 digest contract. */
export function serializeDocument(snapshot: DocumentSnapshot): string {
  const normalized = normalizeDocument(snapshot);
  const text = sortedJson(normalized);
  recentTexts.delete(text);
  recentTexts.set(text, normalized);
  if (recentTexts.size > 8) recentTexts.delete(recentTexts.keys().next().value!);
  return text;
}

/** For application-owned draft storage only. Authored JSON text must remain ordinary text. */
export function parseStoredDocument(value: string): DocumentSnapshot | null {
  const recent = recentTexts.get(value);
  if (recent) return recent;
  try {
    const parsed: unknown = JSON.parse(value);
    return checkDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
