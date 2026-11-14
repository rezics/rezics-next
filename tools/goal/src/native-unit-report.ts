import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexUsageAccumulator } from './agents/codex-events.ts';
import { scanSessionJsonl } from './session-accounting.ts';
import { registeredNativeUnits } from './native-units.ts';
import type { UtcHour } from './efficiency-report-time.ts';

const SESSION_LIMIT = 256;
type Thread = { id: string; rollout_path: string; source: string };

type SourceDelta = { dev: string; head: string; base: string; added: number; deleted: number };

/** Current committed tree difference only; no claim about authorship time, acceptance or working hours. */
function currentSourceDelta(worktree: string, includeProductPath: (path: string) => boolean): SourceDelta | null {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.error || result.status !== 0 ? null : result.stdout;
  };
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'])?.trim();
  const dev = git(['rev-parse', '--verify', 'refs/heads/dev^{commit}'])?.trim();
  const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  if (!head || !dev || !objectId.test(head) || !objectId.test(dev)) return null;
  const bases = git(['merge-base', '--all', dev, head])?.trim().split(/\r?\n/);
  if (!bases || bases.length !== 1 || !objectId.test(bases[0]!)) return null;
  const base = bases[0]!;
  const stats = git([
    'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    base, head, '--', 'apps', 'services', 'packages',
  ]);
  if (stats === null) return null;
  let added = 0;
  let deleted = 0;
  for (const row of stats.split('\0')) {
    if (!row) continue;
    const [additions, deletions, ...path] = row.split('\t');
    if (!path.length) return null;
    if (!includeProductPath(path.join('\t'))) continue;
    if (additions === '-' && deletions === '-') continue;
    if (!/^\d+$/.test(additions ?? '') || !/^\d+$/.test(deletions ?? '')) return null;
    added += Number(additions);
    deleted += Number(deletions);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) return null;
  }
  return { dev, head, base, added, deleted };
}

/** Observe registered native units in the existing completed-hour report, without importing live attempts. */
export function nativeUnitReportLines(
  db: Database,
  bucket: UtcHour,
  includeProductPath?: (path: string) => boolean,
): string[] {
  const units = registeredNativeUnits(db);
  if (!units.length) return [];
  const sourceDeltas = units.map((unit) => {
    const delta = includeProductPath ? currentSourceDelta(unit.worktree, includeProductPath) : null;
    return delta
      ? `Current native unit committed source awaiting dev: ${unit.id}; +${delta.added} product additions; ${delta.deleted} product deletions; merge-base ${delta.base}, dev ${delta.dev}, unit HEAD ${delta.head}.`
      : `Current native unit committed source awaiting dev: ${unit.id}; unknown (Git source observation or product classifier unavailable).`;
  });
  sourceDeltas.push(
    'Current native source deltas exclude working-tree edits and use the existing product classifier. They are committed branch changes since merge-base with dev, not new hourly authored throughput; imported or older source may be present. Do not add them across overlapping units or to frozen UTC buckets, late integration backfill, accepted journeys or an efficiency multiplier.',
  );
  const start = Date.parse(bucket.start);
  const end = Date.parse(bucket.end);
  const sessions = new Set<string>();
  const responses = new Set<string>();
  const hasAttempts = Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_attempts'").get(),
  );
  const sessionIndex = Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='worker_attempts_session'").get(),
  );
  if (hasAttempts && !sessionIndex)
    return [
      ...sourceDeltas,
      `Native execution units: ${units.length} registered; usage unknown (managed session lookup index unavailable).`,
    ];
  const managed = hasAttempts
    ? db.query(
        "SELECT 1 FROM worker_attempts INDEXED BY worker_attempts_session WHERE json_extract(body, '$.session')=? LIMIT 1",
      )
    : undefined;
  let input = 0,
    output = 0,
    cached = 0,
    measured = 0,
    unknown = 0,
    overlaps = 0,
    duplicateResponses = 0;
  let startedChecks = 0,
    passedChecks = 0,
    failedChecks = 0,
    unknownChecks = 0,
    unknownCheckSource = 0;
  const nativeStates: string[] = [];
  for (const unit of units) {
    let native: Database | undefined;
    let goals: Database | undefined;
    try {
      const checks = db
        .query(`SELECT ended_at, exit_code, source_commit FROM native_unit_runs
        INDEXED BY native_unit_runs_unit_started WHERE unit=? AND started_at>=? AND started_at<? LIMIT 257`)
        .all(unit.id, bucket.start, bucket.end) as {
        ended_at: string | null;
        exit_code: number | null;
        source_commit: string | null;
      }[];
      if (checks.length > 256) unknownChecks++;
      for (const check of checks.slice(0, 256)) {
        startedChecks++;
        if (!check.source_commit) unknownCheckSource++;
        if (!check.ended_at || check.exit_code === null) unknownChecks++;
        else if (check.exit_code === 0) passedChecks++;
        else failedChecks++;
      }
      native = new Database(join(unit.codexHome, 'state_5.sqlite'), { readonly: true });
      goals = new Database(join(unit.codexHome, 'goals_1.sqlite'), { readonly: true });
      const goal = goals
        .query('SELECT status FROM thread_goals WHERE thread_id=? AND goal_id=?')
        .get(unit.threadId, unit.goalId) as { status: string } | null;
      nativeStates.push(`${unit.id} ${goal?.status ?? 'unknown'}`);
      const pending: { id: string; parent?: string }[] = [{ id: unit.threadId }];
      for (let index = 0; index < pending.length; index++) {
        if (sessions.size >= SESSION_LIMIT) {
          unknown++;
          break;
        }
        const candidate = pending[index]!;
        const key = `${unit.codexHome}\0${candidate.id}`;
        if (sessions.has(key)) continue;
        sessions.add(key);
        const thread = native
          .query('SELECT id, rollout_path, source FROM threads WHERE id=?')
          .get(candidate.id) as Thread | null;
        if (!thread) {
          unknown++;
          continue;
        }
        if (candidate.parent) {
          let parent: unknown;
          try {
            parent = JSON.parse(thread.source)?.subagent?.thread_spawn?.parent_thread_id;
          } catch {
            /* not a spawned child */
          }
          if (parent !== candidate.parent) {
            unknown++;
            continue;
          }
        }
        const excluded = Boolean(managed?.get(candidate.id));
        if (excluded) overlaps++;
        const accumulator = codexUsageAccumulator(start, end - 1);
        let incompleteLedger = false,
          sawLedger = false,
          acceptedLedger = 0;
        const scan = scanSessionJsonl(thread.rollout_path, (event) => {
          const item = event.payload?.type === 'item_completed' ? event.payload.item : undefined;
          const child = item?.type === 'SubAgentActivity' ? item.agent_thread_id : undefined;
          if (typeof child === 'string' && child && !pending.some((row) => row.id === child)) {
            if (pending.length < SESSION_LIMIT) pending.push({ id: child, parent: candidate.id });
            else incompleteLedger = true;
          }
          if (event.type !== 'token_usage_record') return;
          sawLedger = true;
          const at = Date.parse(event.timestamp);
          if (!Number.isFinite(at)) {
            incompleteLedger = true;
            return;
          }
          if (at < start || at >= end) return;
          if (excluded) return;
          const responseId = event.response_id ?? event.payload?.response_id ?? event.responseId;
          if (typeof responseId !== 'string' || !responseId) {
            incompleteLedger = true;
            return;
          }
          if (responses.has(responseId)) {
            duplicateResponses++;
            return;
          }
          responses.add(responseId);
          acceptedLedger++;
          accumulator.add(event);
        });
        if (excluded) continue;
        const usage = accumulator.finish();
        if (!scan.complete || incompleteLedger) unknown++;
        if (usage) {
          measured++;
          input += usage.tokens.input;
          output += usage.tokens.output;
          cached += usage.tokens.cached;
        } else if (acceptedLedger > 0 || !sawLedger) {
          unknown++;
        } else if (!incompleteLedger && scan.complete) {
          // No charged response in this bucket is zero observed usage, not cumulative thread tokens.
          measured++;
        }
      }
    } catch {
      unknown++;
      if (!nativeStates.some((state) => state.startsWith(`${unit.id} `))) nativeStates.push(`${unit.id} unknown`);
    } finally {
      native?.close();
      goals?.close();
    }
  }
  return [
    ...sourceDeltas,
    `Native execution units: ${nativeStates.join('; ')}. ${sessions.size} distinct parent/subagent sessions observed; ${measured} measured; ${unknown} unknown or incomplete. Native Goal status is execution state, not release acceptance.`,
    `Native unit usage in UTC bucket: ${input} input, ${cached} cached input, ${output} output raw session-ledger tokens; ${overlaps} managed sessions excluded; ${duplicateResponses} copied response records deduplicated${unknown ? '; totals are partial' : ''}. These observed tokens are separate from completed managed attempts; do not add cumulative Goal totals.`,
    `Native unit checks started in UTC bucket: ${startedChecks}; command exit zero ${passedChecks}; nonzero ${failedChecks}; unfinished or unknown ${unknownChecks}; immutable capture source unknown ${unknownCheckSource}. Command exits do not prove source; observed source belongs only to matched immutable capture receipts, not accepted journeys or a newer local candidate.`,
  ];
}
