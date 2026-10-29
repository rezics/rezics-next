import type { Source } from '@rezics/definitions/bulk';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { permissionEvidenceDeadline } from '../access/permission.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { readFences, type SourceFenceTuple } from '../content/source-fences.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccessClient, Actor, Resource } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { fenceKey, sourceTuple } from './fences.ts';
import { readItemIdentityVersion } from './item-identity.ts';
import { SubjectRedirectError } from './merges.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
import readSources from './concept-scheme-reference.sql';
import readVisibility from './read-visibility.sql';

export type ConceptSchemeRead = Readonly<{
  access: Access;
  actor: Actor;
  routeKey?: Uint8Array | undefined;
  nativeT: AuthoritativeTime;
  /** The already fixed minimum of request and permission evidence deadlines. */
  deadline: number;
  concept: Readonly<{ resource: Resource; evidence: unknown }>;
  scheme: Readonly<{ resource: Resource; evidence: unknown }>;
}>;

/** One native home at a time, including transaction control under the fixed ceiling. */
async function snapshot<T>(pool: Pool, route: number, deadline: number, read: (client: AccessClient) => Promise<T>) {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved') throw new AccessUnavailableError('contention');
        const result = await read(client);
        await client.query('COMMIT');
        return result;
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

/** Prove current readable Concept identity/type and effective Global inScheme truth.
 * This is an attempt-local observation, never a reusable permission certificate.
 * The caller prepares both native read evidences at the same command T before
 * entering. Source, foreign target and tuple homes are released independently;
 * repeated native versions reject changes reached across those observations.
 */
export async function readConceptSchemeReference(pool: Pool, options: ConceptSchemeRead): Promise<boolean> {
  authoritativeTimeValue(options.nativeT); // Verify the live native object before any I/O.
  const { concept, scheme, access, actor, nativeT, deadline } = options;
  if (
    !Number.isFinite(deadline) ||
    deadline >
      Math.min(
        permissionEvidenceDeadline(concept.evidence) ?? -Infinity,
        permissionEvidenceDeadline(scheme.evidence) ?? -Infinity,
      )
  )
    throw new TypeError('Concept scheme read requires the fixed native evidence ceiling');
  requireAccessDeadline(deadline);
  const conceptRoute = routeOf(concept.resource.id),
    schemeRoute = routeOf(scheme.resource.id);
  if (
    conceptRoute === null ||
    schemeRoute === null ||
    conceptRoute !== concept.resource.route ||
    schemeRoute !== scheme.resource.route
  )
    throw new TypeError('Concept scheme read requires canonical source keys');

  async function identity(client: AccessClient, target: typeof concept, type: string) {
    const row = await readVisibility.run(client, { route: target.resource.route, subject_id: target.resource.id });
    if (row?.visibility !== 'visible' || row.type !== type) return null;
    if (!(await access.authorize(client, actor, 'subject:read', target.resource, target.evidence, nativeT)))
      return null;
    const version = await readItemIdentityVersion(client, target.resource.id);
    if (version?.redirect) throw new SubjectRedirectError(target.resource.id, version.redirect);
    if (!version) throw new AccessUnavailableError('contention');
    return { identity: version, security: row.securityRevision, type: row.type };
  }
  const source = () =>
    snapshot(pool, conceptRoute, deadline, async (client) => {
      const version = await identity(client, concept, 'skos:Concept');
      if (!version) return null;
      const selected = await effectiveGlobalSlotFacts(client, concept.resource.id, 'skos:inScheme');
      const sources = await readSources.run(client, {
        route: conceptRoute,
        subject_id: concept.resource.id,
        candidate_ids: selected.facts.map((fact) => fact.statement_id!),
        revisions: selected.facts.map((fact) => fact.fact_revision!),
      });
      if (sources.length !== selected.facts.length) throw new AccessUnavailableError('contention');
      const provenance = new Map(sources.map((row) => [row.candidate_id, row]));
      const tuples = new Map<string, SourceFenceTuple>();
      let local = false;
      for (const fact of selected.facts) {
        const body = fact.body as { rank?: string; value?: { type: string; content?: unknown } };
        const origin = provenance.get(fact.statement_id!)!;
        if (
          origin.retracted ||
          !['normal', 'preferred'].includes(body.rank ?? '') ||
          body.value?.type !== 'value' ||
          body.value.content !== scheme.resource.id
        )
          continue;
        const source = origin.source as Source | null;
        if (source && source.field_group === 'facts') {
          if (!options.routeKey) throw new TypeError('Imported membership requires the server route key');
          const tuple = sourceTuple(options.routeKey, source);
          tuples.set(fenceKey(tuple), tuple);
        } else local = true;
      }
      return { version: JSON.stringify({ version, selected, sources }), local, tuples: [...tuples.values()] };
    });
  const target = () =>
    snapshot(pool, schemeRoute, deadline, (client) => identity(client, scheme, 'skos:ConceptScheme'));
  async function fences(tuples: SourceFenceTuple[]) {
    const groups = new Map<number, SourceFenceTuple[]>();
    for (const tuple of tuples) {
      const group = groups.get(partitionOf(tuple.route)) ?? [];
      group.push(tuple);
      groups.set(partitionOf(tuple.route), group);
    }
    const result = [];
    for (const group of groups.values())
      result.push(...(await snapshot(pool, group[0]!.route, deadline, (client) => readFences(client, group))));
    return result;
  }
  const first = await source();
  if (!first || (!first.local && first.tuples.length === 0)) return false;
  const schemeVersion = await target();
  if (!schemeVersion) return false;
  const tupleVersions = await fences(first.tuples);
  if (!first.local && tupleVersions.every((fence) => fence.takenDown)) return false;
  const last = await source();
  const lastScheme = await target();
  const lastFences = await fences(first.tuples);
  requireAccessDeadline(deadline);
  if (
    !last ||
    first.version !== last.version ||
    JSON.stringify(schemeVersion) !== JSON.stringify(lastScheme) ||
    JSON.stringify(tupleVersions) !== JSON.stringify(lastFences)
  )
    throw new AccessUnavailableError('contention');
  return true;
}
