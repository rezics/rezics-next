import type { PoolClient } from 'pg';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { validateContentDocument } from './document.ts';
import type { ImportedFieldInput, ImportedSource, Rights } from './imported-contract.ts';
import append from './append-imported-field.sql';
import read from './read-imported-field.sql';

export type ImportedFieldResult = Readonly<{ id: string; digest: string }>;
export type StoredImportedField = ImportedFieldResult &
  Readonly<{
    subject: string;
    source: ImportedSource;
    rights: Rights;
    language: string;
    availability: 'available' | 'erased';
    body: Buffer | null;
  }>;

const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !controls.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Validate the internal evidence envelope; portable bulk wire validation belongs to semantic. */
function validateEnvelope(input: ImportedFieldInput): void {
  const { source, rights, language } = input;
  if (
    !record(source) ||
    !onlyKeys(source, [
      'source',
      'external_id',
      'record_revision',
      'digest',
      'converter_revision',
      'field_group',
      'references',
    ]) ||
    !text(source.source, 32) ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(source.source) ||
    !text(source.external_id, 2048) ||
    !text(source.record_revision, 2048) ||
    !text(source.digest, 256) ||
    !text(source.converter_revision, 256) ||
    source.field_group !== 'summary' ||
    !Array.isArray(source.references) ||
    source.references.length > 128 ||
    !record(rights) ||
    !onlyKeys(rights, ['license', 'obligations', 'attribution']) ||
    !text(rights.attribution, 16384) ||
    !Array.isArray(rights.obligations) ||
    rights.obligations.length > 32 ||
    !rights.obligations.every((obligation) => text(obligation, 2048)) ||
    !text(language, 128)
  )
    throw new TypeError('Invalid imported summary evidence');
  try {
    new Intl.Locale(language);
  } catch {
    throw new TypeError('Invalid imported summary language');
  }
  for (const reference of source.references) {
    if (
      !record(reference) ||
      !onlyKeys(reference, ['url', 'title']) ||
      !text(reference.url, 8192) ||
      (reference.title !== undefined && !text(reference.title, 2048))
    )
      throw new TypeError('Invalid imported source reference');
    let url: URL;
    try {
      url = new URL(reference.url);
    } catch {
      throw new TypeError('Invalid imported source URL');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new TypeError('Invalid imported source URL');
  }
  if (
    source.source === 'bangumi' &&
    (rights.license !== 'CC-BY-SA-3.0' ||
      !rights.obligations.includes('cc:Attribution') ||
      !rights.obligations.includes('cc:ShareAlike'))
  )
    throw new TypeError('Bangumi summaries require attribution and share-alike under CC-BY-SA-3.0');
}

/** Append inside semantic's authorized command. This neither adopts nor publishes the proposal. */
export async function appendImportedField(
  tx: CommandTransaction,
  input: ImportedFieldInput,
): Promise<ImportedFieldResult> {
  const command = currentCommand(tx);
  const route = routeOf(input.subject);
  if (route === null || partitionOf(route) !== command.partition)
    throw new RangeError('Imported subject must belong to the current command partition');
  if (
    command.authorization?.mode !== 'execute' ||
    command.authorization.resource.id !== input.subject ||
    command.authorization.resource.route !== route
  )
    throw new TypeError('Imported summary requires current subject command authorization');
  validateEnvelope(input);
  const document = validateContentDocument({
    body: input.document,
    licence: input.rights.license,
    subjectIds: [input.subject],
  });
  const pending = [document.snapshot.doc];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image' || node.type === 'media')
      throw new TypeError('Imported summaries cannot contain hotlinked media');
    pending.push(...(node.content ?? []));
  }
  const id = newId(route);
  await append.run(tx, {
    route,
    id,
    subject: input.subject,
    body: Buffer.from(document.canonicalBytes),
    body_sha256: Buffer.from(document.sha256, 'hex'),
    source: input.source,
    rights: input.rights,
    language: input.language,
  });
  return { id, digest: document.sha256 };
}

/** LOW-LEVEL exact storage read, including erased tombstones. Never expose this as a public handler.
 * The public caller must independently check current semantic container/candidate disclosure
 * and the current source fence; possession of a document ID grants no publication permission.
 */
export async function readImportedField(
  client: Pick<PoolClient, 'query'>,
  route: number,
  id: string,
): Promise<StoredImportedField | null> {
  if (routeOf(id) !== route) throw new RangeError('Imported document ID must carry the supplied route');
  const rows = await read.run(client, { route, id });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    digest: row.digest,
    subject: row.subject,
    body: row.body === null ? null : Buffer.from(row.body),
    availability: row.availability as StoredImportedField['availability'],
    source: row.source as ImportedSource,
    rights: row.rights as Rights,
    language: row.language,
  };
}
