import { parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import { deadlineClient, within } from './access-port.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readCandidateDisclosure } from '../semantic/disclosure.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { CONTENT_DOCUMENT_BYTES } from './contract/index.ts';
import { admitDocumentRead, deadlineElapsed } from './core/index.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { tupleRoute } from './imported-contract.ts';
import { readImportedField, readImportedFieldBounded, type ImportedFieldView } from './imported-fields.ts';
import { readAuthoredField, readAuthoredFieldBounded, type AuthoredFieldView } from './authored-fields.ts';
import type { Anchored, AnchoredPosition, ReadContext } from './model.ts';
import { readFences } from './source-fences.ts';

/** `now` is the wall-clock budget source supplied by the composition; deadlines are compared against it. */
export type DocumentReadDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  now: () => number;
}>;
type DocumentMetadata = Readonly<{
  id: string;
  subjectId: string;
  candidateId: string;
  revision: number;
  language: string;
  digest: string;
}>;
type AvailableDocument = Readonly<{ availability: 'available'; body: DocumentSnapshot }>;
type ErasedDocument = Readonly<{ availability: 'erased'; body: null }>;
export type DocumentView =
  | (DocumentMetadata &
      Readonly<{ origin: 'import'; source: ImportedFieldView['source']; rights: ImportedFieldView['rights'] }> &
      (AvailableDocument | ErasedDocument))
  | (DocumentMetadata & Readonly<{ origin: 'account'; author: string; licence: string }> & AvailableDocument);

type DocumentReference =
  | Readonly<{ origin: 'import'; row: ImportedFieldView }>
  | Readonly<{ origin: 'account'; row: AuthoredFieldView }>;

/** Each reference has its own released anchor. Access preparation may acquire
 * account and membership homes only before entering the subject snapshot. */
async function snapshot<T>(
  dependencies: DocumentReadDependencies,
  route: number,
  context: ReadContext,
  work: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved') throw new GrantDeniedError();
        const value = await work(client);
        await client.query('COMMIT');
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

// Availability can advance to erased while immutable identity/evidence cannot.
function importedBinding({ body: _body, availability: _availability, ...identity }: ImportedFieldView) {
  return JSON.stringify(identity);
}
function authoredBinding({ body: _body, availability: _availability, ...identity }: AuthoredFieldView) {
  return JSON.stringify(identity);
}
function binding(reference: DocumentReference): string {
  return reference.origin === 'import' ? importedBinding(reference.row) : authoredBinding(reference.row);
}
function metadata(row: Pick<ImportedFieldView, 'id' | 'subject' | 'candidate' | 'revision' | 'language' | 'digest'>) {
  return {
    id: row.id,
    subjectId: row.subject,
    candidateId: row.candidate,
    revision: row.revision,
    language: row.language,
    digest: row.digest,
  };
}
function parseBody(row: Pick<ImportedFieldView, 'availability' | 'body'>): DocumentSnapshot | null {
  if (row.availability !== 'available' || !row.body || row.body.byteLength > MAX_DOCUMENT_BYTES) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(row.body);
    const body = parseDocument(JSON.parse(text));
    if (serializeDocument(body) !== text) return null;
    return body;
  } catch {
    return null;
  }
}
function viewImported(row: ImportedFieldView): DocumentView | null {
  if (row.availability === 'erased')
    return row.body === null
      ? {
          ...metadata(row),
          origin: 'import',
          source: row.source,
          rights: row.rights,
          availability: 'erased',
          body: null,
        }
      : null;
  const body = parseBody(row);
  return body
    ? { ...metadata(row), origin: 'import', source: row.source, rights: row.rights, availability: 'available', body }
    : null;
}
function viewAuthored(row: AuthoredFieldView): DocumentView | null {
  // Authored erasures are private tombstones. Their public identity is concealed like an unknown id.
  if (row.availability !== 'available') return null;
  const body = parseBody(row);
  return body
    ? {
        ...metadata(row),
        origin: 'account',
        author: row.authorAccountId,
        licence: row.licence,
        availability: 'available',
        body,
      }
    : null;
}

/** Exact document disclosure. Stored bindings select the semantic subject and
 * candidate; imported documents also retain their original source tuple, including
 * after merges. Final passes re-read authoritative facts at their own homes; no
 * reference read holds a connection while acquiring another partition. */
export async function readDocument(
  dependencies: DocumentReadDependencies,
  id: string,
  context: ReadContext,
  maxSourceBytes?: number,
): Promise<{ document: DocumentView; anchors: readonly AnchoredPosition[] } | null> {
  const route = routeOf(id);
  if (
    route === null ||
    !admitDocumentRead({
      route,
      deadline: context.deadline,
      now: dependencies.now(),
      maxBytes: CONTENT_DOCUMENT_BYTES,
      ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
    })
  )
    return null;
  const atHome = <T>(home: number, work: (client: AccessClient) => Promise<T>) =>
    snapshot(dependencies, home, context, work);
  const readReference = async (client: AccessClient): Promise<DocumentReference | null> => {
    const imported =
      maxSourceBytes === undefined
        ? await readImportedField(client, route, id)
        : await readImportedFieldBounded(client, route, id, maxSourceBytes);
    if (imported) return { origin: 'import', row: imported };
    const authored =
      maxSourceBytes === undefined
        ? await readAuthoredField(client, route, id)
        : await readAuthoredFieldBounded(client, route, id, maxSourceBytes);
    return authored ? { origin: 'account', row: authored } : null;
  };
  try {
    const initial = (await atHome(route, readReference)).value;
    const row = initial?.row;
    if (!row || routeOf(row.subject) !== route || routeOf(row.candidate) !== route) return null;
    const resource = { route, id: row.subject };
    const check = await accessCheck(
      dependencies.access,
      context.actor,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool: dependencies.pool, deadline: context.deadline },
    );
    const ref = { subject: row.subject, candidate: row.candidate };
    const semantic = (
      await atHome(route, async (client) => {
        if (!(await check(client))) return null;
        return readCandidateDisclosure(client, ref);
      })
    ).value;
    if (!semantic?.disclosed || !Number.isSafeInteger(semantic.security_revision) || semantic.security_revision < 0)
      return null;
    let fenceAnchor: AnchoredPosition | undefined;
    if (initial.origin === 'import') {
      const source = initial.row.source;
      const home = tupleRoute(dependencies.routeKey, source.source, source.external_id);
      const tuple = {
        route: home,
        source: source.source,
        external_id: source.external_id,
        field_group: 'summary' as const,
      };
      const fenceAtHome = () => atHome(home, async (client) => (await readFences(client, [tuple]))[0]);
      const fence = (await fenceAtHome()).value;
      if (!fence || fence.takenDown) return null;

      // Native cross-partition disclosure convention: revalidate and release the
      // reference, then recheck the current owning resource before serialization.
      const finalFence = await fenceAtHome();
      const finalFenceValue = finalFence.value;
      if (!finalFenceValue || finalFenceValue.takenDown || finalFenceValue.securityRevision !== fence.securityRevision)
        return null;
      fenceAnchor = finalFence.anchor;
    }
    const final = await atHome(route, async (client) => {
      const current = await readReference(client);
      if (
        !current ||
        current.origin !== initial.origin ||
        binding(current) !== binding(initial) ||
        !(await check(client))
      )
        return null;
      const disclosure = await readCandidateDisclosure(client, ref);
      if (!disclosure?.disclosed || disclosure.security_revision !== semantic.security_revision) return null;
      return current.origin === 'import' ? viewImported(current.row) : viewAuthored(current.row);
    });
    if (!final.value || deadlineElapsed(dependencies.now(), context.deadline)) return null;
    return { document: final.value, anchors: fenceAnchor ? [fenceAnchor, final.anchor] : [final.anchor] };
  } catch (error) {
    if (error instanceof GrantDeniedError || error instanceof RangeError) return null;
    throw error;
  }
}
