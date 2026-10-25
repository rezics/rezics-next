import { parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readCandidateDisclosure } from '../semantic/disclosure.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { tupleRoute } from './imported-contract.ts';
import { readImportedField, type ImportedFieldView } from './imported-fields.ts';
import type { Anchored, AnchoredPosition, ReadContext } from './model.ts';
import { readFences } from './source-fences.ts';

export type DocumentReadDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array }>;
export type DocumentView = Readonly<{
  id: string;
  subjectId: string;
  candidateId: string;
  revision: number;
  source: ImportedFieldView['source'];
  rights: ImportedFieldView['rights'];
  language: string;
  digest: string;
}> &
  (Readonly<{ availability: 'available'; body: DocumentSnapshot }> | Readonly<{ availability: 'erased'; body: null }>);

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
const binding = ({ body: _body, availability: _availability, ...identity }: ImportedFieldView) =>
  JSON.stringify(identity);
function view(row: ImportedFieldView): DocumentView | null {
  const metadata = {
    id: row.id,
    subjectId: row.subject,
    candidateId: row.candidate,
    revision: row.revision,
    source: row.source,
    rights: row.rights,
    language: row.language,
    digest: row.digest,
  };
  if (row.availability === 'erased')
    return row.body === null ? { ...metadata, availability: 'erased', body: null } : null;
  if (row.availability !== 'available' || !row.body || row.body.byteLength > MAX_DOCUMENT_BYTES) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(row.body);
    const body = parseDocument(JSON.parse(text));
    if (serializeDocument(body) !== text) return null;
    return { ...metadata, availability: 'available', body };
  } catch {
    return null;
  }
}

/** Exact immutable imported revision disclosure. Only stored bindings select the
 * semantic subject/candidate and original source tuple, including after merges.
 * Final passes re-read authoritative facts at their own homes; no reference read
 * holds a connection while acquiring another partition. No receipt carries bytes. */
export async function readDocument(
  dependencies: DocumentReadDependencies,
  id: string,
  context: ReadContext,
): Promise<{ document: DocumentView; anchors: readonly AnchoredPosition[] } | null> {
  const route = routeOf(id);
  if (route === null || !Number.isFinite(context.deadline) || Date.now() >= context.deadline) return null;
  const atHome = <T>(home: number, work: (client: AccessClient) => Promise<T>) =>
    snapshot(dependencies, home, context, work);
  try {
    const initial = (await atHome(route, (client) => readImportedField(client, route, id))).value;
    if (!initial || routeOf(initial.subject) !== route || routeOf(initial.candidate) !== route) return null;
    const resource = { route, id: initial.subject };
    const check = await accessCheck(
      dependencies.access,
      context.actor,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool: dependencies.pool, deadline: context.deadline },
    );
    const ref = { subject: initial.subject, candidate: initial.candidate };
    const semantic = (
      await atHome(route, async (client) => {
        if (!(await check(client))) return null;
        return readCandidateDisclosure(client, ref);
      })
    ).value;
    if (!semantic?.disclosed || !Number.isSafeInteger(semantic.security_revision) || semantic.security_revision < 0)
      return null;
    const home = tupleRoute(dependencies.routeKey, initial.source.source, initial.source.external_id);
    const tuple = {
      route: home,
      source: initial.source.source,
      external_id: initial.source.external_id,
      field_group: 'summary' as const,
    };
    const fenceAtHome = () => atHome(home, async (client) => (await readFences(client, [tuple]))[0]);
    const fence = (await fenceAtHome()).value;
    if (!fence || fence.takenDown) return null;

    // Native cross-partition disclosure convention: revalidate and release the
    // reference, then recheck the current owning resource before serialization.
    const finalFence = await fenceAtHome();
    if (!finalFence.value || finalFence.value.takenDown || finalFence.value.securityRevision !== fence.securityRevision)
      return null;
    const final = await atHome(route, async (client) => {
      const current = await readImportedField(client, route, id);
      if (!current || binding(current) !== binding(initial) || !(await check(client))) return null;
      const disclosure = await readCandidateDisclosure(client, ref);
      if (!disclosure?.disclosed || disclosure.security_revision !== semantic.security_revision) return null;
      return view(current);
    });
    if (!final.value || Date.now() >= context.deadline) return null;
    return { document: final.value, anchors: [finalFence.anchor, final.anchor] };
  } catch (error) {
    if (error instanceof GrantDeniedError || error instanceof RangeError) return null;
    throw error;
  }
}
