import type { PoolClient } from 'pg';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { validateContentDocument } from './document.ts';
import append from './append-authored-field.sql';
import read from './read-authored-field.sql';

export type AuthoredFieldInput = Readonly<{
  subject: string;
  /** Allocated semantic candidate UUID, scoped to the subject partition. */
  candidate: string;
  /** Actual positive semantic revision allocated before the field is appended. */
  revision: number;
  document: unknown;
  licence: string;
  language: string;
}>;

export type AuthoredFieldResult = Readonly<{ id: string; digest: string }>;

export type AuthoredFieldView = AuthoredFieldResult &
  Readonly<{
    subject: string;
    candidate: string;
    revision: number;
    authorAccountId: string;
    licence: string;
    language: string;
    availability: 'available' | 'erased';
    body: Buffer | null;
  }>;

/** Append in semantic's authorized subject command. The caller stores { id, digest } in its statement and emits the event. */
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
    command.authorization.resource.id !== input.subject ||
    command.authorization.resource.route !== route
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
    candidate: input.candidate,
    revision: input.revision,
    author_account_id: authorAccountId,
    body: Buffer.from(document.canonicalBytes),
    body_sha256: Buffer.from(document.sha256, 'hex'),
    licence: document.licence,
    language: input.language,
  });
  return { id, digest: document.sha256 };
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
    candidate: row.candidate,
    revision: row.revision,
    authorAccountId: row.author_account_id,
    body: row.body === null ? null : Buffer.from(row.body),
    licence: row.licence,
    language: row.language,
    availability: row.availability as AuthoredFieldView['availability'],
  };
}
