import {
  validateKnowledgeReferences,
  type KnowledgeReference,
  type KnowledgeProvenance,
} from './knowledge-portable.ts';
import type { AccessClient, Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { accessCheck } from './access-port.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { RevisionPreconditionError, ContentForbiddenError } from './commands.ts';
import { validateContentDocument } from './document.ts';
import {
  KNOWLEDGE_ANCESTOR_LIMIT,
  KNOWLEDGE_ORDER_GAP,
  KNOWLEDGE_REBALANCE_SIDE_LIMIT,
  KnowledgeInvalidInputError,
  KnowledgeNotFoundError,
  knowledgeSubjectTargets,
  type KnowledgeCommandContext,
  type KnowledgeCreateDocumentInput,
  type KnowledgeCreateNotebookInput,
  type KnowledgeDependencies,
  type KnowledgeDocumentInput,
  type KnowledgeMovePlacementInput,
  type KnowledgePublicationInput,
  type KnowledgeReviseDocumentInput,
  type KnowledgeStructureChangeAction,
  type KnowledgeStructureChangeKind,
} from './knowledge-model.ts';
import { isCompleteStableAncestorPath, type StableAncestor } from './hosted-chapters-tree.ts';
import {
  knowledgeAncestorPath,
  knowledgeNotebookOwner,
  knowledgeOwner,
  knowledgeSelectedSubject,
} from './knowledge-store.ts';
import { insertKnowledgeOrderEntry, removeKnowledgeOrderEntry } from './knowledge-order.ts';

const PUBLICATION_EVENT = 'com.rezics.content.knowledge.publication.changed.v1';
const NOTEBOOK_CREATED_EVENT = 'com.rezics.content.knowledge.notebook.created.v1';
const DOCUMENT_CREATED_EVENT = 'com.rezics.content.knowledge.document.created.v1';
const DOCUMENT_REVISED_EVENT = 'com.rezics.content.knowledge.document.revised.v1';
const STRUCTURE_CHANGED_EVENT = 'com.rezics.content.knowledge.structure.changed.v1';
const MAX_KNOWLEDGE_POSITION = 10n ** 38n - 1n;

type KnowledgePlacementState = Readonly<{
  placement_id: string;
  document_id: string;
  parent_id: string | null;
  position: string;
  subtree_height: number;
}>;

type KnowledgePositionChange = Readonly<{
  placementId: string;
  documentId: string;
  oldParentId: string | null;
  oldPosition: bigint | null;
  parentId: string | null;
  position: bigint;
  action: KnowledgeStructureChangeAction;
}>;

function accountId(actor: Actor): string {
  if (actor.kind !== 'account') throw new KnowledgeNotFoundError();
  return actor.accountId;
}

function routed(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new KnowledgeNotFoundError();
  return route;
}

async function accountUpdateAuthorization(
  deps: KnowledgeDependencies,
  actor: Actor,
  ownerId: string,
  context: KnowledgeCommandContext,
): Promise<CommandAuthorization> {
  const route = routed(ownerId);
  if (actor.kind !== 'account' || actor.accountId !== ownerId) throw new KnowledgeNotFoundError();
  const check = await accessCheck(
    deps.access,
    actor,
    'account:update',
    { route, id: ownerId },
    { pool: deps.pool, deadline: context.deadline },
  );
  return {
    action: 'account:update',
    resource: { route, id: ownerId },
    async authorize(tx) {
      if (!(await check(tx as AccessClient))) throw new ContentForbiddenError();
      return 'execute';
    },
    denied: () => new ContentForbiddenError(),
  };
}

async function preparePublicSubjects(
  deps: KnowledgeDependencies,
  subjectId: string,
  references: readonly string[],
  deadline: number,
): Promise<() => Promise<boolean>> {
  const subjects = knowledgeSubjectTargets(subjectId, references);
  const context = { actor: { kind: 'anonymous' as const }, deadline };
  const read = await prepareEditionSubjectIdentities(deps, subjects, context);
  const verify = async () => {
    const current = await read();
    return subjects.every((id) => current.get(id)?.kind === 'available');
  };
  if (!(await verify())) throw new KnowledgeNotFoundError();
  return verify;
}

type StoredBody = Readonly<{
  canonicalBytes: Buffer;
  sha256: Buffer;
  licence: string;
  subjectIds: readonly string[];
  title: string;
  language: string | null;
  references: readonly KnowledgeReference[];
}>;

function storedBody(input: KnowledgeDocumentInput): StoredBody {
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.includes('\0') ||
    input.title.length > 512 ||
    (input.language !== undefined && input.language !== null && input.language.includes('\0'))
  )
    throw new KnowledgeInvalidInputError();
  const validated = validateContentDocument({
    body: input.body,
    licence: input.licence,
    subjectIds: input.subjectIds,
  });
  return {
    canonicalBytes: Buffer.from(validated.canonicalBytes),
    sha256: Buffer.from(validated.sha256, 'hex'),
    licence: validated.licence,
    subjectIds: validated.subjectIds,
    title: input.title,
    language: input.language ?? null,
    references: validateKnowledgeReferences(validated.snapshot, input.references),
  };
}

function commandOptions(
  actor: Actor,
  route: number,
  context: KnowledgeCommandContext,
  kind: string,
  resourceId: string,
  input: unknown,
  authorization: CommandAuthorization,
) {
  return {
    ...principalCommandIdentity(actor),
    partition: partitionOf(route),
    deadline: context.deadline,
    receipt: {
      kind,
      key: context.idempotencyKey,
      digest: requestDigest(kind, actor, { resourceId, input }),
    },
    authorization,
  };
}

async function knowledgeStructureRoot(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  parentId: string | null,
  revisionNumber: bigint,
): Promise<string | null> {
  const result = await tx.query<{ root_page_id: string | null }>(
    `SELECT root_page_id FROM content.knowledge_structure_parent_root
     WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3 AND revision_number <= $4
     ORDER BY revision_number DESC LIMIT 1`,
    [route, notebookId, parentId, revisionNumber.toString()],
  );
  return result.rows[0]?.root_page_id ?? null;
}

async function saveKnowledgeStructureRoot(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  parentId: string | null,
  revisionNumber: bigint,
  rootPageId: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO content.knowledge_structure_parent_root(route,notebook_id,parent_id,revision_number,root_page_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [route, notebookId, parentId, revisionNumber.toString(), rootPageId],
  );
}

async function saveKnowledgeStructureRevision(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  revisionId: string,
  revisionNumber: bigint,
  transactionId: string,
  time: AuthoritativeTime,
  changeKind: KnowledgeStructureChangeKind,
): Promise<void> {
  await tx.query(
    `INSERT INTO content.knowledge_structure_revision
      (route,notebook_id,revision_id,revision_number,history_complete,change_kind,recorded_transaction_id,created_at)
     VALUES ($1,$2,$3,$4,true,$5,$6,$7)`,
    [route, notebookId, revisionId, revisionNumber.toString(), changeKind, transactionId, authoritativeTimeValue(time)],
  );
}

async function saveKnowledgeStructureChange(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  revisionNumber: bigint,
  change: KnowledgePositionChange,
): Promise<void> {
  await tx.query(
    `INSERT INTO content.knowledge_structure_change
      (route,notebook_id,revision_number,placement_id,action,previous_parent_id,previous_position,parent_id,position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      route,
      notebookId,
      revisionNumber.toString(),
      change.placementId,
      change.action,
      change.oldParentId,
      change.oldPosition?.toString() ?? null,
      change.parentId,
      change.position.toString(),
    ],
  );
}

async function refreshKnowledgeSubtreeHeights(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  ancestors: readonly (readonly Readonly<{ placement_id: string }>[])[],
): Promise<void> {
  for (const path of ancestors) {
    for (const ancestor of path) {
      const child = await tx.query<{ subtree_height: number }>(
        `SELECT subtree_height FROM content.knowledge_placement
         WHERE route=$1 AND notebook_id=$2 AND parent_id=$3
         ORDER BY subtree_height DESC,placement_id LIMIT 1`,
        [route, notebookId, ancestor.placement_id],
      );
      const height = child.rows[0] ? child.rows[0].subtree_height + 1 : 0;
      if (height > KNOWLEDGE_ANCESTOR_LIMIT) throw new KnowledgeInvalidInputError();
      await tx.query(
        `UPDATE content.knowledge_placement SET subtree_height=$4
         WHERE route=$1 AND notebook_id=$2 AND placement_id=$3`,
        [route, notebookId, ancestor.placement_id, height],
      );
    }
  }
}

async function siblingAtPosition(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  parentId: string | null,
  movingPlacementId: string,
  beforePosition: bigint | null,
): Promise<Readonly<{ placement_id: string; position: string }> | null> {
  const result = await tx.query<{ placement_id: string; position: string }>(
    `SELECT placement_id,position::text AS position FROM content.knowledge_placement
     WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3
       AND placement_id<>$4 AND ($5::numeric IS NULL OR position < $5)
     ORDER BY position DESC,placement_id DESC LIMIT 1`,
    [route, notebookId, parentId, movingPlacementId, beforePosition?.toString() ?? null],
  );
  return result.rows[0] ?? null;
}

async function rebalanceKnowledgeSiblings(
  tx: import('../command/command.ts').CommandTransaction,
  route: number,
  notebookId: string,
  parentId: string | null,
  moving: KnowledgePlacementState,
  destinationParentId: string | null,
  beforePlacementId: string | null,
  beforePosition: bigint | null,
): Promise<readonly KnowledgePositionChange[]> {
  const parameters = [route, notebookId, parentId, moving.placement_id, beforePosition?.toString() ?? null];
  const [leftResult, rightResult] = await Promise.all([
    tx.query<{ placement_id: string; document_id: string; parent_id: string | null; position: string }>(
      `SELECT placement_id,document_id,parent_id,position::text AS position FROM content.knowledge_placement
       WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3
         AND placement_id<>$4 AND ($5::numeric IS NULL OR position < $5)
       ORDER BY position DESC,placement_id DESC LIMIT $6`,
      [...parameters, KNOWLEDGE_REBALANCE_SIDE_LIMIT + 1],
    ),
    beforePosition === null
      ? Promise.resolve({
          rows: [] as { placement_id: string; document_id: string; parent_id: string | null; position: string }[],
        })
      : tx.query<{ placement_id: string; document_id: string; parent_id: string | null; position: string }>(
          `SELECT placement_id,document_id,parent_id,position::text AS position FROM content.knowledge_placement
           WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3
             AND placement_id<>$4 AND position >= $5
           ORDER BY position,placement_id LIMIT $6`,
          [...parameters.slice(0, 4), beforePosition.toString(), KNOWLEDGE_REBALANCE_SIDE_LIMIT + 1],
        ),
  ]);

  const leftRows = leftResult.rows;
  const rightRows = rightResult.rows;
  const selectedLeft = leftRows.slice(0, KNOWLEDGE_REBALANCE_SIDE_LIMIT).reverse();
  const selectedRight = rightRows.slice(0, KNOWLEDGE_REBALANCE_SIDE_LIMIT);
  const lower =
    leftRows.length > KNOWLEDGE_REBALANCE_SIDE_LIMIT ? BigInt(leftRows[KNOWLEDGE_REBALANCE_SIDE_LIMIT]!.position) : -1n;
  const upper =
    rightRows.length > KNOWLEDGE_REBALANCE_SIDE_LIMIT
      ? BigInt(rightRows[KNOWLEDGE_REBALANCE_SIDE_LIMIT]!.position)
      : MAX_KNOWLEDGE_POSITION + 1n;
  const ordered = [...selectedLeft, ...selectedRight];
  const insertAt =
    beforePlacementId === null ? ordered.length : ordered.findIndex((row) => row.placement_id === beforePlacementId);
  if (insertAt < 0) throw new KnowledgeNotFoundError();
  type RebalanceSibling = (typeof ordered)[number] | (typeof moving & Readonly<{ moving: true }>);
  const desired: RebalanceSibling[] = [
    ...ordered.slice(0, insertAt),
    { ...moving, moving: true },
    ...ordered.slice(insertAt),
  ];
  const step = (upper - lower) / BigInt(desired.length + 1);
  if (step < 1n) throw new KnowledgeInvalidInputError();
  return desired.flatMap((row, index) => {
    const position = lower + step * BigInt(index + 1);
    if (position < 0n || position > MAX_KNOWLEDGE_POSITION) throw new KnowledgeInvalidInputError();
    if ('moving' in row) {
      return [
        {
          placementId: moving.placement_id,
          documentId: moving.document_id,
          oldParentId: moving.parent_id,
          oldPosition: BigInt(moving.position),
          parentId: destinationParentId,
          position,
          action: moving.parent_id === destinationParentId ? 'placement_reordered' : 'placement_moved',
        } satisfies KnowledgePositionChange,
      ];
    }
    const oldPosition = BigInt(row.position);
    return oldPosition === position
      ? []
      : [
          {
            placementId: row.placement_id,
            documentId: row.document_id,
            oldParentId: row.parent_id,
            oldPosition,
            parentId: row.parent_id,
            position,
            action: 'order_rebalanced' as const,
          },
        ];
  });
}

export async function createKnowledgeNotebook(
  deps: KnowledgeDependencies,
  actor: Actor,
  input: KnowledgeCreateNotebookInput,
  context: KnowledgeCommandContext,
) {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\0') || input.title.length > 256)
    throw new KnowledgeInvalidInputError();
  const owner = accountId(actor);
  const route = routed(owner);
  const notebookId = newId(route);
  const structureRevisionId = newId(route);
  const kind = 'content.knowledge.notebook.create';
  const authorization = await accountUpdateAuthorization(deps, actor, owner, context);
  const verifySubject = await preparePublicSubjects(deps, input.subjectId, [], context.deadline);
  authorization.prepare = async () => {
    if (!(await verifySubject())) throw new KnowledgeNotFoundError();
  };
  return runCommand(
    deps.pool,
    commandOptions(actor, route, context, kind, notebookId, input, authorization),
    async (tx, { transactionId, time }) => {
      const inserted = await tx.query(
        `INSERT INTO content.knowledge_notebook
          (route,notebook_id,owner_account_id,subject_id,title,structure_revision_id,structure_revision_number,created_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8) ON CONFLICT (route,notebook_id) DO NOTHING RETURNING notebook_id`,
        [
          route,
          notebookId,
          owner,
          input.subjectId,
          input.title,
          structureRevisionId,
          transactionId,
          authoritativeTimeValue(time),
        ],
      );
      if (!inserted.rowCount) throw new RevisionPreconditionError();
      await saveKnowledgeStructureRevision(
        tx,
        route,
        notebookId,
        structureRevisionId,
        1n,
        transactionId,
        time,
        'notebook_created',
      );
      await saveKnowledgeStructureRoot(tx, route, notebookId, null, 1n, null);
      return {
        value: { notebookId, structureRevisionId },
        events: [
          {
            type: NOTEBOOK_CREATED_EVENT,
            subject: notebookId,
            data: { notebookId, subjectId: input.subjectId, structureRevisionId },
          },
          {
            type: STRUCTURE_CHANGED_EVENT,
            subject: notebookId,
            data: {
              notebookId,
              structureRevisionId,
              revisionNumber: '1',
              action: 'notebook_created',
              placementId: null,
            },
          },
        ],
      };
    },
  );
}

export async function createKnowledgeDocument(
  deps: KnowledgeDependencies,
  actor: Actor,
  notebookId: string,
  input: KnowledgeCreateDocumentInput,
  context: KnowledgeCommandContext,
) {
  return writeKnowledgeDocument(deps, actor, notebookId, input, context, {
    kind: 'content.knowledge.document.create',
    receiptInput: input,
    prepare: async () => ({ input, provenance: null }),
  });
}

/** Shared destination path: account authority, structure CAS, ancestry, private insert, event and receipt. */
export async function writeKnowledgeDocument(
  deps: KnowledgeDependencies,
  actor: Actor,
  notebookId: string,
  placement: Readonly<{ expectedStructureRevisionId: string; parentPlacementId: string | null }>,
  context: KnowledgeCommandContext,
  source: Readonly<{
    kind: string;
    receiptInput: unknown;
    prepare: () => Promise<Readonly<{ input: KnowledgeDocumentInput; provenance: KnowledgeProvenance | null }>>;
  }>,
) {
  const route = routed(notebookId);
  const owner = await knowledgeNotebookOwner(deps.pool, notebookId);
  if (!owner || owner.route !== route) throw new KnowledgeNotFoundError();
  const ownerId = owner.owner_account_id;
  const authorization = await accountUpdateAuthorization(deps, actor, ownerId, context);
  let document: StoredBody;
  let provenance: KnowledgeProvenance | null;
  authorization.prepare = async () => {
    const selected = await source.prepare();
    document = storedBody(selected.input);
    provenance = selected.provenance;
  };
  const documentId = newId(route);
  const revisionId = newId(route);
  const placementId = newId(route);
  const structureRevisionId = newId(route);
  const kind = source.kind;
  return runCommand(
    deps.pool,
    commandOptions(actor, route, context, kind, notebookId, source.receiptInput, authorization),
    async (tx, { transactionId, time }) => {
      const current = await tx.query<{
        owner_account_id: string;
        structure_revision_id: string;
        structure_revision_number: string;
      }>(
        `SELECT owner_account_id,structure_revision_id,structure_revision_number FROM content.knowledge_notebook
         WHERE route=$1 AND notebook_id=$2 FOR UPDATE`,
        [route, notebookId],
      );
      const notebook = current.rows[0];
      if (!notebook || notebook.owner_account_id !== ownerId) throw new KnowledgeNotFoundError();
      if (notebook.structure_revision_id !== placement.expectedStructureRevisionId)
        throw new RevisionPreconditionError();
      const parentId = placement.parentPlacementId;
      let parentPath: readonly Readonly<{ placement_id: string; parent_id: string | null }>[] = [];
      if (parentId !== null) {
        const path = await knowledgeAncestorPath(tx, route, notebookId, parentId);
        parentPath = path;
        const stablePath: StableAncestor[] = path.map((item) => ({
          placementId: item.placement_id,
          parentId: item.parent_id,
        }));
        if (
          path[0]?.placement_id !== parentId ||
          path.length > KNOWLEDGE_ANCESTOR_LIMIT ||
          !isCompleteStableAncestorPath(stablePath, KNOWLEDGE_ANCESTOR_LIMIT - 1)
        )
          throw new KnowledgeInvalidInputError();
      }
      const currentRevisionNumber = BigInt(notebook.structure_revision_number);
      const nextRevisionNumber = currentRevisionNumber + 1n;
      const nextPosition = await tx.query<{ position: string }>(
        `SELECT COALESCE(MAX(position)+$4::numeric,0)::text AS position
         FROM content.knowledge_placement
         WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3`,
        [route, notebookId, parentId, KNOWLEDGE_ORDER_GAP.toString()],
      );
      const position = BigInt(nextPosition.rows[0]!.position);
      await tx.query(
        `INSERT INTO content.knowledge_document(route,document_id,notebook_id,head_revision_id,created_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [route, documentId, notebookId, revisionId, transactionId, authoritativeTimeValue(time)],
      );
      await tx.query(
        `INSERT INTO content.knowledge_revision
          (route,document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,author_account_id,recorded_transaction_id,created_at,reference_manifest,copy_provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          route,
          documentId,
          revisionId,
          document.title,
          document.language,
          document.canonicalBytes,
          document.sha256,
          document.licence,
          document.subjectIds,
          accountId(actor),
          transactionId,
          authoritativeTimeValue(time),
          JSON.stringify(document.references),
          provenance === null ? null : JSON.stringify(provenance),
        ],
      );
      await tx.query(
        `INSERT INTO content.knowledge_placement(route,notebook_id,placement_id,document_id,parent_id,position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [route, notebookId, placementId, documentId, parentId, position.toString()],
      );
      await saveKnowledgeStructureRevision(
        tx,
        route,
        notebookId,
        structureRevisionId,
        nextRevisionNumber,
        transactionId,
        time,
        'placement_added',
      );
      const currentRoot = await knowledgeStructureRoot(tx, route, notebookId, parentId, currentRevisionNumber);
      const rootPageId = await insertKnowledgeOrderEntry(tx, route, notebookId, currentRoot, {
        placementId,
        documentId,
        parentId,
        position,
      });
      await saveKnowledgeStructureRoot(tx, route, notebookId, parentId, nextRevisionNumber, rootPageId);
      await saveKnowledgeStructureRoot(tx, route, notebookId, placementId, nextRevisionNumber, null);
      await saveKnowledgeStructureChange(tx, route, notebookId, nextRevisionNumber, {
        placementId,
        documentId,
        oldParentId: null,
        oldPosition: null,
        parentId,
        position,
        action: 'placement_added',
      });
      await refreshKnowledgeSubtreeHeights(tx, route, notebookId, [parentPath]);
      await tx.query(
        `UPDATE content.knowledge_notebook SET structure_revision_id=$3,structure_revision_number=$4
         WHERE route=$1 AND notebook_id=$2`,
        [route, notebookId, structureRevisionId, nextRevisionNumber.toString()],
      );
      return {
        value: { notebookId, documentId, placementId, revisionId, structureRevisionId },
        events: [
          {
            type: DOCUMENT_CREATED_EVENT,
            subject: documentId,
            data: { notebookId, documentId, placementId, revisionId, structureRevisionId },
          },
          {
            type: STRUCTURE_CHANGED_EVENT,
            subject: notebookId,
            data: {
              notebookId,
              structureRevisionId,
              revisionNumber: nextRevisionNumber.toString(),
              action: 'placement_added',
              placementId,
            },
          },
        ],
      };
    },
  );
}

export async function moveKnowledgePlacement(
  deps: KnowledgeDependencies,
  actor: Actor,
  notebookId: string,
  placementId: string,
  input: KnowledgeMovePlacementInput,
  context: KnowledgeCommandContext,
) {
  const route = routed(notebookId);
  if (
    routed(placementId) !== route ||
    (input.destinationParentPlacementId !== null && routed(input.destinationParentPlacementId) !== route) ||
    (input.beforePlacementId !== null && routed(input.beforePlacementId) !== route)
  )
    throw new KnowledgeNotFoundError();
  if (input.beforePlacementId === placementId) throw new KnowledgeInvalidInputError();

  const notebookOwner = await knowledgeNotebookOwner(deps.pool, notebookId);
  if (!notebookOwner || notebookOwner.route !== route) throw new KnowledgeNotFoundError();
  const authorization = await accountUpdateAuthorization(deps, actor, notebookOwner.owner_account_id, context);
  const verifySubject = await preparePublicSubjects(deps, notebookOwner.subject_id, [], context.deadline);
  authorization.prepare = async () => {
    if (!(await verifySubject())) throw new KnowledgeNotFoundError();
  };

  const structureRevisionId = newId(route);
  const kind = 'content.knowledge.placement.move';
  return runCommand(
    deps.pool,
    commandOptions(actor, route, context, kind, placementId, { notebookId, ...input }, authorization),
    async (tx, { transactionId, time }) => {
      const current = await tx.query<{
        owner_account_id: string;
        structure_revision_id: string;
        structure_revision_number: string;
      }>(
        `SELECT owner_account_id,structure_revision_id,structure_revision_number FROM content.knowledge_notebook
         WHERE route=$1 AND notebook_id=$2 FOR UPDATE`,
        [route, notebookId],
      );
      const notebook = current.rows[0];
      if (!notebook || notebook.owner_account_id !== notebookOwner.owner_account_id) throw new KnowledgeNotFoundError();
      if (notebook.structure_revision_id !== input.expectedStructureRevisionId) throw new RevisionPreconditionError();

      const selected = await tx.query<KnowledgePlacementState>(
        `SELECT placement_id,document_id,parent_id,position::text AS position,subtree_height
         FROM content.knowledge_placement WHERE route=$1 AND notebook_id=$2 AND placement_id=$3`,
        [route, notebookId, placementId],
      );
      const moving = selected.rows[0];
      if (!moving) throw new KnowledgeNotFoundError();
      const sourcePath = await knowledgeAncestorPath(tx, route, notebookId, placementId);
      const stableSourcePath: StableAncestor[] = sourcePath.map(({ placement_id, parent_id }) => ({
        placementId: placement_id,
        parentId: parent_id,
      }));
      if (
        sourcePath[0]?.placement_id !== placementId ||
        sourcePath.length > KNOWLEDGE_ANCESTOR_LIMIT + 1 ||
        !isCompleteStableAncestorPath(stableSourcePath, KNOWLEDGE_ANCESTOR_LIMIT)
      )
        throw new KnowledgeInvalidInputError();
      const sourceParentPath = sourcePath.slice(1);

      const destinationPath =
        input.destinationParentPlacementId === null
          ? []
          : await knowledgeAncestorPath(tx, route, notebookId, input.destinationParentPlacementId);
      if (
        (input.destinationParentPlacementId !== null &&
          (destinationPath[0]?.placement_id !== input.destinationParentPlacementId ||
            destinationPath.length > KNOWLEDGE_ANCESTOR_LIMIT + 1 ||
            !isCompleteStableAncestorPath(
              destinationPath.map(({ placement_id, parent_id }) => ({
                placementId: placement_id,
                parentId: parent_id,
              })),
              KNOWLEDGE_ANCESTOR_LIMIT,
            ))) ||
        destinationPath.some(({ placement_id }) => placement_id === placementId) ||
        destinationPath.length > KNOWLEDGE_ANCESTOR_LIMIT + 1
      )
        throw new KnowledgeInvalidInputError();
      if (destinationPath.length + moving.subtree_height > KNOWLEDGE_ANCESTOR_LIMIT)
        throw new KnowledgeInvalidInputError();

      let beforePosition: bigint | null = null;
      if (input.beforePlacementId !== null) {
        const anchor = await tx.query<{ parent_id: string | null; position: string }>(
          `SELECT parent_id,position::text AS position FROM content.knowledge_placement
           WHERE route=$1 AND notebook_id=$2 AND placement_id=$3`,
          [route, notebookId, input.beforePlacementId],
        );
        const row = anchor.rows[0];
        if (!row || row.parent_id !== input.destinationParentPlacementId) throw new KnowledgeNotFoundError();
        beforePosition = BigInt(row.position);
      }

      const sameParent = moving.parent_id === input.destinationParentPlacementId;
      if (sameParent) {
        const next = await tx.query<{ placement_id: string }>(
          `SELECT placement_id FROM content.knowledge_placement
           WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3
             AND (position,placement_id) > ($4,$5)
           ORDER BY position,placement_id LIMIT 1`,
          [route, notebookId, moving.parent_id, moving.position, placementId],
        );
        const currentNext = next.rows[0]?.placement_id ?? null;
        if (currentNext === input.beforePlacementId)
          return noEffect({ notebookId, placementId, structureRevisionId: notebook.structure_revision_id });
      }

      const currentRevisionNumber = BigInt(notebook.structure_revision_number);
      const nextRevisionNumber = currentRevisionNumber + 1n;
      const currentPosition = BigInt(moving.position);
      const left = await siblingAtPosition(
        tx,
        route,
        notebookId,
        input.destinationParentPlacementId,
        placementId,
        beforePosition,
      );
      const leftPosition = left ? BigInt(left.position) : null;
      let nextPosition: bigint | null = null;
      if (beforePosition === null) {
        if (leftPosition === null) nextPosition = 0n;
        else if (leftPosition + KNOWLEDGE_ORDER_GAP <= MAX_KNOWLEDGE_POSITION)
          nextPosition = leftPosition + KNOWLEDGE_ORDER_GAP;
      } else if (leftPosition === null) {
        if (beforePosition >= KNOWLEDGE_ORDER_GAP) nextPosition = beforePosition - KNOWLEDGE_ORDER_GAP;
      } else if (beforePosition - leftPosition > 1n) {
        nextPosition = leftPosition + (beforePosition - leftPosition) / 2n;
      }

      let changes: readonly KnowledgePositionChange[];
      if (nextPosition === null) {
        changes = await rebalanceKnowledgeSiblings(
          tx,
          route,
          notebookId,
          input.destinationParentPlacementId,
          moving,
          input.destinationParentPlacementId,
          input.beforePlacementId,
          beforePosition,
        );
      } else {
        changes = [
          {
            placementId,
            documentId: moving.document_id,
            oldParentId: moving.parent_id,
            oldPosition: currentPosition,
            parentId: input.destinationParentPlacementId,
            position: nextPosition,
            action: sameParent ? 'placement_reordered' : 'placement_moved',
          },
        ];
      }
      const moved = changes.find(({ placementId: changedId }) => changedId === placementId);
      if (!moved) throw new Error('Knowledge move did not produce the selected placement change');

      await saveKnowledgeStructureRevision(
        tx,
        route,
        notebookId,
        structureRevisionId,
        nextRevisionNumber,
        transactionId,
        time,
        sameParent ? 'placement_reordered' : 'placement_moved',
      );

      const roots = new Map<string, { parentId: string | null; rootPageId: string | null }>();
      const rootKey = (parentId: string | null) => parentId ?? '';
      const ensureRoot = async (parentId: string | null) => {
        const key = rootKey(parentId);
        const existing = roots.get(key);
        if (existing) return existing;
        const rootPageId = await knowledgeStructureRoot(tx, route, notebookId, parentId, currentRevisionNumber);
        const root = { parentId, rootPageId };
        roots.set(key, root);
        return root;
      };
      for (const change of changes) {
        const root = await ensureRoot(change.oldParentId);
        const removed = await removeKnowledgeOrderEntry(tx, route, notebookId, root.rootPageId, {
          placementId: change.placementId,
          position: change.oldPosition!,
        });
        if (!removed.removed) throw new Error('Knowledge move could not find its previous ordered placement');
        root.rootPageId = removed.rootPageId;
      }
      for (const change of changes) {
        const root = await ensureRoot(change.parentId);
        root.rootPageId = await insertKnowledgeOrderEntry(tx, route, notebookId, root.rootPageId, {
          placementId: change.placementId,
          documentId: change.documentId,
          parentId: change.parentId,
          position: change.position,
        });
      }

      for (const change of changes) {
        await tx.query(
          `UPDATE content.knowledge_placement SET parent_id=$4,position=$5
           WHERE route=$1 AND notebook_id=$2 AND placement_id=$3`,
          [route, notebookId, change.placementId, change.parentId, change.position.toString()],
        );
        await saveKnowledgeStructureChange(tx, route, notebookId, nextRevisionNumber, change);
      }
      if (!sameParent) {
        await refreshKnowledgeSubtreeHeights(tx, route, notebookId, [sourceParentPath, destinationPath]);
      }
      for (const root of roots.values())
        await saveKnowledgeStructureRoot(tx, route, notebookId, root.parentId, nextRevisionNumber, root.rootPageId);

      await tx.query(
        `UPDATE content.knowledge_notebook SET structure_revision_id=$3,structure_revision_number=$4
         WHERE route=$1 AND notebook_id=$2`,
        [route, notebookId, structureRevisionId, nextRevisionNumber.toString()],
      );
      return {
        value: { notebookId, placementId, structureRevisionId },
        events: [
          {
            type: STRUCTURE_CHANGED_EVENT,
            subject: notebookId,
            data: {
              notebookId,
              structureRevisionId,
              revisionNumber: nextRevisionNumber.toString(),
              action: sameParent ? 'placement_reordered' : 'placement_moved',
              placementId,
            },
          },
        ],
      };
    },
  );
}

export async function reviseKnowledgeDocument(
  deps: KnowledgeDependencies,
  actor: Actor,
  documentId: string,
  input: KnowledgeReviseDocumentInput,
  context: KnowledgeCommandContext,
) {
  const owner = await knowledgeOwner(deps.pool, documentId);
  if (!owner) throw new KnowledgeNotFoundError();
  const authorization = await accountUpdateAuthorization(deps, actor, owner.owner_account_id, context);
  const document = storedBody(input);
  const revisionId = newId(owner.route);
  const kind = 'content.knowledge.document.revise';
  return runCommand(
    deps.pool,
    commandOptions(actor, owner.route, context, kind, documentId, input, authorization),
    async (tx, { transactionId, time }) => {
      const current = await tx.query<{ head_revision_id: string; notebook_id: string }>(
        `SELECT head_revision_id,notebook_id FROM content.knowledge_document
         WHERE route=$1 AND document_id=$2 FOR UPDATE`,
        [owner.route, documentId],
      );
      const row = current.rows[0];
      if (!row || row.notebook_id !== owner.notebook_id) throw new KnowledgeNotFoundError();
      if (row.head_revision_id !== input.expectedHeadRevisionId) throw new RevisionPreconditionError();
      await tx.query(
        `INSERT INTO content.knowledge_revision
          (route,document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,author_account_id,recorded_transaction_id,created_at,reference_manifest,copy_provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           (SELECT copy_provenance FROM content.knowledge_revision WHERE route=$1 AND document_id=$2 AND revision_id=$14))`,
        [
          owner.route,
          documentId,
          revisionId,
          document.title,
          document.language,
          document.canonicalBytes,
          document.sha256,
          document.licence,
          document.subjectIds,
          accountId(actor),
          transactionId,
          authoritativeTimeValue(time),
          JSON.stringify(document.references),
          row.head_revision_id,
        ],
      );
      await tx.query(`UPDATE content.knowledge_document SET head_revision_id=$3 WHERE route=$1 AND document_id=$2`, [
        owner.route,
        documentId,
        revisionId,
      ]);
      return {
        value: { documentId, revisionId },
        events: [
          {
            type: DOCUMENT_REVISED_EVENT,
            subject: documentId,
            data: { documentId, previousRevisionId: row.head_revision_id, revisionId },
          },
        ],
      };
    },
  );
}

export async function setKnowledgePublication(
  deps: KnowledgeDependencies,
  actor: Actor,
  documentId: string,
  input: KnowledgePublicationInput,
  context: KnowledgeCommandContext,
) {
  const owner = await knowledgeOwner(deps.pool, documentId);
  if (!owner) throw new KnowledgeNotFoundError();
  const authorization = await accountUpdateAuthorization(deps, actor, owner.owner_account_id, context);
  const kind = 'content.knowledge.document.publication';
  const verifySubject =
    input.revisionId === null
      ? null
      : await (async () => {
          const selected = await knowledgeSelectedSubject(deps.pool, owner.route, documentId, input.revisionId!);
          if (!selected) throw new KnowledgeNotFoundError();
          return preparePublicSubjects(deps, selected.subject_id, selected.subject_ids, context.deadline);
        })();
  if (verifySubject) {
    authorization.prepare = async () => {
      if (!(await verifySubject())) throw new KnowledgeNotFoundError();
    };
  }
  const publicationId = input.revisionId === null ? null : newId(owner.route);
  return runCommand<{ documentId: string; publicationId: string | null; revisionId?: string }>(
    deps.pool,
    commandOptions(actor, owner.route, context, kind, documentId, input, authorization),
    async (tx, { transactionId, time }) => {
      const current = await tx.query<{
        notebook_id: string;
        head_revision_id: string;
        current_publication_id: string | null;
      }>(
        `SELECT notebook_id,head_revision_id,current_publication_id FROM content.knowledge_document
         WHERE route=$1 AND document_id=$2 FOR UPDATE`,
        [owner.route, documentId],
      );
      const document = current.rows[0];
      if (!document || document.notebook_id !== owner.notebook_id) throw new KnowledgeNotFoundError();
      if (
        document.head_revision_id !== input.expectedHeadRevisionId ||
        document.current_publication_id !== input.expectedPublicationId
      )
        throw new RevisionPreconditionError();

      let previous: { publication_id: string; revision_id: string; subject_id: string } | null = null;
      if (document.current_publication_id !== null) {
        const existing = await tx.query<{ publication_id: string; revision_id: string; subject_id: string }>(
          `SELECT publication_id,revision_id,subject_id FROM content.knowledge_publication
           WHERE route=$1 AND document_id=$2 AND publication_id=$3`,
          [owner.route, documentId, document.current_publication_id],
        );
        previous = existing.rows[0] ?? null;
      }
      if (input.revisionId === null) {
        if (!previous) return noEffect({ documentId, publicationId: null });
        await tx.query(
          `UPDATE content.knowledge_document SET current_publication_id=NULL
           WHERE route=$1 AND document_id=$2`,
          [owner.route, documentId],
        );
        return {
          value: { documentId, publicationId: null },
          events: [
            {
              type: PUBLICATION_EVENT,
              subject: documentId,
              data: {
                action: 'withdrawn',
                documentId,
                publicationId: previous.publication_id,
                revisionId: previous.revision_id,
                subjectId: previous.subject_id,
              },
            },
          ],
        };
      }

      const revision = await tx.query<{ body_sha256: Buffer }>(
        `SELECT body_sha256 FROM content.knowledge_revision
         WHERE route=$1 AND document_id=$2 AND revision_id=$3`,
        [owner.route, documentId, input.revisionId],
      );
      const selected = revision.rows[0];
      if (!selected) throw new KnowledgeNotFoundError();
      if (!publicationId) throw new Error('A selected publication needs an identity');
      const subject = await tx.query<{ subject_id: string }>(
        `SELECT n.subject_id FROM content.knowledge_document d
         JOIN content.knowledge_notebook n ON n.route=d.route AND n.notebook_id=d.notebook_id
         WHERE d.route=$1 AND d.document_id=$2`,
        [owner.route, documentId],
      );
      const subjectId = subject.rows[0]?.subject_id;
      if (!subjectId) throw new KnowledgeNotFoundError();
      await tx.query(
        `INSERT INTO content.knowledge_publication
          (route,document_id,publication_id,revision_id,subject_id,body_sha256,recorded_transaction_id,published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          owner.route,
          documentId,
          publicationId,
          input.revisionId,
          subjectId,
          selected.body_sha256,
          transactionId,
          authoritativeTimeValue(time),
        ],
      );
      await tx.query(
        `UPDATE content.knowledge_document SET current_publication_id=$3
         WHERE route=$1 AND document_id=$2`,
        [owner.route, documentId, publicationId],
      );
      return {
        value: { documentId, publicationId, revisionId: input.revisionId },
        events: [
          {
            type: PUBLICATION_EVENT,
            subject: documentId,
            data: {
              action: 'selected',
              documentId,
              publicationId,
              revisionId: input.revisionId,
              subjectId,
            },
          },
        ],
      };
    },
  );
}
