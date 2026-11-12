import { parseDocument, serializeDocument } from '@rezics/document';
import { projectKnowledgePublicBody, projectKnowledgePublicProvenance } from './knowledge-disclosure.ts';
import { knowledgeDigest, type KnowledgeReference, type KnowledgeProvenance } from './knowledge-portable.ts';
import { createHash } from 'node:crypto';
import { accessCheck } from './access-port.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { ContentNotFoundError } from './reads.ts';
import { snapshot } from './reads.ts';
import type { Anchored, AnchoredPosition, ReadContext } from './model.ts';
import {
  KNOWLEDGE_ANCESTOR_LIMIT,
  KNOWLEDGE_OUTLINE_SCAN_LIMIT,
  KNOWLEDGE_PAGE_LIMIT,
  KnowledgeInvalidCursorError,
  KnowledgeInvalidInputError,
  KnowledgeNotFoundError,
  KnowledgeStaleCursorError,
  knowledgeSubjectTargets,
  type KnowledgeOutlinePageInput,
  type KnowledgePageInput,
  type KnowledgeStructureHistoryInput,
  type KnowledgeStructureChangeAction,
  type KnowledgeStructureChangeKind,
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
import { readKnowledgeOrderPage } from './knowledge-order.ts';

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
  reference_manifest: readonly KnowledgeReference[];
  copy_provenance: KnowledgeProvenance | null;
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
    references: [...row.reference_manifest],
    provenance: row.copy_provenance,
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
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,37})$/.test(value) && BigInt(value) < 10n ** 38n;
}

function validStructureRevisionNumber(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
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
  const projection = await projectKnowledgePublicBody(
    deps,
    parseDocument(JSON.parse(final.value.canonical_bytes.toString('utf8'))),
    final.value.reference_manifest,
    context.deadline,
  );
  const canonical = serializeDocument(projection.snapshot);
  const provenance = await projectKnowledgePublicProvenance(deps, final.value.copy_provenance, context.deadline);
  const current = await snapshot(deps, documentId, context, (client) =>
    knowledgePublicSelection(client, sourceRoute, documentId),
  );
  if (current.value?.publication_id !== selected.publication_id || !(await visible()))
    throw new KnowledgeNotFoundError();
  const value = {
    document: {
      ...baseDocument(final.value),
      canonicalBytes: Buffer.from(canonical).toString('base64'),
      sha256: knowledgeDigest(canonical),
      references: [...projection.references],
      provenance,
      publicationId: final.value.current_publication_id,
      subjectId: final.value.subject_id,
      publishedAt: final.value.published_at.toISOString(),
      // The first loop deliberately publishes deidentified attribution. Account erasure can therefore
      // retain an eligible selected revision without exposing an account identity through this read.
      authorId: null,
    },
  };
  const anchors: AnchoredPosition[] = [initial.anchor, final.anchor, current.anchor];
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
  revisionId?: string,
) {
  const sourceRoute = route(documentId);
  if (
    (revisionId !== undefined && route(revisionId) !== sourceRoute) ||
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
    const row = await knowledgePrivateRow(client, sourceRoute, notebookId, documentId, revisionId ?? null);
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
        ...baseDocument(result.value),
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

export async function readKnowledgeHistoricalOutline(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  revisionId: string,
  query: KnowledgeOutlinePageInput,
  context: ReadContext,
) {
  const sourceRoute = route(notebookId);
  const accountRoute = route(accountId);
  if (
    context.actor.kind !== 'account' ||
    context.actor.accountId !== accountId ||
    accountRoute !== sourceRoute ||
    route(revisionId) !== sourceRoute ||
    (query.parentPlacementId !== undefined && route(query.parentPlacementId) !== sourceRoute)
  )
    throw new KnowledgeNotFoundError();
  const parentId = query.parentPlacementId ?? null;
  const limit = query.limit ?? KNOWLEDGE_PAGE_LIMIT;
  const binding = knowledgeCursorBinding(
    'GET /v1/accounts/:accountId/knowledge/notebooks/:notebookId/outline@revision',
    accountId,
    { limit, notebookId, parentPlacementId: parentId, revisionId },
  );
  const cursor = await readCursor(deps, binding, query.cursor);
  if (
    cursor &&
    (cursor.after.length !== 2 ||
      !validCursorPosition(cursor.after[0]) ||
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
  const result = await snapshot(deps, notebookId, context, async (client) => {
    if (!(await check(client))) return null;
    const notebook = await knowledgeNotebookSelection(client, sourceRoute, notebookId);
    if (!notebook || notebook.owner_account_id !== accountId) return null;
    const selected = await client.query<{ revision_number: string; history_complete: boolean }>(
      `SELECT revision_number::text AS revision_number,history_complete
       FROM content.knowledge_structure_revision
       WHERE route=$1 AND notebook_id=$2 AND revision_id=$3`,
      [sourceRoute, notebookId, revisionId],
    );
    const structure = selected.rows[0];
    if (!structure?.history_complete) return null;

    if (parentId !== null) {
      const path = await knowledgeAncestorPath(client, sourceRoute, notebookId, parentId);
      if (path[0]?.placement_id !== parentId || !admitsKnowledgeAncestorPath(
        path.map(({ placement_id, parent_id }) => ({ placementId: placement_id, parentId: parent_id })),
      )) return null;
    }
    const root = await client.query<{ root_page_id: string | null }>(
      `SELECT root_page_id FROM content.knowledge_structure_parent_root
       WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3 AND revision_number <= $4
       ORDER BY revision_number DESC LIMIT 1`,
      [sourceRoute, notebookId, parentId, structure.revision_number],
    );
    if (root.rowCount === 0) return null;
    const candidates = await readKnowledgeOrderPage(
      client,
      sourceRoute,
      notebookId,
      root.rows[0]!.root_page_id,
      after ? { position: BigInt(after[0]!), placementId: after[1]! } : null,
      limit + 1,
    );
    const titles =
      candidates.length === 0
        ? { rows: [] as { document_id: string; title: string }[] }
        : await client.query<{ document_id: string; title: string }>(
            `SELECT document.document_id,revision.title
             FROM content.knowledge_document document
             JOIN content.knowledge_revision revision
               ON revision.route=document.route AND revision.document_id=document.document_id
              AND revision.revision_id=document.head_revision_id
             WHERE document.route=$1 AND document.notebook_id=$2 AND document.document_id=ANY($3::uuid[])
               AND content.knowledge_document_eligible(document.route,document.document_id)`,
            [sourceRoute, notebookId, candidates.map(({ documentId }) => documentId)],
          );
    const titleByDocument = new Map(titles.rows.map(({ document_id, title }) => [document_id, title]));
    return {
      revisionNumber: structure.revision_number,
      rootPageId: root.rows[0]!.root_page_id,
      placements: candidates.map((placement) => ({
        ...placement,
        title: titleByDocument.get(placement.documentId),
      })),
    };
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  if (cursor && cursor.epoch !== result.anchor.epoch) throw new KnowledgeStaleCursorError();
  const hasMore = result.value.placements.length > limit;
  const page = result.value.placements.slice(0, limit);
  const last = page.at(-1);
  const next =
    hasMore && last
      ? encodeCursor(
          deps.tokens,
          binding,
          { epoch: result.anchor.epoch, after: [last.position.toString(), last.placementId] },
          deps.clock().getTime(),
        )
      : null;
  return {
    value: {
      notebookId,
      structureRevisionId: revisionId,
      revisionNumber: result.value.revisionNumber,
      parentPlacementId: parentId,
      placements: page.filter((row) => row.title !== undefined).map((row) => ({
        placementId: row.placementId,
        documentId: row.documentId,
        parentPlacementId: row.parentId,
        position: row.position.toString(),
        title: row.title,
      })),
      next,
    },
    anchors: [result.anchor],
  };
}

export async function readKnowledgeStructureHistory(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  query: KnowledgeStructureHistoryInput,
  context: ReadContext,
) {
  const sourceRoute = route(notebookId);
  if (context.actor.kind !== 'account' || context.actor.accountId !== accountId || route(accountId) !== sourceRoute)
    throw new KnowledgeNotFoundError();
  const limit = query.limit ?? KNOWLEDGE_PAGE_LIMIT;
  const binding = knowledgeCursorBinding(
    'GET /v1/accounts/:accountId/knowledge/notebooks/:notebookId/history',
    accountId,
    { limit, notebookId },
  );
  const cursor = await readCursor(deps, binding, query.cursor);
  if (cursor && (cursor.after.length !== 1 || !validStructureRevisionNumber(cursor.after[0]))) invalidCursor();
  const after = cursor?.after[0];
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
    const revisions = await client.query<{
      revision_id: string;
      revision_number: string;
      history_complete: boolean;
      change_kind: KnowledgeStructureChangeKind;
      created_at: Date;
    }>(
      `SELECT revision_id,revision_number::text AS revision_number,history_complete,change_kind,created_at
       FROM content.knowledge_structure_revision
       WHERE route=$1 AND notebook_id=$2 AND ($3::bigint IS NULL OR revision_number < $3::bigint)
       ORDER BY revision_number DESC LIMIT $4`,
      [sourceRoute, notebookId, after ?? null, limit + 1],
    );
    const page = revisions.rows.slice(0, limit);
    const revisionNumbers = page.map(({ revision_number }) => revision_number);
    const changes =
      revisionNumbers.length === 0
        ? {
            rows: [] as {
              revision_number: string;
              placement_id: string;
              action: KnowledgeStructureChangeAction;
              previous_parent_id: string | null;
              previous_position: string | null;
              parent_id: string | null;
              position: string;
            }[],
          }
        : await client.query<{
            revision_number: string;
            placement_id: string;
            action: KnowledgeStructureChangeAction;
            previous_parent_id: string | null;
            previous_position: string | null;
            parent_id: string | null;
            position: string;
          }>(
            `SELECT revision_number::text AS revision_number,placement_id,action,previous_parent_id,
                    previous_position::text AS previous_position,parent_id,position::text AS position
             FROM content.knowledge_structure_change
             WHERE route=$1 AND notebook_id=$2 AND revision_number=ANY($3::bigint[])
             ORDER BY revision_number DESC,placement_id`,
            [sourceRoute, notebookId, revisionNumbers],
          );
    return {
      rows: page.map((revision) => ({
        ...revision,
        changes: changes.rows
          .filter((change) => change.revision_number === revision.revision_number)
          .map((change) => ({
            placementId: change.placement_id,
            action: change.action,
            previousParentPlacementId: change.previous_parent_id,
            previousPosition: change.previous_position,
            parentPlacementId: change.parent_id,
            position: change.position,
          })),
      })),
      hasMore: revisions.rows.length > limit,
    };
  });
  if (!result.value) throw new KnowledgeNotFoundError();
  if (cursor && cursor.epoch !== result.anchor.epoch) throw new KnowledgeStaleCursorError();
  const last = result.value.rows.at(-1);
  const next =
    result.value.hasMore && last
      ? encodeCursor(
          deps.tokens,
          binding,
          { epoch: result.anchor.epoch, after: [last.revision_number] },
          deps.clock().getTime(),
        )
      : null;
  return {
    value: {
      notebookId,
      revisions: result.value.rows.map((revision) => ({
        structureRevisionId: revision.revision_id,
        revisionNumber: revision.revision_number,
        historyAvailable: revision.history_complete,
        changeKind: revision.change_kind,
        createdAt: revision.created_at.toISOString(),
        changes: revision.changes,
      })),
      next,
    },
    anchors: [result.anchor],
  };
}

type PrivateRevisionHistoryRow = Readonly<{
  document_id: string;
  revision_id: string;
  title: string;
  language: string | null;
  body_sha256: Buffer;
  licence: string;
  created_at: Date;
  created_at_key: string;
}>;
type PrivateRevisionBodyRow = Readonly<{
  document_id: string;
  revision_id: string;
  title: string;
  language: string | null;
  canonical_bytes: Buffer;
  body_sha256: Buffer;
  licence: string;
  subject_ids: string[];
  reference_manifest: readonly KnowledgeReference[];
  copy_provenance: KnowledgeProvenance | null;
}>;
type PrivateRevisionSelection<Row> = Readonly<{ subjectId: string; revisions: Row[] }> | null;

function exactPrivateRevisions(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  revisionIds: null,
  after: Readonly<{ createdAt: string; revisionId: string }> | null,
  limit: number,
  context: ReadContext,
): Promise<Anchored<PrivateRevisionSelection<PrivateRevisionHistoryRow>>>;
function exactPrivateRevisions(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  revisionIds: readonly string[],
  after: null,
  limit: number,
  context: ReadContext,
): Promise<Anchored<PrivateRevisionSelection<PrivateRevisionBodyRow>>>;
async function exactPrivateRevisions(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  revisionIds: readonly string[] | null,
  after: Readonly<{ createdAt: string; revisionId: string }> | null,
  limit: number,
  context: ReadContext,
): Promise<Anchored<PrivateRevisionSelection<PrivateRevisionHistoryRow | PrivateRevisionBodyRow>>> {
  const sourceRoute = route(documentId);
  if (
    context.actor.kind !== 'account' ||
    context.actor.accountId !== accountId ||
    route(accountId) !== sourceRoute ||
    route(notebookId) !== sourceRoute ||
    revisionIds?.some((revisionId) => route(revisionId) !== sourceRoute)
  )
    throw new KnowledgeNotFoundError();
  const check = await accessCheck(
    deps.access,
    context.actor,
    'account:read',
    { route: sourceRoute, id: accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  return snapshot(deps, documentId, context, async (client) => {
    if (!(await check(client))) return null;
    const identity = await client.query<{ subject_id: string; placement_id: string }>(
      `SELECT notebook.subject_id,placement.placement_id
       FROM content.knowledge_document document
       JOIN content.knowledge_notebook notebook
         ON notebook.route=document.route AND notebook.notebook_id=document.notebook_id
       JOIN content.knowledge_placement placement
         ON placement.route=document.route AND placement.notebook_id=document.notebook_id
        AND placement.document_id=document.document_id
       WHERE document.route=$1 AND document.notebook_id=$2 AND document.document_id=$3
         AND notebook.owner_account_id=$4
         AND content.knowledge_document_eligible(document.route,document.document_id)`,
      [sourceRoute, notebookId, documentId, accountId],
    );
    const selected = identity.rows[0];
    if (!selected) return null;
    const path = await knowledgeAncestorPath(client, sourceRoute, notebookId, selected.placement_id);
    const stablePath = path.map(({ placement_id, parent_id }) => ({ placementId: placement_id, parentId: parent_id }));
    if (
      path.length > KNOWLEDGE_ANCESTOR_LIMIT + 1 ||
      path[0]?.placement_id !== selected.placement_id ||
      !admitsKnowledgeAncestorPath(stablePath)
    )
      return null;

    const revisions = revisionIds
      ? await client.query<PrivateRevisionBodyRow>(
          `SELECT document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,
                  reference_manifest,copy_provenance
           FROM content.knowledge_revision
           WHERE route=$1 AND document_id=$2 AND revision_id=ANY($3::uuid[])`,
          [sourceRoute, documentId, revisionIds],
        )
      : await client.query<PrivateRevisionHistoryRow>(
          `SELECT document_id,revision_id,title,language,body_sha256,licence,created_at,
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
           FROM content.knowledge_revision
           WHERE route=$1 AND document_id=$2
             AND ($3::timestamptz IS NULL OR (created_at,revision_id) < ($3::timestamptz,$4::uuid))
           ORDER BY created_at DESC,revision_id DESC LIMIT $5`,
          [sourceRoute, documentId, after?.createdAt ?? null, after?.revisionId ?? null, limit],
        );
    return { subjectId: selected.subject_id, revisions: revisions.rows };
  });
}

function revisionBytesAreSound(row: { canonical_bytes: Buffer; body_sha256: Buffer }): void {
  const digest = createHash('sha256').update(row.canonical_bytes).digest();
  if (!digest.equals(row.body_sha256)) throw new Error('Knowledge revision digest does not match its immutable bytes');
}

async function verifyKnowledgeSubjects(
  deps: KnowledgeDependencies,
  notebookSubjectId: string,
  revisions: readonly Readonly<{ subject_ids: string[] }>[],
  context: ReadContext,
) {
  const subjectIds = new Set<string>();
  for (const revision of revisions) {
    for (const subjectId of knowledgeSubjectTargets(notebookSubjectId, revision.subject_ids)) subjectIds.add(subjectId);
  }
  if (revisions.length === 0) subjectIds.add(notebookSubjectId);
  const subjects = [...subjectIds];
  const readSubjects = await prepareEditionSubjectIdentities(deps, subjects, {
    actor: context.actor,
    deadline: context.deadline,
  });
  const verify = async () => {
    const current = await readSubjects();
    return subjects.every((subjectId) => current.get(subjectId)?.kind === 'available');
  };
  if (!(await verify())) throw new KnowledgeNotFoundError();
  return verify;
}

export async function readKnowledgeDocumentHistory(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  query: KnowledgePageInput,
  context: ReadContext,
) {
  const sourceRoute = route(documentId);
  if (route(accountId) !== sourceRoute || route(notebookId) !== sourceRoute) throw new KnowledgeNotFoundError();
  const limit = query.limit ?? KNOWLEDGE_PAGE_LIMIT;
  const binding = knowledgeCursorBinding(
    'GET /v1/accounts/:accountId/knowledge/notebooks/:notebookId/documents/:documentId/history',
    accountId,
    { documentId, limit, notebookId },
  );
  const cursor = await readCursor(deps, binding, query.cursor);
  if (
    cursor &&
    (cursor.after.length !== 2 ||
      typeof cursor.after[0] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.after[0]) ||
      !validRoutedKey(cursor.after[1], sourceRoute))
  )
    invalidCursor();
  const after = cursor?.after as readonly string[] | undefined;
  const first = await exactPrivateRevisions(
    deps,
    accountId,
    notebookId,
    documentId,
    null,
    after ? { createdAt: after[0]!, revisionId: after[1]! } : null,
    limit + 1,
    context,
  );
  if (!first.value) throw new KnowledgeNotFoundError();
  const verifySubjects = await verifyKnowledgeSubjects(deps, first.value.subjectId, [], context);
  const second = await exactPrivateRevisions(
    deps,
    accountId,
    notebookId,
    documentId,
    null,
    after ? { createdAt: after[0]!, revisionId: after[1]! } : null,
    limit + 1,
    context,
  );
  if (!second.value || !(await verifySubjects())) throw new KnowledgeNotFoundError();
  if (cursor && (cursor.epoch !== first.anchor.epoch || cursor.epoch !== second.anchor.epoch))
    throw new KnowledgeStaleCursorError();
  const rows = second.value.revisions;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next =
    hasMore && last
      ? encodeCursor(
          deps.tokens,
          binding,
          { epoch: second.anchor.epoch, after: [last.created_at_key, last.revision_id] },
          deps.clock().getTime(),
        )
      : null;
  return {
    value: {
      documentId,
      revisions: page.map((row) => ({
        revisionId: row.revision_id,
        title: row.title,
        language: row.language,
        sha256: row.body_sha256.toString('hex'),
        licence: row.licence,
        createdAt: row.created_at.toISOString(),
      })),
      next,
    },
    anchors: [first.anchor, second.anchor],
  };
}

export async function readKnowledgeDocumentCompare(
  deps: KnowledgeDependencies,
  accountId: string,
  notebookId: string,
  documentId: string,
  revisionIds: readonly [string, string],
  context: ReadContext,
) {
  if (revisionIds[0] === revisionIds[1]) throw new KnowledgeInvalidInputError();
  const first = await exactPrivateRevisions(deps, accountId, notebookId, documentId, revisionIds, null, 2, context);
  if (!first.value || first.value.revisions.length !== 2) throw new KnowledgeNotFoundError();
  const byId = new Map(first.value.revisions.map((row) => [row.revision_id, row]));
  const left = byId.get(revisionIds[0]);
  const right = byId.get(revisionIds[1]);
  if (!left || !right) throw new KnowledgeNotFoundError();
  const verifySubjects = await verifyKnowledgeSubjects(deps, first.value.subjectId, [left, right], context);
  revisionBytesAreSound(left);
  revisionBytesAreSound(right);

  const second = await exactPrivateRevisions(deps, accountId, notebookId, documentId, revisionIds, null, 2, context);
  if (!second.value || !(await verifySubjects())) throw new KnowledgeNotFoundError();
  if (first.anchor.epoch !== second.anchor.epoch) throw new KnowledgeStaleCursorError();
  return {
    value: {
      documentId,
      left: baseDocument(left),
      right: baseDocument(right),
    },
    anchors: [first.anchor, second.anchor],
  };
}
