import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { accessRoot } from '../access/derived-access.ts';
import { accessEvidenceDeadline } from '../access/evidence-deadline.ts';
import { privateSubjectReader } from '../access/private-subject-reader.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { LIBRARY_SUBJECT_PAGE_LIMIT } from '../library/contract/presentation.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { SummarySources } from './contract/summaries.ts';
import releasePointer from './definitions-active.sql';
import disclosure from './private-subject-disclosure.sql';
import eventKinds from './summary-position-events.sql';
import type { SummaryReaderDependencies } from './subject-reading-application.ts';

type Client = Pick<PoolClient, 'query'>;
type SummaryWitness =
  | { status: 'complete'; at: string; subjects: string; digest: string; head: number }
  | { status: 'dependent-source' | 'reader-profile' | 'release-missing' | 'subject-coverage' | 'disclosure-changed' };

/** Additional equality evidence only for a fully disclosed batch of self-mapped Subjects.
 * Ordinary Access and Summary projection still run on both snapshots. The private disclosure
 * statement binds account, authority, redirect and erasure versions for every requested key.
 */
export async function readSummaryWitness(
  client: Client,
  deps: SummaryReaderDependencies,
  ids: readonly string[],
  firstAt?: string,
): Promise<SummaryWitness> {
  if (deps.actor.kind !== 'account' || !ids.length) return { status: 'reader-profile' };
  const { accountId } = deps.actor;
  // The original authenticator binds the account. Both projections use the caller's Access adapter.
  const reader = privateSubjectReader(accessRoot(deps.access), deps.actor, deps.pool);
  if (!reader) return { status: 'reader-profile' };
  const until = accessEvidenceDeadline(Math.min(deps.deadline, reader.deadline));
  const release = await releasePointer.run(client, { route: 0 });
  if (!release) return { status: 'release-missing' };
  const time = await mintReadTime(client);
  try {
    const at = authoritativeTimeValue(time);
    const hash = createHash('sha256').update(
      JSON.stringify([
        accountId,
        deps.actor.clientId,
        deps.actor.requestedBy,
        deps.actor.scopes,
        deps.actor.authnEpoch,
        reader.accountVersion,
        reader.floor,
        ids,
      ]),
    );
    for (let offset = 0; offset < ids.length; offset += LIBRARY_SUBJECT_PAGE_LIMIT) {
      requireAccessDeadline(until);
      const batch = ids.slice(offset, offset + LIBRARY_SUBJECT_PAGE_LIMIT);
      const pairs = batch.flatMap((id) => [id, id]);
      const { rows } = await client.query<{
        id: string | null;
        visibility: string;
        target: string | null;
        denied: boolean;
      }>(disclosure.sql, [
        routeOf(accountId),
        accountId,
        reader.floor,
        reader.accountVersion,
        pairs.map(routeOf),
        pairs,
        at,
        firstAt ?? at,
      ]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length !== batch.length || byId.size !== batch.length) return { status: 'subject-coverage' };
      for (const id of batch) {
        const row = byId.get(id);
        if (!row) return { status: 'subject-coverage' };
        if (row.visibility !== 'visible' || row.target !== null || row.denied !== false)
          return { status: 'disclosure-changed' };
        hash.update(JSON.stringify(row));
      }
    }
    requireAccessDeadline(until);
    return { status: 'complete', at, subjects: hash.digest('hex'), digest: release.digest, head: release.head };
  } finally {
    releaseOperationalTime(time);
  }
}

export async function summaryPositionRegion(
  client: Client,
  before: SummarySources,
  after: SummarySources,
  ids: readonly string[],
) {
  const previous = new Map(before.map((source) => [source.partition, source]));
  const next = after.find((source) => {
    const old = previous.get(source.partition);
    return old && old.epoch === source.epoch && old.position < source.position;
  });
  if (!next) return null;
  const from = previous.get(next.partition)!.position.toString();
  const through = next.position.toString();
  const { rows } = await client.query<{ position: string; event_seq: number; kind: string | null }>(eventKinds.sql, [
    next.partition,
    from,
    through,
  ]);
  return {
    partition: next.partition,
    epoch: next.epoch,
    after: from,
    through,
    releaseHome: next.partition === 0,
    subjectHome: ids.some((id) => {
      const route = routeOf(id);
      return route !== null && partitionOf(route) === next.partition;
    }),
    events: rows.slice(0, 8).map(({ position, event_seq, kind }) => ({
      position,
      sequence: event_seq,
      kind: kind && lookupEventType(kind) ? kind : 'unregistered',
    })),
    truncated: rows.length > 8,
  };
}
