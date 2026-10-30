import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Type } from 'typebox';
import { systemClock, type KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { registerEventTypes } from '../events/catalogue.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { parseText } from './text.ts';
import type { SearchRequest } from './service.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerOperations } from './public-filter-consumer-contract.ts';
import { withReadTransaction } from '../semantic/read.ts';

export const TRENDING = Object.freeze({
  days: 7,
  threshold: 10,
  candidates: 10,
  contributors: 16,
  bytes: 256,
  cleanup: 10,
});
const DAY = 86_400_000;
const EVENT = 'com.rezics.search.trending.changed.v1';
registerEventTypes({ [EVENT]: Type.Object({}, { additionalProperties: false }) });
export type TrendingSearches = { trendingSearches: { query: string; display: string }[]; next: null };
export type TrendingOutcome = { status: 'preparing' | 'unavailable' } | { status: 'ready'; page: TrendingSearches };
export type TrendingTerm = { key: string; language: string; source: string; display: string };
export type TrendingMember = { account: string; at: number };
export type TrendingCandidate = TrendingTerm & { members: TrendingMember[] };

/** Only a single positive literal from an explicit search operation; never suggestions/history. */
export function trendingLiteral(body: SearchRequest): string | null {
  if (
    !body.text ||
    body.filter !== undefined ||
    body.cursor ||
    body.kindCursor ||
    (body.sort && body.sort !== 'relevance')
  )
    return null;
  try {
    const node = parseText(body.text);
    return node.kind === 'term' || node.kind === 'phrase' ? node.value : null;
  } catch {
    return null;
  }
}
export function literalQuery(display: string): string | null {
  if (!display || Buffer.byteLength(display) > TRENDING.bytes) return null;
  const query = `"${display.replace(/[\\"]/g, '\\$&')}"`;
  try {
    const parsed = parseText(query);
    return parsed.kind === 'phrase' && parsed.value === display ? query : null;
  } catch {
    return null;
  }
}
export function publicTerm(source: string, language: string, display: string): TrendingTerm | null {
  if (!literalQuery(display)) return null;
  // Identity is the public meaning + language + exact label, never an arbitrary user's text hash.
  const key = createHash('sha256')
    .update(JSON.stringify([source, language, display]))
    .digest('hex');
  return { key, source, language, display };
}

/** Pure reduction over CURRENT native owner results; this is not a publication/permission port. */
export function reduceTrendingCandidates(
  candidates: readonly TrendingCandidate[],
  now: number,
  currentLabels: ReadonlyMap<string, readonly { language: string; value: string }[]>,
  eligibleAccounts: ReadonlySet<string>,
  limit: number,
): TrendingSearches {
  const selected = candidates.slice(0, TRENDING.candidates).flatMap((term) => {
    if (
      !currentLabels.get(term.source)?.some((label) => label.language === term.language && label.value === term.display)
    )
      return [];
    const members = new Set(
      term.members
        .slice(0, TRENDING.contributors)
        .filter(({ account, at }) => at > now - TRENDING.days * DAY && at <= now && eligibleAccounts.has(account))
        .map(({ account }) => account),
    );
    const query = literalQuery(term.display);
    return members.size >= TRENDING.threshold && query
      ? [{ query, display: term.display, rank: members.size, key: term.key }]
      : [];
  });
  selected.sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key));
  return { trendingSearches: selected.slice(0, limit).map(({ query, display }) => ({ query, display })), next: null };
}

/** Search's private, bounded maintained projection. All writes use the existing command executor, home 0.
 * Stored members are never public and never an eligibility authority. No query text enters events.
 */
export function trendingSearchStore(pool: Pool, clock: KernelClock = systemClock) {
  const command = <T>(body: (tx: CommandTransaction, now: number) => Promise<{ changed: boolean; value: T }>) =>
    runCommand(pool, { partition: 0, clock }, async (tx) => {
      const now = Date.parse(authoritativeTimeValue(currentCommand(tx).time));
      const result = await body(tx, now);
      return result.changed ? { value: result.value, events: [{ type: EVENT, data: {} }] } : noEffect(result.value);
    });
  return {
    async candidates(language: string, now: number): Promise<TrendingCandidate[]> {
      return withReadTransaction(pool, async (tx) => {
        const terms = (
          await tx.query<TrendingTerm>(
            `SELECT term_key AS key, language, source_id::text AS source, display
          FROM search.trending_term WHERE route=0 AND language=$1
          ORDER BY rank DESC, term_key LIMIT 10`,
            [language],
          )
        ).rows;
        // At most 10 exact term probes, each with at most 16 retained members. No query-log scan/group-by.
        const result: TrendingCandidate[] = [];
        for (const term of terms) {
          const members = (
            await tx.query<{ account: string; at: Date }>(
              `SELECT account_id::text AS account, contributed_at AS at
            FROM search.trending_member WHERE route=0 AND term_key=$1 ORDER BY account_id LIMIT 16`,
              [term.key],
            )
          ).rows;
          result.push({ ...term, members: members.map(({ account, at }) => ({ account, at: at.getTime() })) });
        }
        return result;
      });
    },
    /** Called only after the real native binding admits the source AND Account at current T. */
    contribute(term: TrendingTerm, account: string) {
      return command(async (tx, now) => {
        const barrier = await tx.query(
          `SELECT 1 FROM search.trending_blocked WHERE route=0 AND
          ((kind='account' AND identity=$1) OR (kind='source' AND identity=$2))`,
          [account, term.source],
        );
        if (barrier.rowCount) return { changed: false, value: false };
        await tx.query(
          `INSERT INTO search.trending_term(route,term_key,language,source_id,display,rank,expires_at)
          VALUES(0,$1,$2,$3,$4,0,$5) ON CONFLICT(route,term_key) DO NOTHING`,
          [term.key, term.language, term.source, term.display, new Date(now + TRENDING.days * DAY)],
        );
        await tx.query('SELECT term_key FROM search.trending_term WHERE route=0 AND term_key=$1 FOR UPDATE', [
          term.key,
        ]);
        await tx.query('DELETE FROM search.trending_member WHERE route=0 AND term_key=$1 AND contributed_at <= $2', [
          term.key,
          new Date(now - TRENDING.days * DAY),
        ]);
        const rows = (
          await tx.query<{ account: string; day: string }>(
            `SELECT account_id::text AS account, day::text
          FROM search.trending_member WHERE route=0 AND term_key=$1 ORDER BY account_id LIMIT 16`,
            [term.key],
          )
        ).rows;
        const day = new Date(now).toISOString().slice(0, 10);
        const own = rows.find((row) => row.account === account);
        if ((!own && rows.length >= TRENDING.contributors) || own?.day === day) return { changed: true, value: false };
        await tx.query(
          `INSERT INTO search.trending_member(route,term_key,account_id,day,contributed_at)
          VALUES(0,$1,$2,$3,$4) ON CONFLICT(route,term_key,account_id) DO UPDATE
          SET day=excluded.day,contributed_at=excluded.contributed_at`,
          [term.key, account, day, new Date(now)],
        );
        await tx.query(`UPDATE search.trending_term SET rank=$2,expires_at=$3 WHERE route=0 AND term_key=$1`, [
          term.key,
          rows.length + (own ? 0 : 1),
          new Date(now + TRENDING.days * DAY),
        ]);
        return { changed: true, value: true };
      });
    },
    /** Permanent minimal native barrier precedes paged removal; late deliveries cannot restore members. */
    withdraw(kind: 'account' | 'source', identity: string) {
      return command(async (tx) => {
        await tx.query(
          `INSERT INTO search.trending_blocked(route,kind,identity) VALUES(0,$1,$2) ON CONFLICT DO NOTHING`,
          [kind, identity],
        );
        if (kind === 'account') {
          const rows = await tx.query(
            `DELETE FROM search.trending_member WHERE route=0 AND (term_key,account_id) IN
            (SELECT term_key,account_id FROM search.trending_member WHERE route=0 AND account_id=$1 ORDER BY term_key LIMIT 10) RETURNING term_key`,
            [identity],
          );
          return {
            changed: true,
            value: rows.rowCount === TRENDING.cleanup ? ('progress' as const) : ('complete' as const),
          };
        }
        const rows = await tx.query(
          `DELETE FROM search.trending_term WHERE route=0 AND term_key IN
          (SELECT term_key FROM search.trending_term WHERE route=0 AND source_id=$1 ORDER BY term_key LIMIT 10) RETURNING term_key`,
          [identity],
        );
        return {
          changed: true,
          value: rows.rowCount === TRENDING.cleanup ? ('progress' as const) : ('complete' as const),
        };
      });
    },
    expire() {
      return command(async (tx, now) => {
        const rows = await tx.query(
          `DELETE FROM search.trending_term WHERE route=0 AND term_key IN
          (SELECT term_key FROM search.trending_term WHERE route=0 AND expires_at <= $1 ORDER BY expires_at,term_key LIMIT 10)
          RETURNING term_key`,
          [new Date(now)],
        );
        return { changed: !!rows.rowCount, value: rows.rowCount ?? 0 };
      });
    },
  };
}

/** The agreed Source/consumer types exist, but their registered identity/definition runtime does not.
 * This adapter deliberately cannot activate ingestion or publish. It is replaced at composition once the
 * actual owners deliver the binding, current Account opt-out/erasure hooks, and scoped observation.
 * The owned store/reducer/API/UI are implemented independently of that pending activation.
 */
export function createTrendingSearchesService(config: {
  pool: Pool;
  clock?: KernelClock;
  source?: PublicFilterSource;
  consumer?: PublicFilterConsumerOperations;
}) {
  const store = trendingSearchStore(config.pool, config.clock);
  return {
    store,
    async read(language: string, limit = 10): Promise<TrendingOutcome> {
      if (
        !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) ||
        language.length > 35 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10
      )
        throw new ProblemError('invalid_request');
      // Neither these reader ports nor readStatus can mint the missing native trend read-definition binding.
      return { status: 'preparing' };
    },
    async submitted(actor: Actor, body: SearchRequest): Promise<'excluded' | 'preparing'> {
      if (actor.kind !== 'account' || !trendingLiteral(body)) return 'excluded';
      return 'preparing';
    },
  };
}
