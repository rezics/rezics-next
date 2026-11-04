import type { Pool } from 'pg';
import { readAccountDiscoveryBindings, readAccountDiscoverySummaries } from './account-discovery-source.ts';
import { readPublicViews, type PublicViews } from './public-views.ts';
import { AccessUnavailableError, CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accountAgentId, accountAgentsForSubjects, type AccountAgentLink } from '../semantic/agents.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/identity-epoch-read.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';

export type PublicAccountCanonicalView = 'overview' | 'posts' | 'reviews' | 'collections';

export type PublicAccountCanonicalTarget = {
  accountId: string;
  accountKind: 'actor' | 'organization';
  handle: string | null;
  canonicalPath: string | null;
  views: readonly PublicAccountCanonicalView[];
};

type Pointer = { subjectId: string; accountId: string; receiptId: string };
type Binding = Awaited<ReturnType<typeof readAccountDiscoveryBindings>> extends Map<string, infer T> ? T : never;
type Proven = { pointer: Pointer; binding: Binding; views: PublicViews; epochs: readonly bigint[] };
type AccountSummary = NonNullable<
  Awaited<ReturnType<typeof readAccountDiscoverySummaries>> extends Map<string, infer T> ? T : never
>;

function homes(ids: readonly string[]) {
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Account canonical targets require full routed keys');
    const home = partitionOf(route);
    const group = groups.get(home) ?? [];
    group.push(id);
    groups.set(home, group);
  }
  return groups;
}

async function pointers(pool: Pool, ids: readonly string[], deadline: number) {
  const result = new Map<string, Pointer>();
  for (const [home, group] of homes(ids)) {
    requireAccessDeadline(deadline);
    const rows = await withReadTransaction(pool, async (client) => {
      const owner = await readPartition(client, home);
      if (!owner) throw new CommandUnavailableError('contention', home);
      if (owner.writeState !== 'active')
        throw new CommandUnavailableError(owner.writeState === 'moved' ? 'moved' : 'fenced', home, owner.movedTo);
      return (
        await client.query<Pointer>(
          `SELECT subject_id::text AS "subjectId", account_id::text AS "accountId",
             verification_receipt_id::text AS "receiptId"
           FROM access.agent_page
           WHERE (route, subject_id) IN (SELECT * FROM unnest($1::integer[], $2::uuid[]))`,
          [group.map((id) => routeOf(id)!), group],
        )
      ).rows;
    });
    for (const row of rows) {
      // Stored routing corruption is an unexpected owner failure, never a negative.
      if (routeOf(row.accountId) === null) throw new TypeError('Agent page contains an invalid Account key');
      result.set(row.subjectId, row);
    }
    requireAccessDeadline(deadline);
  }
  return result;
}

/** Exact native reciprocal facts plus the delivered current publication reader.
 * Legacy redirect/merge rows and agent_verified alone never satisfy this guard.
 */
async function observe(deps: SummaryReaderDependencies, ids: readonly string[]) {
  const pages = await pointers(deps.pool, ids, deps.deadline);
  const bindings = new Map<string, Binding>();
  const views = new Map<string, PublicViews>();
  for (const [home, group] of homes([...new Set([...pages.values()].map((page) => page.accountId))])) {
    requireAccessDeadline(deps.deadline);
    await withReadTransaction(deps.pool, async (client) => {
      const found = await readAccountDiscoveryBindings(deps.pool, home, group, client);
      const flags = await readPublicViews(client, group);
      for (const [id, binding] of found) bindings.set(id, binding);
      for (const [id, flagsForAccount] of flags) views.set(id, flagsForAccount);
    });
  }
  const reciprocal = [...pages.values()].filter((page) => {
    const binding = bindings.get(page.accountId);
    return binding?.agent?.subjectId === page.subjectId && binding.agent.receiptId === page.receiptId;
  });
  const links = new Map<string, AccountAgentLink>();
  for (const group of homes(reciprocal.map((page) => page.subjectId)).values()) {
    requireAccessDeadline(deps.deadline);
    const found = await withReadTransaction(deps.pool, (client) => accountAgentsForSubjects(client, group));
    for (const [id, link] of found) links.set(id, link);
  }
  const candidates = reciprocal.filter((page) => {
    const link = links.get(page.subjectId);
    return (
      link?.verified &&
      link.subject === page.subjectId &&
      link.account === page.accountId &&
      link.route === routeOf(page.accountId) &&
      link.agent_id === accountAgentId(page.accountId) &&
      link.receipt_id === page.receiptId
    );
  });
  const originals = [...new Set(candidates.flatMap((page) => [accountAgentId(page.accountId), page.subjectId]))];
  const mappings = new Map<string, Awaited<ReturnType<typeof readIdentityMappings>>[number]>();
  // At most 200 exact keys, in the production reader's bounded batches of 100.
  for (let offset = 0; offset < originals.length; offset += 100) {
    requireAccessDeadline(deps.deadline);
    const group = originals.slice(offset, offset + 100);
    const found = await readIdentityMappings(deps.pool, group);
    found.forEach((mapping, index) => mappings.set(group[index]!, mapping));
  }
  const result = new Map<string, Proven>();
  for (const page of candidates) {
    const mapping = mappings.get(accountAgentId(page.accountId));
    const target = mappings.get(page.subjectId);
    if (
      !mapping ||
      !target ||
      mapping.state === 'unavailable' ||
      target.state === 'unavailable' ||
      mapping.state === 'pending' ||
      target.state === 'pending'
    )
      throw new AccessUnavailableError('contention');
    // A reciprocal native link with missing publication authority is unavailable,
    // including a legacy merge whose mapping has never been installed.
    if (mapping.state !== 'mapped' || target.state !== 'mapped') throw new AccessUnavailableError('contention');
    if (mapping.epoch <= 0n || target.epoch <= 0n) throw new AccessUnavailableError('contention');
    if (mapping.terminal !== page.subjectId || target.terminal !== page.subjectId || mapping.epoch !== target.epoch)
      continue;
    result.set(page.subjectId, {
      pointer: page,
      binding: bindings.get(page.accountId)!,
      views: views.get(page.accountId)!,
      epochs: [mapping.epoch, target.epoch],
    });
  }
  requireAccessDeadline(deps.deadline);
  return result;
}

function unchanged(before: Proven, after: Proven) {
  return (
    before.pointer.accountId === after.pointer.accountId &&
    before.pointer.receiptId === after.pointer.receiptId &&
    before.binding.revision === after.binding.revision &&
    before.binding.handle === after.binding.handle &&
    before.binding.claim?.route === after.binding.claim?.route &&
    before.binding.claim?.revision === after.binding.claim?.revision &&
    before.binding.consumedClaimRevision === after.binding.consumedClaimRevision &&
    // Presentation changes do not have to advance discovery_revision.
    before.views.posts === after.views.posts &&
    before.views.reviews === after.views.reviews &&
    before.views.collections === after.views.collections &&
    before.epochs.every((epoch, index) => epoch === after.epochs[index])
  );
}

/** Null means no positive Account target was proven. Subject listability remains Semantic's fact. */
export async function readPublicAccountCanonicalTargets(
  deps: SummaryReaderDependencies,
  subjectIds: readonly string[],
): Promise<Map<string, PublicAccountCanonicalTarget | null>> {
  if (subjectIds.length > 100) throw new RangeError('Account canonical targets accept at most 100 ids');
  const ids = [...new Set(subjectIds)];
  homes(ids); // Validate the entire input before opening any connection.
  if (!(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Account canonical targets require the server route key');
  requireAccessDeadline(deps.deadline);
  const result = new Map<string, PublicAccountCanonicalTarget | null>(ids.map((id) => [id, null]));
  if (!ids.length) return result;
  const reader: SummaryReaderDependencies = { ...deps, actor: { kind: 'anonymous' } };
  const initial = await observe(reader, ids);
  const summaries = new Map<string, AccountSummary>();
  // These are the actual current anonymous Account summaries, with exact claim
  // checks and released foreign hydration, not a second public-profile policy.
  const accounts = [...new Set([...initial.values()].map(({ pointer }) => pointer.accountId))];
  for (const group of homes(accounts).values()) {
    const found = await readAccountDiscoverySummaries(reader, group);
    for (const [id, summary] of found) if (summary) summaries.set(id, summary);
  }
  const current = await observe(reader, ids);
  for (const [id, before] of initial) {
    const after = current.get(id);
    const summary = summaries.get(before.pointer.accountId);
    if (!after || !summary || !unchanged(before, after) || summary.handle !== after.binding.handle) continue;
    const handle = summary.handle;
    result.set(id, {
      accountId: summary.id,
      accountKind: summary.accountKind,
      handle,
      canonicalPath: handle ? `/@${encodeURIComponent(handle)}` : null,
      views: handle
        ? ['overview', ...(['posts', 'reviews', 'collections'] as const).filter((view) => after.views[view])]
        : [],
    });
  }
  requireAccessDeadline(deps.deadline);
  return result;
}
