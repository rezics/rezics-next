import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import {
  noEffect,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { appendImportedField } from '../content/imported-fields.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { claimMedia } from '../content/media.ts';
import { requestDigest } from '../http/request.ts';
import type { AccountActor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { EditorialConflictError, SubjectNotFoundError, writeProposal } from './candidates.ts';
import { SUBJECT_REVISED } from './events.ts';
import { SubjectInputError } from './item.ts';
import { redirectOf, SubjectRedirectError } from './merges.ts';
import { writeSubject, type SubjectComponent } from './subject.ts';
import updateSubjectRelease from './update-subject-release.sql';
import deleteSourceCandidate from './bulk-delete-source-candidate.sql';
import insertClaim from './bulk-insert-claim.sql';
import insertRetractRevision from './bulk-insert-retract-revision.sql';
import insertRetraction from './bulk-insert-retraction.sql';
import insertSourceCandidate from './bulk-insert-source-candidate.sql';
import readClaim from './bulk-read-claim.sql';
import readCompactCandidate from './bulk-read-compact-candidate.sql';
import readProposedSource from './bulk-read-proposed-source.sql';
import readSourceCandidate from './bulk-read-source-candidate.sql';

export type BulkValue =
  | { id: string; revision: number }
  | { candidate: string; revision: number }
  | { revision: number };
type Value = { status: 200 | 201; value: BulkValue };

export function batchRoute(routeKey: Uint8Array, command: BatchCommand): number | null {
  const tuple = tupleRoute(routeKey, command.source.source, command.source.external_id);
  return command.op === 'create' ? tuple : routeOf(command.subject);
}

/** The canonical semantic statement identity excludes evidence and editorial rank. */
export function statementDigest(statement: Extract<BatchCommand, { op: 'propose' }>['statement']): string {
  return createHash('sha256')
    .update(
      canonicalize({ property: statement.property, value: statement.value, qualifiers: statement.qualifiers ?? [] })!,
    )
    .digest('hex');
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type DocumentNode = { attrs?: { id?: unknown }; content?: DocumentNode[] };

/** Block ids are generated per snapshot. The summary identity keeps document order, not those ids. */
function identityDocument(document: DocumentSnapshot): DocumentSnapshot {
  const clone = structuredClone(document);
  let ordinal = 0;
  const visit = (node: DocumentNode): void => {
    if (node.attrs && typeof node.attrs.id === 'string') node.attrs.id = `block-${++ordinal}`;
    for (const child of node.content ?? []) if (child && typeof child === 'object') visit(child);
  };
  visit(clone.doc);
  return clone;
}

/** A summary's source identity is the property, language, and document bytes, before content stores them. */
export function importedStatementDigest(
  statement: Extract<BatchCommand, { op: 'propose' }>['statement'],
  fieldGroup: Source['field_group'],
): string {
  if (fieldGroup === 'summary' && statement.value.type === 'value' && record(statement.value.content)) {
    const content = statement.value.content;
    if (typeof content.language === 'string' && content.document !== undefined) {
      const documentDigest = createHash('sha256')
        .update(serializeDocument(identityDocument(parseDocument(content.document))))
        .digest('hex');
      return createHash('sha256')
        .update(canonicalize({ property: statement.property, language: content.language, digest: documentDigest })!)
        .digest('hex');
    }
  }
  return statementDigest(statement);
}

/** Summary and cover proposals record the subject resource. The grant check stays on the prepared target. */
export function guardBatchAuthorization(
  authorization: CommandAuthorization,
  command: BatchCommand,
  route: number,
  enforce: (tx: CommandTransaction) => Promise<void>,
): CommandAuthorization {
  const bound: CommandAuthorization =
    command.op === 'propose' && (command.source.field_group === 'summary' || command.source.field_group === 'cover')
      ? { ...authorization, resource: { route, id: command.subject } }
      : authorization;
  return {
    action: bound.action,
    resource: bound.resource,
    denied: () => bound.denied(),
    ...(bound.prepare ? { prepare: (attempt: CommandAttempt) => bound.prepare!(attempt) } : {}),
    authorize: async (tx, attempt, proof) => {
      const mode = await bound.authorize(tx, attempt, proof);
      await enforce(tx);
      return mode;
    },
    ...(bound.finalize ? { finalize: (tx, attempt, proof) => bound.finalize!(tx, attempt, proof) } : {}),
  };
}

async function visibleSubject(tx: CommandTransaction, route: number, id: string) {
  const result = await tx.query<{ type: string; revision: number }>(
    `SELECT s.type, r.revision FROM semantic.subject s
     JOIN LATERAL (SELECT revision FROM semantic.revision WHERE route = s.route AND subject_id = s.subject_id
       ORDER BY revision DESC LIMIT 1) r ON true
     WHERE s.route = $1 AND s.subject_id = $2 AND s.visibility = 'visible'`,
    [route, id],
  );
  const subject = result.rows[0];
  if (!subject) throw new SubjectNotFoundError();
  const redirect = await redirectOf(tx, id);
  if (redirect) throw new SubjectRedirectError(id, redirect);
  return subject;
}

export async function batchCommand(
  pool: Pool,
  options: {
    command: BatchCommand;
    route: number;
    actor: AccountActor;
    authorization: CommandAuthorization;
    release: { digest: string; release: Release };
    deadline: number;
    clock: () => Date;
  },
): Promise<Value & { component: SubjectComponent }> {
  const { command, actor, route } = options;
  if (command.op === 'propose' && command.source.field_group === 'summary') {
    const value = command.statement.value;
    const content = value.type === 'value' && record(value.content) ? value.content : null;
    try {
      parseDocument(content?.document);
    } catch {
      throw new SubjectInputError([{ pointer: '/statement/value/content/document', code: 'invalid_format' }]);
    }
  }
  const partition = partitionOf(route);
  const kind = `subject.batch_${command.op}`;
  const digest = requestDigest(kind, actor, command);
  const outcome = await runCommand<Value>(
    pool,
    {
      partition,
      deadline: options.deadline,
      clock: options.clock,
      authorization: options.authorization,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      receipt: { actorAccountId: actor.accountId, kind, key: command.key, digest },
    },
    async (tx, { transactionId }) => {
      try {
        const resolve = (value: BulkValue) => noEffect<Value>({ status: 200, value });
        const source = command.source;
        if (command.op === 'create') {
          const claim = await readClaim.run(tx, {
            route,
            source: source.source,
            external_id: source.external_id,
          });
          const id = claim?.subject_id;
          if (id) {
            const subject = await visibleSubject(tx, route, id);
            if (subject.type !== command.subject.type) throw new EditorialConflictError();
            return resolve({ id, revision: subject.revision });
          }
          const target = { route, id: newId(route) };
          const written = await writeSubject(tx, transactionId, {
            target,
            item: command.subject,
            release: options.release,
            source,
          });
          await insertClaim.run(tx, {
            route,
            source: source.source,
            external_id: source.external_id,
            subject_id: target.id,
            transaction_id: transactionId,
          });
          return { value: { status: 201, value: { id: written.value.id, revision: 1 } }, events: written.events };
        }
        const subject = await visibleSubject(tx, route, command.subject);
        if (command.op === 'propose') {
          const imported = source.field_group === 'summary' || source.field_group === 'cover';
          const hash = importedStatementDigest(command.statement, source.field_group);
          const key = {
            route,
            subject_id: command.subject,
            source: source.source,
            external_id: source.external_id,
            field_group: source.field_group,
            statement_digest: hash,
          };
          const existing = await readSourceCandidate.run(tx, key);
          if (existing) return resolve({ candidate: existing.candidate_id, revision: subject.revision });
          let written: Awaited<ReturnType<typeof writeProposal>>;
          const proposal = {
            subject: command.subject,
            // Content installation rewrites the candidate body. Keep the
            // original snapshot available to a transaction retry.
            statement: imported ? structuredClone(command.statement) : command.statement,
            release: options.release,
            source,
            allowContent: imported,
          };
          try {
            written = await writeProposal(
              tx,
              transactionId,
              imported
                ? {
                    ...proposal,
                    install: async ({ candidate, revision, body }) => {
                      if (!record(body) || !record(body.value)) throw new TypeError('Invalid imported statement');
                      if (source.field_group === 'summary') {
                        const content = body.value.content;
                        if (!command.rights || !record(content) || typeof content.language !== 'string')
                          throw new TypeError('Invalid imported summary');
                        const stored = await appendImportedField(tx, {
                          subject: command.subject,
                          candidate,
                          revision,
                          language: content.language,
                          document: content.document,
                          source: {
                            source: source.source,
                            external_id: source.external_id,
                            record_revision: source.record_revision,
                            digest: source.digest,
                            converter_revision: source.converter_revision,
                            field_group: 'summary',
                            references: command.statement.references,
                          },
                          rights: {
                            license: command.rights.license,
                            obligations: command.rights.obligations,
                            attribution: command.rights.attribution,
                          },
                        });
                        return {
                          language: content.language,
                          document: stored.id,
                          digest: stored.digest,
                        };
                      }
                      if (typeof body.value.content !== 'string') throw new TypeError('Invalid cover media');
                      await claimMedia(tx, {
                        mediaIds: [body.value.content],
                        containerId: command.subject,
                        author: actor,
                        reference: {
                          kind: 'semantic_candidate',
                          subjectId: command.subject,
                          candidateId: candidate,
                          revision,
                        },
                      });
                    },
                  }
                : proposal,
            );
          } catch (error) {
            if (imported && (error instanceof TypeError || error instanceof RangeError))
              throw new SubjectInputError([{ pointer: '/statement/value/content', code: 'out_of_range' }]);
            throw error;
          }
          await insertSourceCandidate.run(tx, { ...key, candidate_id: written.value.candidate });
          return { value: { status: 201, value: written.value }, events: written.events };
        }
        const proposed = await readProposedSource.run(tx, {
          route,
          subject_id: command.subject,
          candidate_id: command.candidate,
        });
        if (!proposed) {
          // Compact single-route candidates exist virtually before slot expansion.
          // Their proposing revision has no imported source, so they cannot be retracted here.
          const compact = await readCompactCandidate.run(tx, {
            route,
            subject_id: command.subject,
            candidate_id: command.candidate,
          });
          if (compact) throw new EditorialConflictError();
          throw new SubjectNotFoundError();
        }
        const origin = proposed.source as Source | null;
        if (
          !origin ||
          origin.source !== source.source ||
          origin.external_id !== source.external_id ||
          origin.field_group !== source.field_group
        )
          throw new EditorialConflictError();
        const revision = subject.revision + 1;
        await insertRetractRevision.run(tx, {
          route,
          subject_id: command.subject,
          revision,
          release: options.release.digest,
          transaction_id: transactionId,
          source,
        });
        await updateSubjectRelease.run(tx, {
          route,
          subject_id: command.subject,
          release: options.release.digest,
        });
        await insertRetraction.run(tx, {
          route,
          subject_id: command.subject,
          candidate_id: command.candidate,
          revision,
          references: command.references,
        });
        await deleteSourceCandidate.run(tx, {
          route,
          subject_id: command.subject,
          source: source.source,
          external_id: source.external_id,
          field_group: source.field_group,
          candidate_id: command.candidate,
        });
        return {
          value: { status: 200, value: { revision } },
          events: [
            {
              type: SUBJECT_REVISED,
              subject: command.subject,
              data: { id: command.subject, revision, kind: 'retract' },
            },
            {
              type: 'com.rezics.statement.retracted.v1',
              subject: command.subject,
              data: { candidate: command.candidate, revision },
            },
          ],
        };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505' &&
          'constraint' in error &&
          ['external_claim_pkey', 'source_candidate_pkey', 'receipt_pkey', 'revision_pkey', 'candidate_pkey'].includes(
            String(error.constraint),
          )
        )
          error.code = '40001';
        throw error;
      }
    },
  );
  return {
    ...outcome.value,
    component: { partition: outcome.partition, epoch: outcome.epoch, position: outcome.position },
  };
}
