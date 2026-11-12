import { createHash } from 'node:crypto';
import { accessCheck } from './access-port.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { ContentNotFoundError } from './reads.ts';
import { snapshot } from './reads.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  KNOWLEDGE_ANCESTOR_LIMIT,
  KNOWLEDGE_OUTLINE_SCAN_LIMIT,
  KNOWLEDGE_PAGE_LIMIT,
  KnowledgeInvalidCursorError,
  KnowledgeNotFoundError,
  KnowledgeStaleCursorError,
  knowledgeSubjectTargets,
  type KnowledgeOutlinePageInput,
  type KnowledgePageInput,
  type KnowledgeDependencies,
} from './knowledge-model.ts';
import {
  knowledgeAncestorPath,
  knowledgeNotebookSelection,
  knowledgeOutlineChildrenPage,
  knowledgeOwnedNotebookPage,
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

function knowledgeCursorBinding(
  path: string,
  accountId: string,
  query: Readonly<Record<string, string | number | boolean | null>>,
): CursorBinding {
  return { operation: path, parameters: { accountId, ...query } };
}

async function readCursor(deps: KnowledgeDependencies, binding: CursorBinding, token?: string) {
  if (token === undefined) return null;
  const cursor = decodeCursor(deps.tokens, binding, token, deps.clock().getTime());
  if (!cursor.ok) throw new KnowledgeInvalidCursorError();
  return cursor;
}

function invalidCursor(): never {
  throw new KnowledgeInvalidCursorError();
}

function validRoutedKey(value: unknown, expectedRoute: number): value is string {
  return typeof value === 'string' && routeOf(value) === expectedRoute;
}

function validCursorPosition(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n
  );
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
        publicationId: result.value.current_publication_id,
      },
    },
    anchors: [result.anchor],
  };
}

/** Reloads an owner's notebook directory with the native encrypted keyset cursor. */
export async function readKnowledgeOwnedNotebooks(
  deps: KnowledgeDependencies,
  accountId: string,
  query: KnowledgePageInput,
  context: ReadContext,
) {
  const sourceRoute = route(accountId);
  const limit = query.limit ?? KNOWLEDGE_PAGE_LIMIT;
  if (context.actor.kind !== 'account' || context.actor.accountId !== accountId) throw new KnowledgeNotFoundError();
  const binding = knowledgeCursorBinding('GET /v1/accounts/:accountId/knowledge/notebooks', accountId, {
    limit,
    route: sourceRoute,
  });
  const cursor = await readCursor(deps, binding, query.cursor);
  if (
    cursor &&
    (cursor.after.length !== 2 ||
      typeof cursor.after[0] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.after[0]) ||
      !Number.isFinite(Date.parse(cursor.after[0])) ||
      !validRoutedKey(cursor.after[1], sourceRoute))
  )
    invalidCursor();
  const after = cursor?.after as readonly string[] | undefined;
  const check = await accessCheck(
    deps.access,
    context.actor,
    'account:read',
    { route: sourceRoute, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const result = await snapshot(deps, accountId, context, async (client) => {
    if (!(await check(client))) return null;
    const rows = await knowledgeOwnedNotebookPage(
      client,
      sourceRoute,
      accountId,
      after ? { createdAt: after[0]!, notebookId: after[1]! } : null,
      limit + 1,
    );
    return rows;
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  if (cursor && cursor.epoch !== result.anchor.epoch) throw new KnowledgeStaleCursorError();
  const hasMore = result.value.length > limit;
  const page = result.value.slice(0, limit);
  const last = page.at(-1);
  const next =
    hasMore && last
      ? encodeCursor(
          deps.tokens,
          binding,
          {
            epoch: result.anchor.epoch,
            after: [last.created_at_key, last.notebook_id],
          },
          deps.clock().getTime(),
        )
      : null;
  return {
    value: {
      notebooks: page.map((row) => ({
        notebookId: row.notebook_id,
        subjectId: row.subject_id,
        title: row.title,
        structureRevisionId: row.structure_revision_id,
        createdAt: row.created_at.toISOString(),
      })),
      next,
    },
    anchors: [result.anchor],
  };
}

/** Pages the immediate children of the current selected outline. Each request examines at most
 * 128 indexed siblings and resumes from the last eligible or examined key when rows are sparse. */
export async function readKnowledgeOutline(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  query: KnowledgeOutlinePageInput,
  context: ReadContext,
) {
  const sourceRoute = route(notebookId);
  const accountRoute = route(accountId);
  if (
    context.actor.kind !== 'account' ||
    context.actor.accountId !== accountId ||
    accountRoute !== sourceRoute ||
    (query.parentPlacementId !== undefined && route(query.parentPlacementId) !== sourceRoute)
  )
    throw new KnowledgeNotFoundError();
  const parentId = query.parentPlacementId ?? null;
  const limit = query.limit ?? KNOWLEDGE_PAGE_LIMIT;
  const binding = knowledgeCursorBinding(
    'GET /v1/accounts/:accountId/knowledge/notebooks/:notebookId/outline',
    accountId,
    { limit, notebookId, parentPlacementId: parentId },
  );
  const cursor = await readCursor(deps, binding, query.cursor);
  if (
    cursor &&
    (cursor.after.length !== 3 ||
      !validRoutedKey(cursor.after[0], sourceRoute) ||
      !validCursorPosition(cursor.after[1]) ||
      !validRoutedKey(cursor.after[2], sourceRoute))
  )
    invalidCursor();
  const after = cursor?.after as readonly string[] | undefined;
  const check = await accessCheck(
    deps.access,
    context.actor,
    'account:read',
    { route: sourceRoute, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const result = await snapshot(deps, notebookId, context, async (client) => {
    if (!(await check(client))) return null;
    const notebook = await knowledgeNotebookSelection(client, sourceRoute, notebookId);
    if (!notebook || notebook.owner_account_id !== accountId) return null;
    if (cursor && after?.[0] !== notebook.structure_revision_id) throw new KnowledgeStaleCursorError();
    if (parentId !== null) {
      const parentPath = await knowledgeAncestorPath(client, sourceRoute, notebookId, parentId);
      const stableParentPath = parentPath.map(({ placement_id, parent_id }) => ({
        placementId: placement_id,
        parentId: parent_id,
      }));
      if (parentPath.length > KNOWLEDGE_ANCESTOR_LIMIT + 1 || !admitsKnowledgeAncestorPath(stableParentPath))
        return null;
    }

    const candidates = await knowledgeOutlineChildrenPage(
      client,
      sourceRoute,
      notebookId,
      parentId,
      after ? { position: after[1]!, placementId: after[2]! } : null,
      KNOWLEDGE_OUTLINE_SCAN_LIMIT + 1,
    );
    const examined = candidates.slice(0, KNOWLEDGE_OUTLINE_SCAN_LIMIT);
    const placements: (typeof examined)[number][] = [];
    let nextAfter: Readonly<{ position: string; placementId: string }> | null = null;
    for (const candidate of examined) {
      const path = await knowledgeAncestorPath(client, sourceRoute, notebookId, candidate.placement_id);
      const stablePath = path.map(({ placement_id, parent_id }) => ({
        placementId: placement_id,
        parentId: parent_id,
      }));
      const eligible = path.length <= KNOWLEDGE_ANCESTOR_LIMIT + 1 && admitsKnowledgeAncestorPath(stablePath);
      if (eligible) placements.push(candidate);
      if (placements.length > limit) {
        placements.pop();
        const last = placements.at(-1);
        nextAfter = last ? { position: last.position, placementId: last.placement_id } : null;
        break;
      }
    }
    if (nextAfter === null && candidates.length > KNOWLEDGE_OUTLINE_SCAN_LIMIT) {
      const last = examined.at(-1);
      if (last) nextAfter = { position: last.position, placementId: last.placement_id };
    }
    return { structureRevisionId: notebook.structure_revision_id, placements, nextAfter };
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  if (cursor && cursor.epoch !== result.anchor.epoch) throw new KnowledgeStaleCursorError();
  const next = result.value.nextAfter
    ? encodeCursor(
        deps.tokens,
        binding,
        {
          epoch: result.anchor.epoch,
          after: [
            result.value.structureRevisionId,
            result.value.nextAfter.position,
            result.value.nextAfter.placementId,
          ],
        },
        deps.clock().getTime(),
      )
    : null;
  return {
    value: {
      notebookId,
      structureRevisionId: result.value.structureRevisionId,
      parentPlacementId: parentId,
      placements: result.value.placements.map((row) => ({
        placementId: row.placement_id,
        documentId: row.document_id,
        parentPlacementId: row.parent_id,
        position: row.position,
        title: row.title,
      })),
      next,
    },
    anchors: [result.anchor],
  };
}
