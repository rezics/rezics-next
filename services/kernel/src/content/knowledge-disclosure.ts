import { normalizeDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { snapshot } from './reads.ts';
import { routeOf } from '../route/route.ts';
import { knowledgePublicSelection } from './knowledge-store.ts';
import type { ReadContext } from './model.ts';
import { knowledgeSubjectTargets, type KnowledgeDependencies } from './knowledge-model.ts';
import {
  KNOWLEDGE_REFERENCE_DEFINITION,
  type KnowledgeReference,
  type KnowledgeReferenceTarget,
  type KnowledgeProvenance,
} from './knowledge-portable.ts';

/** Metadata-only one-hop checks. These never load target bodies or follow their outgoing references. */
async function referenceVisible(
  deps: KnowledgeDependencies,
  target: KnowledgeReferenceTarget | null,
  context: ReadContext,
): Promise<boolean> {
  if (target === null) return false;
  if (target.kind === 'subject') {
    const read = await prepareEditionSubjectIdentities(deps, [target.subjectId], context);
    return (await read()).get(target.subjectId)?.kind === 'available';
  }
  const route = routeOf(target.documentId);
  if (route === null) return false;
  const selected = await snapshot(deps, target.documentId, context, (tx) =>
    knowledgePublicSelection(tx, route, target.documentId),
  );
  const publication = selected.value;
  if (
    !publication ||
    (target.kind === 'revision' &&
      (publication.revision_id !== target.revisionId ||
        publication.publication_sha256.toString('hex') !== target.sha256 ||
        (target.blockId !== undefined && !publication.block_ids.includes(target.blockId))))
  )
    return false;
  const subjects = knowledgeSubjectTargets(publication.subject_id, publication.subject_ids);
  const read = await prepareEditionSubjectIdentities(deps, subjects, context);
  let visible = await read();
  if (!subjects.every((id) => visible.get(id)?.kind === 'available')) return false;
  const final = await snapshot(deps, target.documentId, context, (tx) =>
    knowledgePublicSelection(tx, route, target.documentId),
  );
  visible = await read();
  return (
    final.value?.publication_id === publication.publication_id &&
    subjects.every((id) => visible.get(id)?.kind === 'available')
  );
}

/** The public reader, export and copy share exactly this serialization boundary. */
export async function projectKnowledgePublicBody(
  deps: KnowledgeDependencies,
  snapshot: DocumentSnapshot,
  references: readonly KnowledgeReference[],
  deadline: number,
): Promise<Readonly<{ snapshot: DocumentSnapshot; references: readonly KnowledgeReference[] }>> {
  const context = { actor: { kind: 'anonymous' as const }, deadline };
  const permitted: KnowledgeReference[] = [];
  for (const reference of references) {
    permitted.push({
      ...reference,
      target: (await referenceVisible(deps, reference.target, context)) ? reference.target : null,
    });
  }
  const available = new Set(
    permitted.filter((reference) => reference.target !== null).map((reference) => reference.id),
  );
  const rewrite = (node: DocumentNode): DocumentNode => {
    if (
      (node.type === 'extensionBlock' || node.type === 'extensionInline') &&
      node.attrs!.definition === KNOWLEDGE_REFERENCE_DEFINITION
    ) {
      const referenceId = (node.attrs!.payload as { referenceId: string }).referenceId;
      if (!available.has(referenceId)) return { ...node, attrs: { ...node.attrs, fallback: 'Unavailable reference' } };
    }
    // Knowledge has no media claim destination. Do not turn a stored locator or signed URL into public authority.
    if (node.type === 'image' || node.type === 'media')
      return {
        type: 'paragraph',
        attrs: { id: node.attrs!.id! },
        content: [{ type: 'text', text: 'Unavailable media' }],
      };
    return { ...node, ...(node.content ? { content: node.content.map(rewrite) } : {}) };
  };
  return { snapshot: normalizeDocument({ ...snapshot, doc: rewrite(snapshot.doc) }), references: permitted };
}

/** A copied public locator is still target metadata and must remain currently disclosable. */
export async function projectKnowledgePublicProvenance(
  deps: KnowledgeDependencies,
  provenance: KnowledgeProvenance | null,
  deadline: number,
): Promise<KnowledgeProvenance | null> {
  if (provenance?.representation !== 'public') return null;
  const context = { actor: { kind: 'anonymous' as const }, deadline };
  if (!(await referenceVisible(deps, { kind: 'document', documentId: provenance.documentId }, context))) return null;
  const route = routeOf(provenance.documentId)!;
  const selected = await snapshot(deps, provenance.documentId, context, (tx) =>
    knowledgePublicSelection(tx, route, provenance.documentId),
  );
  return selected.value?.revision_id === provenance.revisionId &&
    selected.value.publication_id === provenance.publicationId
    ? provenance
    : null;
}
