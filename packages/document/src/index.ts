// SPDX-License-Identifier: Apache-2.0
import { Value } from 'typebox/value';
import { TableMap } from 'prosemirror-tables';
import { DocumentSnapshotSchema, identifiableNodeNames, schemaForProfile } from './schema.ts';
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

function uniqueIds(doc: DocumentNode): boolean {
  const seen = new Set<string>();
  const visit = (node: DocumentNode): boolean => {
    if (identifiableNodeNames.has(node.type)) {
      const id = node.attrs?.id;
      if (typeof id !== 'string' || !id || seen.has(id)) return false;
      seen.add(id);
    }
    return (node.content ?? []).every(visit);
  };
  return visit(doc);
}

export function checkDocument(value: unknown): value is DocumentSnapshot {
  try {
    if (!isJson(value) || !Value.Check(DocumentSnapshotSchema, value)) return false;
    const snapshot = value as DocumentSnapshot;
    if (!uniqueIds(snapshot.doc)) return false;
    const doc = schemaForProfile(snapshot.profile).nodeFromJSON(snapshot.doc);
    doc.check();
    let validTables = true;
    doc.descendants((node) => {
      if (node.type.name === 'table' && TableMap.get(node).problems?.length) validTables = false;
    });
    return validTables;
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

/** Apply ProseMirror's defaults, mark ordering and adjacent-text merging to validated JSON. */
export function normalizeDocument(snapshot: DocumentSnapshot): DocumentSnapshot {
  parseDocument(snapshot);
  const doc = schemaForProfile(snapshot.profile)
    .nodeFromJSON(snapshot.doc)
    .toJSON() as DocumentNode;
  return { version: documentVersion, profile: snapshot.profile, doc };
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

/** Ordered leaf text units for reading, indexing and revision-bound paragraph locators. */
export function documentParagraphs(snapshot: DocumentSnapshot): DocumentParagraph[] {
  parseDocument(snapshot);
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
  visit(snapshot.doc);
  return units;
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

/** Deterministic JSON after model normalization. This is not an RFC 8785 digest contract. */
export function serializeDocument(snapshot: DocumentSnapshot): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  };
  return JSON.stringify(sorted(normalizeDocument(snapshot)));
}

/** For application-owned draft storage only. Authored JSON text must remain ordinary text. */
export function parseStoredDocument(value: string): DocumentSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return checkDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
