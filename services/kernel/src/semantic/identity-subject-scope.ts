import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import { readReleasedIdentityMappingsInSnapshot } from './identity-adapters/identity-epoch-read.ts';
import { comparableIdentityEvidence } from './identity-core/index.ts';

const PAGE_ORIGINALS = 16;
export const IDENTITY_SUBJECT_SCOPE_MAX_ORIGINALS = 4096;

export type IdentitySubjectScopeFrontier = Readonly<{ after: string; seen: number }>;
export type IdentitySubjectScope = Readonly<{
  state: 'ready';
  terminal: string;
  basis: string;
  home: number;
  generation: string;
  epoch: bigint;
  count: number;
}>;
type ScopeResult = IdentitySubjectScope | { state: 'missing' | 'unavailable' };
type ScopePage = Readonly<{
  state: 'ready';
  pageBasis: string;
  visibleOriginals: readonly string[];
  next: IdentitySubjectScopeFrontier | null;
}>;
type Group = {
  generation: string;
  version: string;
  closure_incarnation: string;
  observed_count: string;
};
type SubjectState = { id: string; visibility: string; security_revision: string };
type Client = Pick<PoolClient, 'query'>;

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function subjectStates(client: Client, ids: readonly string[]) {
  return (
    await client.query<SubjectState>(
      `SELECT s.subject_id AS id,s.visibility,s.security_revision::text
       FROM unnest($1::uuid[],$2::integer[]) requested(id,route)
       JOIN LATERAL (
         SELECT subject_id,visibility,security_revision FROM semantic.subject
         WHERE (route,subject_id)=(requested.route,requested.id) LIMIT 1
       ) s ON true ORDER BY s.subject_id`,
      [ids, ids.map(routeOf)],
    )
  ).rows;
}

/**
 * The caller supplies an owned repeatable-read snapshot and applies current
 * Access decisions before reading members of the resolved terminal.
 */
export async function readIdentitySubjectScope(client: Client, requested: string): Promise<ScopeResult> {
  const selected = await readReleasedIdentityMappingsInSnapshot(client, [requested]);
  const original = selected.mappings[0];
  if (original?.state === 'absent') return { state: 'missing' };
  if (original?.state !== 'mapped') return { state: 'unavailable' };

  const terminal = original.terminal;
  // A split can keep a restored terminal's group in the prior group's control home.
  const home = selected.evidence.sourceRows[0]?.control_partition;
  if (home == null || routeOf(terminal) === null) return { state: 'unavailable' };
  const canonical = terminal === requested ? selected : await readReleasedIdentityMappingsInSnapshot(client, [terminal]);
  const target = canonical.mappings[0];
  if (
    target?.state !== 'mapped' ||
    target.terminal !== terminal ||
    target.epoch !== original.epoch ||
    canonical.evidence.sourceRows[0]?.control_partition !== home
  )
    return { state: 'unavailable' };

  const endpoints = [...new Set([requested, terminal])];
  const states = await subjectStates(client, endpoints);
  if (states.length !== endpoints.length || states.some((state) => state.visibility !== 'visible'))
    return { state: 'missing' };

  const group = (
    await client.query<Group>(
      `SELECT g.generation,g.version::text,g.closure_incarnation,g.observed_count::text
       FROM semantic.identity_epoch_group g
       WHERE (g.partition_no,g.terminal)=($1,$2) AND g.ready AND g.closure_state='open'
         AND g.pending_job IS NULL AND g.pending_epoch IS NULL AND g.published_epoch=$3
         AND NOT EXISTS (
           SELECT 1 FROM unnest($4::uuid[]) requested(original)
           WHERE NOT EXISTS (
             SELECT 1 FROM semantic.identity_epoch_original m
             WHERE (m.partition_no,m.generation,m.terminal,m.original)=(g.partition_no,g.generation,g.terminal,requested.original)
               AND m.present
           )
         )`,
      [home, terminal, original.epoch.toString(), endpoints],
    )
  ).rows[0];
  const count = Number(group?.observed_count);
  if (!group || !Number.isSafeInteger(count) || count < 1 || count > IDENTITY_SUBJECT_SCOPE_MAX_ORIGINALS)
    return { state: 'unavailable' };
  const basis = fingerprint([
    requested,
    terminal,
    group,
    states,
    comparableIdentityEvidence(selected.evidence),
    terminal === requested ? null : comparableIdentityEvidence(canonical.evidence),
  ]);
  return { state: 'ready', terminal, basis, home, generation: group.generation, epoch: original.epoch, count };
}

/** Seek one window of the published directory in the scope's own snapshot. */
export async function readIdentitySubjectScopePage(
  client: Client,
  requested: string,
  scope: IdentitySubjectScope,
  frontier: IdentitySubjectScopeFrontier | null,
): Promise<ScopePage | { state: 'unavailable' }> {
  const { terminal, home, generation, epoch, count } = scope;
  const seen = frontier?.seen ?? 0;

  const aliasLimit = frontier ? PAGE_ORIGINALS : PAGE_ORIGINALS - 1;
  const aliases = (
    await client.query<{ original: string }>(
      `SELECT original FROM semantic.identity_epoch_original
       WHERE partition_no=$1 AND generation=$2 AND terminal=$3 AND present AND original<>$3
         ${frontier ? 'AND original>$5::uuid' : ''}
       ORDER BY original LIMIT $4`,
      [home, generation, terminal, aliasLimit + 1, ...(frontier ? [frontier.after] : [])],
    )
  ).rows.map((row) => row.original);
  const scanned = frontier ? aliases.length : aliases.length + 1;
  // A short directory page is exhaustion only if the published cardinality
  // accounts for every consumed member. The extra key must still fit that count.
  const more = aliases.length > aliasLimit;
  if (seen >= count || seen + scanned > count || (!more && seen + scanned !== count))
    return { state: 'unavailable' };

  const pageAliases = aliases.slice(0, aliasLimit);
  const otherOriginals = pageAliases.filter((id) => id !== requested);
  const membership = otherOriginals.length ? await readReleasedIdentityMappingsInSnapshot(client, otherOriginals) : null;
  if (
    membership?.mappings.some(
      (member) => member.state !== 'mapped' || member.terminal !== terminal || member.epoch !== epoch,
    ) ||
    membership?.evidence.sourceRows.some((member) => member.control_partition !== home)
  )
    return { state: 'unavailable' };
  const memberStates = otherOriginals.length ? await subjectStates(client, otherOriginals) : [];
  if (memberStates.length !== otherOriginals.length) return { state: 'unavailable' };
  const visible = new Set([requested, terminal]);
  for (const state of memberStates) if (state.visibility === 'visible') visible.add(state.id);
  const originals = frontier ? pageAliases : [terminal, ...pageAliases];
  return {
    state: 'ready',
    pageBasis: fingerprint([originals, memberStates, membership && comparableIdentityEvidence(membership.evidence)]),
    visibleOriginals: originals.filter((id) => visible.has(id)),
    next: more ? { after: pageAliases.at(-1)!, seen: seen + originals.length } : null,
  };
}
