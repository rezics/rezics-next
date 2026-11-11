import { createHash } from 'node:crypto';
import { accessCheck } from './access-port.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { routeOf } from '../route/route.ts';
import { ContentNotFoundError } from './reads.ts';
import { snapshot } from './reads.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  KNOWLEDGE_ANCESTOR_LIMIT,
  KnowledgeNotFoundError,
  knowledgeSubjectTargets,
  type KnowledgeDependencies,
} from './knowledge-model.ts';
import {
  knowledgeAncestorPath,
  knowledgePrivateRow,
  knowledgePublicRow,
  knowledgePublicSelection,
} from './knowledge-store.ts';
import { admitsKnowledgeAncestorPath } from './knowledge-tree.ts';

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new ContentNotFoundError();
  return value;
}

function baseDocument(row: {
  document_id: string;
  revision_id: string;
  title: string;
  language: string | null;
  canonical_bytes: Buffer;
  body_sha256: Buffer;
  licence: string;
  subject_ids: string[];
}) {
  return {
    documentId: row.document_id,
    revisionId: row.revision_id,
    title: row.title,
    language: row.language,
    canonicalBytes: row.canonical_bytes.toString('base64'),
    sha256: row.body_sha256.toString('hex'),
    licence: row.licence,
    subjectIds: [...row.subject_ids],
  };
}

function currentBytesAreSound(row: { canonical_bytes: Buffer; body_sha256: Buffer; publication_sha256: Buffer }) {
  const digest = createHash('sha256').update(row.canonical_bytes).digest();
  if (!digest.equals(row.body_sha256) || !digest.equals(row.publication_sha256))
    throw new Error('Knowledge publication digest does not match its immutable revision');
}

/** A public read selects only the document's current publication pointer. Search may be behind or paused;
 * its candidate is never authority to return an older publication. */
export async function readKnowledgePublicDocument(
  deps: KnowledgeDependencies,
  documentId: string,
  selection: Readonly<{ revisionId?: string }>,
  context: ReadContext,
) {
  const sourceRoute = route(documentId);
  if (selection.revisionId !== undefined && route(selection.revisionId) !== sourceRoute)
    throw new KnowledgeNotFoundError();
  const initial = await snapshot(deps, documentId, context, (client) =>
    knowledgePublicSelection(client, sourceRoute, documentId),
  );
  const selected = initial.value;
  if (!selected || (selection.revisionId !== undefined && selection.revisionId !== selected.revision_id))
    throw new KnowledgeNotFoundError();
  const subjects = knowledgeSubjectTargets(selected.subject_id, selected.subject_ids);

  const prepareSubjects = await prepareEditionSubjectIdentities(deps, subjects, {
    actor: { kind: 'anonymous' },
    deadline: context.deadline,
  });
  const visible = async () => {
    const identities = await prepareSubjects();
    return subjects.every((id) => identities.get(id)?.kind === 'available');
  };
  if (!(await visible())) throw new KnowledgeNotFoundError();

  const final = await snapshot(deps, documentId, context, async (client) => {
    const row = await knowledgePublicRow(client, sourceRoute, documentId);
    if (
      !row ||
      row.current_publication_id !== selected.current_publication_id ||
      row.revision_id !== selected.revision_id ||
      row.subject_id !== selected.subject_id ||
      !row.publication_sha256.equals(selected.publication_sha256) ||
      (selection.revisionId !== undefined && selection.revisionId !== row.revision_id)
    )
      return null;
    currentBytesAreSound(row);
    return row;
  });
  if (!final.value || !(await visible())) throw new KnowledgeNotFoundError();
  const value = {
    document: {
      ...baseDocument(final.value),
      publicationId: final.value.current_publication_id,
      subjectId: final.value.subject_id,
      publishedAt: final.value.published_at.toISOString(),
      // The first loop deliberately publishes deidentified attribution. Account erasure can therefore
      // retain an eligible selected revision without exposing an account identity through this read.
      authorId: null,
    },
  };
  const anchors: AnchoredPosition[] = [initial.anchor, final.anchor];
  return { value, anchors };
}

/** The private route is same-home only. Full ancestry and account authority are rechecked in the
 * notebook partition snapshot before exact current-head bytes are disclosed. */
export async function readKnowledgePrivateDocument(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  context: ReadContext,
) {
  const sourceRoute = route(documentId);
  if (
    context.actor.kind !== 'account' ||
    context.actor.accountId !== accountId ||
    route(accountId) !== sourceRoute ||
    route(notebookId) !== sourceRoute
  )
    throw new KnowledgeNotFoundError();

  const check = await accessCheck(
    deps.access,
    context.actor,
    'account:read',
    { route: sourceRoute, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const result = await snapshot(deps, documentId, context, async (client) => {
    if (!(await check(client))) return null;
    const row = await knowledgePrivateRow(client, sourceRoute, notebookId, documentId);
    if (!row || row.owner_account_id !== accountId) return null;
    const path = await knowledgeAncestorPath(client, sourceRoute, notebookId, row.placement_id);
    const stablePath = path.map(({ placement_id, parent_id }) => ({ placementId: placement_id, parentId: parent_id }));
    if (path.length > KNOWLEDGE_ANCESTOR_LIMIT + 1 || !admitsKnowledgeAncestorPath(stablePath)) return null;
    return row;
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  return {
    value: {
      document: {
        ...baseDocument({ ...result.value, revision_id: result.value.head_revision_id }),
        notebookId: result.value.notebook_id,
      },
    },
    anchors: [result.anchor],
  };
}
