import type { PoolClient } from 'pg';
import { BatchReferenceSchema, SourceSchema } from '@rezics/definitions/bulk';
import { Value } from 'typebox/value';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { validateContentDocument } from './document.ts';
import {
  validateImportedFieldMetadata,
  type ImportedFieldInput,
  type ImportedSource,
  type Rights,
} from './imported-contract.ts';
import append from './append-imported-field.sql';
import read from './read-imported-field.sql';

export type ImportedFieldResult = Readonly<{ id: string; digest: string }>;
export type ImportedFieldView = ImportedFieldResult &
  Readonly<{
    subject: string;
    candidate: string;
    revision: number;
    source: ImportedSource;
    rights: Rights;
    language: string;
    availability: 'available' | 'erased';
    body: Buffer | null;
  }>;

export type StoredImportedField = ImportedFieldView;

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
    !Value.Check(SourceSchema, source) ||
    !text(source.converter_revision, 256) ||
    source.field_group !== 'summary' ||
    !Array.isArray(source.references) ||
    source.references.length > 128 ||
    !record(rights) ||
    !onlyKeys(rights, ['license', 'obligations', 'attribution']) ||
    !text(rights.license, 128) ||
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
    if (!Value.Check(BatchReferenceSchema, reference)) throw new TypeError('Invalid imported source reference');
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
    !(
      (command.authorization.resource.id === input.subject && command.authorization.resource.route === route) ||
      ((command.authorization.action === 'statement:propose' || command.authorization.action === 'subject:create') &&
        command.authorization.resource.id === GLOBAL_CONTEXT &&
        command.authorization.resource.route === routeOf(GLOBAL_CONTEXT))
    )
  )
    throw new TypeError('Imported summary requires current subject command authorization');
  if (routeOf(input.candidate) !== route) throw new RangeError('Imported candidate must carry the subject route');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new RangeError('Imported revision must be a positive safe integer allocated by semantic');
  validateEnvelope(input);
  const metadataErrors = validateImportedFieldMetadata(input);
  if (metadataErrors.length > 0) throw new TypeError(`Invalid imported metadata fields: ${metadataErrors.join(', ')}`);
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
    candidate: input.candidate,
    revision: input.revision,
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
export function readImportedField(client: Pick<PoolClient, 'query'>, id: string): Promise<ImportedFieldView | null>;
/** Explicit-route form also rejects mismatched IDs before I/O. */
export function readImportedField(
  client: Pick<PoolClient, 'query'>,
  route: number,
  id: string,
): Promise<ImportedFieldView | null>;
export async function readImportedField(
  client: Pick<PoolClient, 'query'>,
  routeOrId: number | string,
  exactId?: string,
): Promise<ImportedFieldView | null> {
  const id = typeof routeOrId === 'string' ? routeOrId : exactId!;
  const route = typeof routeOrId === 'number' ? routeOrId : routeOf(id);
  if (route === null || routeOf(id) !== route)
    throw new RangeError('Imported document ID must carry the supplied route');
  const rows = await read.run(client, { route, id });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    digest: row.digest,
    subject: row.subject,
    candidate: row.candidate,
    revision: row.revision,
    body: row.body === null ? null : Buffer.from(row.body),
    availability: row.availability as ImportedFieldView['availability'],
    source: row.source as ImportedSource,
    rights: row.rights as Rights,
    language: row.language,
  };
}
