import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  identifiableNodeNames,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { t } from 'elysia';
import { Compile } from 'typebox/compile';
import type { Static } from 'typebox';
import { InvalidDocumentError } from './document.ts';

export const KNOWLEDGE_REFERENCE_DEFINITION = 'rezics.knowledge.reference';
const closed = { additionalProperties: false };
const id = t.String({ minLength: 1, maxLength: 256 });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const representation = t.Union([t.Literal('authoring'), t.Literal('public')]);
// Keep a schema tuple: a mapped array loses TypeBox's finite union in response inference.
const role = t.Union([
  t.Literal('about'),
  t.Literal('cites'),
  t.Literal('explains'),
  t.Literal('uses'),
  t.Literal('inspired-by'),
]);
export type KnowledgeReference = Readonly<Static<typeof KnowledgeReferenceSchema>>;
export type KnowledgeReferenceTarget = NonNullable<KnowledgeReference['target']>;
export type KnowledgeProvenance = Readonly<Static<typeof KnowledgeProvenanceSchema>>;

export const KnowledgeReferenceSchema = t.Object(
  {
    id,
    role,
    sourceBlockId: t.Optional(id),
    target: t.Union([
      t.Null(),
      t.Object({ kind: t.Literal('subject'), subjectId: uuid }, closed),
      t.Object({ kind: t.Literal('document'), documentId: uuid }, closed),
      t.Object(
        { kind: t.Literal('revision'), documentId: uuid, revisionId: uuid, sha256: digest, blockId: t.Optional(id) },
        closed,
      ),
    ]),
  },
  closed,
);
export const KnowledgeReferencesSchema = t.Array(KnowledgeReferenceSchema, { maxItems: 64 });
const selectionIdentity = { documentId: uuid, revisionId: uuid, sha256: digest };
export const KnowledgeProvenanceSchema = t.Union([
  t.Object({ ...selectionIdentity, representation: t.Literal('authoring') }, closed),
  t.Object(
    { ...selectionIdentity, representation: t.Literal('public'), publicationId: uuid, sourceSha256: digest },
    closed,
  ),
]);
export const KnowledgeExportSchema = t.Object(
  {
    version: t.Literal('knowledge-document-export-v1'),
    representation,
    selection: KnowledgeProvenanceSchema,
    title: t.String({ minLength: 1, maxLength: 512 }),
    language: t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()]),
    licence: t.String({ minLength: 1, maxLength: 128 }),
    subjectIds: t.Array(uuid, { maxItems: 64 }),
    snapshot: t.Unknown(),
    references: KnowledgeReferencesSchema,
    provenance: t.Union([KnowledgeProvenanceSchema, t.Null()]),
    sha256: digest,
  },
  closed,
);
export type KnowledgeExport = Readonly<{
  version: 'knowledge-document-export-v1';
  representation: 'authoring' | 'public';
  selection: KnowledgeProvenance;
  title: string;
  language: string | null;
  licence: string;
  subjectIds: readonly string[];
  snapshot: DocumentSnapshot;
  references: readonly KnowledgeReference[];
  provenance: KnowledgeProvenance | null;
  sha256: string;
}>;

const referenceValidator = Compile(KnowledgeReferencesSchema);
const provenanceValidator = Compile(KnowledgeProvenanceSchema);
const envelopeValidator = Compile(KnowledgeExportSchema);
const referencePayloadValidator = Compile(t.Object({ referenceId: id }, closed));

export function knowledgeDigest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The same RFC 8785 encoder used by Document, applied to the exchange wrapper. */
export function canonicalKnowledgeJson(value: unknown): string {
  return canonicalize(value)!;
}

/** Unsupported stored metadata is unavailable; it never gains guessed source identity or extra private fields. */
export function knowledgeProvenanceOrNull(value: unknown): KnowledgeProvenance | null {
  return provenanceValidator.Check(value) ? (value as KnowledgeProvenance) : null;
}

export function visitKnowledgeNodes(node: DocumentNode, visit: (node: DocumentNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) visitKnowledgeNodes(child, visit);
}

/** HTTP authoring input: reference payloads contain local identity only, never resolver caches. */
export function validateKnowledgeReferences(
  snapshot: DocumentSnapshot,
  input: unknown = [],
): readonly KnowledgeReference[] {
  if (!referenceValidator.Check(input)) throw new InvalidDocumentError('Invalid knowledge reference manifest');
  const references = input as KnowledgeReference[];
  const manifest = new Map(references.map((reference) => [reference.id, reference]));
  if (manifest.size !== references.length) throw new InvalidDocumentError('Duplicate knowledge reference identity');
  const blocks = new Set<string>();
  const used = new Set<string>();
  visitKnowledgeNodes(snapshot.doc, (node) => {
    if (identifiableNodeNames.has(node.type)) blocks.add(node.attrs!.id as string);
    if (
      (node.type === 'extensionInline' || node.type === 'extensionBlock') &&
      node.attrs!.definition === KNOWLEDGE_REFERENCE_DEFINITION
    ) {
      if (node.attrs!.version !== '1' || !referencePayloadValidator.Check(node.attrs!.payload))
        throw new InvalidDocumentError('Invalid knowledge reference component');
      const referenceId = (node.attrs!.payload as { referenceId: string }).referenceId;
      if (!manifest.has(referenceId) || used.has(referenceId))
        throw new InvalidDocumentError('Knowledge reference component needs one manifest entry');
      used.add(referenceId);
    }
  });
  if (used.size !== manifest.size) throw new InvalidDocumentError('Orphan knowledge reference manifest entry');
  if (references.some((reference) => reference.sourceBlockId !== undefined && !blocks.has(reference.sourceBlockId)))
    throw new InvalidDocumentError('Knowledge reference source anchor is absent');
  return references;
}

/** Digest covers the actual wrapper except its own digest field; snapshot gets its independent codec check. */
export function makeKnowledgeExport(input: Omit<KnowledgeExport, 'version' | 'sha256'>): KnowledgeExport {
  validateExportSelection(input);
  const payload = { ...input, version: 'knowledge-document-export-v1' as const };
  return { ...payload, sha256: knowledgeDigest(canonicalKnowledgeJson(payload)) };
}

/** An external artifact can be checked independently of any Kernel storage or destination notebook. */
export function parseKnowledgeExport(value: unknown): KnowledgeExport {
  if (!envelopeValidator.Check(value)) throw new InvalidDocumentError('Invalid knowledge export envelope');
  const envelope = value as KnowledgeExport;
  validateExportSelection(envelope);
  const snapshot = parseDocument(envelope.snapshot);
  validateKnowledgeReferences(snapshot, envelope.references);
  const { sha256, ...payload } = envelope;
  if (knowledgeDigest(canonicalKnowledgeJson(payload)) !== sha256)
    throw new InvalidDocumentError('Knowledge export digest mismatch');
  if (knowledgeDigest(serializeDocument(snapshot)) !== envelope.selection.sha256)
    throw new InvalidDocumentError('Knowledge export representation digest mismatch');
  return envelope;
}

/** Representation declarations describe one exact selected artifact, not permission to upgrade a private source. */
function validateExportSelection(value: Pick<KnowledgeExport, 'representation' | 'selection' | 'provenance'>): void {
  if (value.selection.representation !== value.representation)
    throw new InvalidDocumentError('Knowledge export selection representation mismatch');
  const validLocator = (selection: KnowledgeProvenance) =>
    selection.representation === 'public'
      ? selection.publicationId !== undefined && selection.sourceSha256 !== undefined
      : !('publicationId' in selection) && !('sourceSha256' in selection);
  if (!validLocator(value.selection)) throw new InvalidDocumentError('Knowledge export selection publication mismatch');
  if (
    value.provenance !== null &&
    (!validLocator(value.provenance) ||
      (value.representation === 'public' && value.provenance.representation !== 'public'))
  )
    throw new InvalidDocumentError('Knowledge export provenance representation mismatch');
}

/** Only declared identities and fragment links are rewritten. Opaque payloads and external locators survive. */
export function remapKnowledgeCopy(
  snapshot: DocumentSnapshot,
  references: readonly KnowledgeReference[],
  generateId: () => string = randomUUID,
): Readonly<{ snapshot: DocumentSnapshot; references: readonly KnowledgeReference[] }> {
  const blocks = new Map<string, string>();
  const referenceIds = new Map(references.map((reference) => [reference.id, generateId()]));
  visitKnowledgeNodes(snapshot.doc, (node) => {
    if (identifiableNodeNames.has(node.type)) blocks.set(node.attrs!.id as string, generateId());
  });
  const rewrite = (node: DocumentNode): DocumentNode => {
    const attrs = node.attrs ? { ...node.attrs } : undefined;
    if (attrs && identifiableNodeNames.has(node.type)) attrs.id = blocks.get(attrs.id as string)!;
    if (attrs && attrs.definition === KNOWLEDGE_REFERENCE_DEFINITION) {
      const payload = attrs.payload as { referenceId: string };
      attrs.payload = { referenceId: referenceIds.get(payload.referenceId)! };
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.marks
        ? {
            marks: node.marks.map((mark) => {
              const href = mark.attrs?.href;
              if (mark.type !== 'link' || typeof href !== 'string' || !href.startsWith('#')) return mark;
              const blockId = blocks.get(href.slice(1));
              return blockId ? { ...mark, attrs: { ...mark.attrs, href: `#${blockId}` } } : mark;
            }),
          }
        : {}),
      ...(node.content ? { content: node.content.map(rewrite) } : {}),
    };
  };
  return {
    snapshot: normalizeDocument({ ...snapshot, doc: rewrite(snapshot.doc) }),
    references: references.map((reference) => ({
      ...reference,
      id: referenceIds.get(reference.id)!,
      ...(reference.sourceBlockId === undefined ? {} : { sourceBlockId: blocks.get(reference.sourceBlockId)! }),
    })),
  };
}
