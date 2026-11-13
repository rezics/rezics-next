import type { KernelClient } from '@rezics/client';
import { identifiableNodeNames, parseDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';

// The installed native command owns the finite manifest, including future optional fields.
type NativeCreate = Parameters<ReturnType<KernelClient['knowledge']['notebooks']>['documents']['post']>[0];
export type KnowledgeReference = NonNullable<NativeCreate['references']>[number];
export type KnowledgeReferenceTarget = NonNullable<KnowledgeReference['target']>;
export const referenceDefinition = 'rezics.knowledge.reference';
export const referenceLimit = 64;
export const referenceRoles = ['about', 'cites', 'explains', 'uses', 'inspired-by'] as const;
export type ReferenceDraft = { body: DocumentSnapshot; references: readonly KnowledgeReference[] };
export type ReferenceIssue = { id: string; kind: 'unlisted' | 'orphan' | 'duplicate' | 'source' | 'component' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** HTTP/import boundary. A null target is the native unavailable disclosure projection. */
export function parseReferenceTarget(value: unknown): KnowledgeReferenceTarget | null | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  if (value.kind === 'subject' && closed(value, ['kind', 'subjectId']) && id(value.subjectId))
    return value as KnowledgeReferenceTarget;
  if (!id(value.documentId)) return undefined;
  if (value.kind === 'document' && closed(value, ['kind', 'documentId'])) return value as KnowledgeReferenceTarget;
  if (
    value.kind === 'revision' &&
    closed(value, ['kind', 'documentId', 'revisionId', 'sha256', 'blockId']) &&
    id(value.revisionId) &&
    typeof value.sha256 === 'string' &&
    digest.test(value.sha256) &&
    (value.blockId === undefined || text(value.blockId))
  )
    return value as KnowledgeReferenceTarget;
  return undefined;
}

export function parseReferenceManifest(value: unknown): readonly KnowledgeReference[] | null {
  // Older reference-free projections are compatible; a body component still requires its manifest below.
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > referenceLimit) return null;
  const seen = new Set<string>();
  for (const reference of value) {
    if (
      !record(reference) ||
      !closed(reference, ['id', 'role', 'sourceBlockId', 'target']) ||
      !text(reference.id) ||
      !referenceRoles.includes(reference.role as KnowledgeReference['role']) ||
      seen.has(reference.id) ||
      (reference.sourceBlockId !== undefined && !text(reference.sourceBlockId)) ||
      parseReferenceTarget(reference.target) === undefined
    )
      return null;
    seen.add(reference.id);
  }
  return value as KnowledgeReference[];
}

export function visitReferenceNodes(node: DocumentNode, visit: (node: DocumentNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) visitReferenceNodes(child, visit);
}

export function referenceComponent(node: DocumentNode): boolean {
  return (
    (node.type === 'extensionInline' || node.type === 'extensionBlock') &&
    node.attrs?.definition === referenceDefinition
  );
}

export function componentReferenceId(node: DocumentNode): string | null {
  const payload = node.attrs?.payload;
  return referenceComponent(node) &&
    node.attrs?.version === '1' &&
    record(payload) &&
    closed(payload, ['referenceId']) &&
    text(payload.referenceId)
    ? payload.referenceId
    : null;
}

export function referenceBlocks(body: DocumentSnapshot): readonly string[] {
  const blocks: string[] = [];
  visitReferenceNodes(body.doc, (node) => {
    if (identifiableNodeNames.has(node.type) && !referenceComponent(node)) blocks.push(node.attrs!.id as string);
  });
  return blocks;
}

/** Editor review, not a second input validator: show recoverable relationships without rewriting the draft. */
export function referenceIssues({ body, references }: ReferenceDraft): readonly ReferenceIssue[] {
  const manifest = new Map(references.map((reference) => [reference.id, reference]));
  const counts = new Map<string, number>();
  const blocks = new Set<string>();
  const issues: ReferenceIssue[] = [];
  visitReferenceNodes(body.doc, (node) => {
    if (identifiableNodeNames.has(node.type)) blocks.add(node.attrs!.id as string);
    if (!referenceComponent(node)) return;
    const localId = componentReferenceId(node);
    if (!localId) {
      issues.push({ id: node.attrs!.id as string, kind: 'component' });
      return;
    }
    counts.set(localId, (counts.get(localId) ?? 0) + 1);
  });
  for (const [localId, count] of counts) {
    if (!manifest.has(localId)) issues.push({ id: localId, kind: 'unlisted' });
    if (count > 1) issues.push({ id: localId, kind: 'duplicate' });
  }
  for (const reference of references) {
    if (!counts.has(reference.id)) issues.push({ id: reference.id, kind: 'orphan' });
    if (reference.sourceBlockId !== undefined && !blocks.has(reference.sourceBlockId))
      issues.push({ id: reference.id, kind: 'source' });
  }
  return issues;
}

export function admitReferenceManifest(body: DocumentSnapshot, value: unknown): readonly KnowledgeReference[] | null {
  const references = parseReferenceManifest(value);
  return references && referenceIssues({ body, references }).length === 0 ? references : null;
}

function mapBody(body: DocumentSnapshot, change: (node: DocumentNode) => DocumentNode | null): DocumentSnapshot {
  function walk(node: DocumentNode): DocumentNode | null {
    const next = change(node);
    if (!next) return null;
    return next.content
      ? {
          ...next,
          content: next.content.flatMap((child) => {
            const mapped = walk(child);
            return mapped ? [mapped] : [];
          }),
        }
      : next;
  }
  const doc = walk(body.doc)!;
  if (!doc.content?.length) doc.content = [{ type: 'paragraph', attrs: { id: crypto.randomUUID() } }];
  return parseDocument({ ...body, doc });
}

export function referenceLabel(body: DocumentSnapshot, referenceId: string): string {
  let label = '';
  visitReferenceNodes(body.doc, (node) => {
    if (componentReferenceId(node) === referenceId) label = node.attrs!.fallback as string;
  });
  return label;
}

/** Insert an opaque registered v1 component; existing source blocks and all their IDs stay intact. */
export function appendReferenceComponent(body: DocumentSnapshot, referenceId: string, label: string): DocumentSnapshot {
  const component: DocumentNode = {
    type: 'extensionBlock',
    attrs: {
      id: crypto.randomUUID(),
      definition: referenceDefinition,
      version: '1',
      payload: { referenceId },
      fallback: label,
    },
  };
  return parseDocument({
    ...body,
    profile: 'blocks',
    doc: { ...body.doc, content: [...(body.doc.content ?? []), component] },
  });
}

export function writeReference(draft: ReferenceDraft, reference: KnowledgeReference, label: string): ReferenceDraft {
  const exists = draft.references.some((item) => item.id === reference.id);
  return {
    references: exists
      ? draft.references.map((item) => (item.id === reference.id ? reference : item))
      : [...draft.references, reference],
    body: exists
      ? mapBody(draft.body, (node) =>
          componentReferenceId(node) === reference.id ? { ...node, attrs: { ...node.attrs, fallback: label } } : node,
        )
      : appendReferenceComponent(draft.body, reference.id, label),
  };
}

export function removeReference(draft: ReferenceDraft, referenceId: string): ReferenceDraft {
  return {
    references: draft.references.filter((item) => item.id !== referenceId),
    body: mapBody(draft.body, (node) => (componentReferenceId(node) === referenceId ? null : node)),
  };
}

/** Every repair is an explicit author action. Never drop the manifest to make a command pass. */
export function repairReference(draft: ReferenceDraft, issue: ReferenceIssue): ReferenceDraft {
  if (issue.kind === 'orphan') return { ...draft, body: appendReferenceComponent(draft.body, issue.id, '') };
  if (issue.kind === 'source')
    return {
      ...draft,
      references: draft.references.map((reference) => {
        if (reference.id !== issue.id) return reference;
        const { sourceBlockId: _source, ...rest } = reference;
        return rest;
      }),
    };
  if (issue.kind === 'unlisted')
    return { ...draft, references: [...draft.references, { id: issue.id, role: 'cites', target: null }] };
  let kept = false;
  return {
    ...draft,
    body: mapBody(draft.body, (node) => {
      if (issue.kind === 'component') return referenceComponent(node) && node.attrs!.id === issue.id ? null : node;
      if (componentReferenceId(node) !== issue.id) return node;
      if (kept) return null;
      kept = true;
      return node;
    }),
  };
}

export function referenceBlock(body: DocumentSnapshot, blockId: string): DocumentNode | null {
  let found: DocumentNode | null = null;
  visitReferenceNodes(body.doc, (node) => {
    if (node.attrs?.id === blockId) found = node;
  });
  return found;
}
