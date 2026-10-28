import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import {
  authoritativeTimeValue,
  currentCommand,
  principalCommandIdentity,
  runCommand,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { creationDeclares } from '../access/index.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError } from './commands.ts';
import { validateContentDocument } from './document.ts';
import append from './append-authored-field.sql';
import read from './read-authored-field.sql';
import initializeAuthoredFieldOwner from '../access/resource-initialization.sql';
import erase from './erase-authored-field.sql';
import type { RequestContext } from './model.ts';

export type AuthoredFieldInput = Readonly<{
  subject: string;
  /** UUID of the revision anchor declared by semantic in the current creation manifest. */
  anchor?: string;
  /** Allocated semantic candidate UUID, scoped to the subject partition. */
  candidate: string;
  /** Actual positive semantic revision allocated before the field is appended. */
  revision: number;
  document: unknown;
  licence: string;
  language: string;
}>;

export type AuthoredFieldResult = Readonly<{ id: string; digest: string }>;

export type AuthoredFieldDependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;

type ErasedAuthoredField = Readonly<{ id: string; subject: string; authorId: string }>;

class Unchanged extends Error {}

export type AuthoredFieldView = AuthoredFieldResult &
  Readonly<{
    subject: string;
    anchor: string | null;
    candidate: string;
    revision: number;
    authorAccountId: string;
    licence: string;
    language: string;
    availability: 'available' | 'erased';
    body: Buffer | null;
  }>;

/** Append in semantic's authorized subject or declared-anchor creation command.
 * The caller stores { id, digest } in its statement and emits the event.
 */
export async function appendAuthoredField(
  tx: CommandTransaction,
  input: AuthoredFieldInput,
): Promise<AuthoredFieldResult> {
  const command = currentCommand(tx);
  const route = routeOf(input.subject);
  if (route === null || partitionOf(route) !== command.partition)
    throw new RangeError('Authored subject must belong to the current command partition');
  if (
    command.authorization?.mode !== 'execute' ||
    (input.anchor === undefined
      ? command.authorization.resource.id !== input.subject || command.authorization.resource.route !== route
      : routeOf(input.anchor) !== route || !creationDeclares(tx, { route, id: input.anchor }))
  )
    throw new TypeError('Authored document requires current subject command authorization');
  if (routeOf(input.candidate) !== route) throw new RangeError('Authored candidate must carry the subject route');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new RangeError('Authored revision must be a positive safe integer allocated by semantic');

  const authorAccountId = command.basis?.actorAccountId;
  if (authorAccountId === undefined || authorAccountId === null)
    throw new TypeError('Authored documents require an account actor');
  if (
    typeof input.language !== 'string' ||
    input.language.length < 1 ||
    input.language.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(input.language)
  )
    throw new TypeError('Invalid authored document language');
  try {
    new Intl.Locale(input.language);
  } catch {
    throw new TypeError('Invalid authored document language');
  }

  const document = validateContentDocument({
    body: input.document,
    licence: input.licence,
    subjectIds: [input.subject],
  });
  const pending = [document.snapshot.doc];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image' || node.type === 'media')
      throw new TypeError('Authored field documents cannot contain image or media nodes');
    pending.push(...(node.content ?? []));
  }

  const id = newId(route);
  await append.run(tx, {
    route,
    id,
    subject: input.subject,
    anchor: input.anchor ?? null,
    candidate: input.candidate,
    revision: input.revision,
    author_account_id: authorAccountId,
    body: Buffer.from(document.canonicalBytes),
    body_sha256: Buffer.from(document.sha256, 'hex'),
    licence: document.licence,
    language: input.language,
  });
  // The row's ID is allocated here after admission. Its owner role is installed
  // in the same transaction and becomes effective at the command's authoritative T.
  const grantRows = await initializeAuthoredFieldOwner.run(tx, {
    route,
    resource_id: id,
    resource_type: 'content.authored_field',
    creator_id: authorAccountId,
    at: authoritativeTimeValue(command.time),
    grants: [{ subject_kind: 'identity', subject_id: authorAccountId, grant_role: 'content.authored_field.owner' }],
    transaction_id: Bun.randomUUIDv7(),
  });
  if (grantRows.length !== 1) throw new TypeError('Authored field owner grant was not initialized');
  return { id, digest: document.sha256 };
}

/** Erase the author's document in its partition. Access admission and document:erase
 * are checked for each live command attempt at the same authoritative T.
 */
export async function eraseAuthoredField(
  dependencies: AuthoredFieldDependencies,
  actor: Actor,
  id: string,
  context: RequestContext,
): Promise<CommandOutcome<ErasedAuthoredField> | null> {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
  const route = routeOf(id);
  if (route === null) throw new ContentNotFoundError();
  const resource = { route, id };
  const authorization = await accessCommandAuthorization(
    dependencies.access,
    actor,
    'document:erase',
    resource,
    { pool: dependencies.pool, deadline: context.deadline },
    () => new ContentNotFoundError(),
  );
  const identity = principalCommandIdentity(actor);
  const commandKind = 'content.authored_field.erase';
  const body = { id };
  try {
    return await runCommand(
      dependencies.pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: context.deadline,
        clock: dependencies.clock,
        authorization,
        receipt: {
          kind: commandKind,
          key: context.idempotencyKey,
          digest: createHash('sha256')
            .update(canonicalize([identity.principal, commandKind, body])!)
            .digest(),
        },
      },
      async (tx) => {
        const row = (await erase.run(tx, { route, id, author_id: actor.accountId }))[0];
        if (!row) throw new ContentNotFoundError();
        if (!row.changed) throw new Unchanged();
        const value = { id: row.id, subject: row.subject, authorId: row.author_account_id };
        return {
          value,
          events: [{ type: 'com.rezics.content.authored-field.erased.v1', subject: row.subject, data: value }],
        };
      },
    );
  } catch (error) {
    if (error instanceof Unchanged) return null;
    throw error;
  }
}

/** LOW-LEVEL exact storage read, including erased tombstones. Never expose this as a public handler.
 * Possession of a document ID grants no disclosure permission; the public caller must independently
 * check the current semantic candidate, just as it does for imported documents.
 */
export async function readAuthoredField(
  client: Pick<PoolClient, 'query'>,
  route: number,
  id: string,
): Promise<AuthoredFieldView | null> {
  if (routeOf(id) !== route) throw new RangeError('Authored document ID must carry the supplied route');
  const rows = await read.run(client, { route, id });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    digest: row.digest,
    subject: row.subject,
    anchor: row.anchor,
    candidate: row.candidate,
    revision: row.revision,
    authorAccountId: row.author_account_id,
    body: row.body === null ? null : Buffer.from(row.body),
    licence: row.licence,
    language: row.language,
    availability: row.availability as AuthoredFieldView['availability'],
  };
}
