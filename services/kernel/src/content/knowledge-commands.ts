import type { AccessClient, Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
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
  KnowledgeInvalidInputError,
  KnowledgeNotFoundError,
  knowledgeSubjectTargets,
  type KnowledgeCommandContext,
  type KnowledgeCreateDocumentInput,
  type KnowledgeCreateNotebookInput,
  type KnowledgeDependencies,
  type KnowledgeDocumentInput,
  type KnowledgePublicationInput,
  type KnowledgeReviseDocumentInput,
} from './knowledge-model.ts';
import { isCompleteStableAncestorPath, type StableAncestor } from './hosted-chapters-tree.ts';
import {
  knowledgeAncestorPath,
  knowledgeNotebookOwner,
  knowledgeOwner,
  knowledgeSelectedSubject,
} from './knowledge-store.ts';

const PUBLICATION_EVENT = 'com.rezics.content.knowledge.publication.changed.v1';
const NOTEBOOK_CREATED_EVENT = 'com.rezics.content.knowledge.notebook.created.v1';
const DOCUMENT_CREATED_EVENT = 'com.rezics.content.knowledge.document.created.v1';
const DOCUMENT_REVISED_EVENT = 'com.rezics.content.knowledge.document.revised.v1';

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
          (route,notebook_id,owner_account_id,subject_id,title,structure_revision_id,created_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (route,notebook_id) DO NOTHING RETURNING notebook_id`,
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
      await tx.query(
        `INSERT INTO content.knowledge_structure_revision(route,notebook_id,revision_id,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [route, notebookId, structureRevisionId, transactionId, authoritativeTimeValue(time)],
      );
      return {
        value: { notebookId, structureRevisionId },
        events: [
          {
            type: NOTEBOOK_CREATED_EVENT,
            subject: notebookId,
            data: { notebookId, subjectId: input.subjectId, structureRevisionId },
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
  const route = routed(notebookId);
  const owner = await knowledgeNotebookOwner(deps.pool, notebookId);
  if (!owner || owner.route !== route) throw new KnowledgeNotFoundError();
  const ownerId = owner.owner_account_id;
  const authorization = await accountUpdateAuthorization(deps, actor, ownerId, context);
  const document = storedBody(input);
  const documentId = newId(route);
  const revisionId = newId(route);
  const placementId = newId(route);
  const structureRevisionId = newId(route);
  const kind = 'content.knowledge.document.create';
  return runCommand(
    deps.pool,
    commandOptions(actor, route, context, kind, documentId, input, authorization),
    async (tx, { transactionId, time }) => {
      const current = await tx.query<{ owner_account_id: string; structure_revision_id: string }>(
        `SELECT owner_account_id,structure_revision_id FROM content.knowledge_notebook
         WHERE route=$1 AND notebook_id=$2 FOR UPDATE`,
        [route, notebookId],
      );
      const notebook = current.rows[0];
      if (!notebook || notebook.owner_account_id !== ownerId) throw new KnowledgeNotFoundError();
      if (notebook.structure_revision_id !== input.expectedStructureRevisionId) throw new RevisionPreconditionError();
      const parentId = input.parentPlacementId;
      if (parentId !== null) {
        const path = await knowledgeAncestorPath(tx, route, notebookId, parentId);
        const parentPath: StableAncestor[] = path.map((item) => ({
          placementId: item.placement_id,
          parentId: item.parent_id,
        }));
        if (!isCompleteStableAncestorPath(parentPath, KNOWLEDGE_ANCESTOR_LIMIT - 1))
          throw new KnowledgeInvalidInputError();
      }
      const nextPosition = await tx.query<{ position: string }>(
        `SELECT COALESCE(MAX(position)+1,0)::text AS position
         FROM content.knowledge_placement
         WHERE route=$1 AND notebook_id=$2 AND parent_id IS NOT DISTINCT FROM $3`,
        [route, notebookId, parentId],
      );
      await tx.query(
        `INSERT INTO content.knowledge_document(route,document_id,notebook_id,head_revision_id,created_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [route, documentId, notebookId, revisionId, transactionId, authoritativeTimeValue(time)],
      );
      await tx.query(
        `INSERT INTO content.knowledge_revision
          (route,document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,author_account_id,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
        ],
      );
      await tx.query(
        `INSERT INTO content.knowledge_placement(route,notebook_id,placement_id,document_id,parent_id,position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [route, notebookId, placementId, documentId, parentId, nextPosition.rows[0]!.position],
      );
      await tx.query(
        `INSERT INTO content.knowledge_structure_revision(route,notebook_id,revision_id,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [route, notebookId, structureRevisionId, transactionId, authoritativeTimeValue(time)],
      );
      await tx.query(
        `UPDATE content.knowledge_notebook SET structure_revision_id=$3
         WHERE route=$1 AND notebook_id=$2`,
        [route, notebookId, structureRevisionId],
      );
      return {
        value: { notebookId, documentId, placementId, revisionId, structureRevisionId },
        events: [
          {
            type: DOCUMENT_CREATED_EVENT,
            subject: documentId,
            data: { notebookId, documentId, placementId, revisionId, structureRevisionId },
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
          (route,document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,author_account_id,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
