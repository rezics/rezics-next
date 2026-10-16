import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

interface Entry {
  token: string;
  id: string;
  owner?: ProcessIdentity;
  queuedAt: string;
  handoffAt?: string;
  revision: number;
  base?: string;
  after?: string;
  advance: boolean;
}
interface Train { entries: Entry[] }
export interface TrainEvent {
  at: string;
  event: string;
  token: string;
  id: string;
  position?: number;
  revision?: number;
  base?: string;
  after?: string;
  gate?: string;
  seconds?: number;
  passed?: boolean;
  handoffAt?: string;
  reason?: string;
  lock?: string;
}

/** The journal includes admission waits; gate budgets start only in the existing gate runners. */
export function trainEvent(directory: string, event: Omit<TrainEvent, 'at'>): void {
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, 'train-events.jsonl'), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
}

function updateTrain<T>(directory: string, token: string, work: (train: Train) => T): T {
  const path = join(directory, 'train.json');
  const train = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Train : { entries: [] };
  const result = work(train);
  writeFileSync(`${path}.${token}.tmp`, `${JSON.stringify(train)}\n`);
  renameSync(`${path}.${token}.tmp`, path);
  return result;
}

/** Captures run under the ledger lock. Train callbacks never acquire that lock or await work. */
function reserved<T>(directory: string, id: string, work: (train: Train) => T): T {
  mkdirSync(directory, { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  let waited = false;
  let lease;
  while ((lease = tryAcquireDirectoryLease(join(directory, 'train.lock'))) === 'held') {
    if (!waited) trainEvent(directory, { event: 'lock-wait-start', id, token, lock: 'train' });
    waited = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (waited) trainEvent(directory, { event: 'lock-wait-end', id, token, lock: 'train', seconds: (Date.now() - started) / 1000 });
  try { return updateTrain(directory, token, work); }
  finally { lease.release(); }
}

export function reserveMergeTrain(directory: string, id: string, handoffAt: string): void {
  reserved(directory, id, train => {
    if (train.entries.some(entry => entry.id === id)) return;
    const token = randomUUID();
    train.entries.push({ id, token, queuedAt: handoffAt, handoffAt, revision: 0, advance: true });
    trainEvent(directory, { event: 'queued', id, token, handoffAt, position: train.entries.length });
  });
}

export function cancelTrainReservation(directory: string, id: string): void {
  reserved(directory, id, train => {
    const entry = train.entries.find(entry => entry.id === id && !entry.owner);
    if (entry) remove(train, entry.token, directory, 'snapshot failed', true);
  });
}

async function locked<T>(directory: string, id: string, token: string, work: (train: Train) => T): Promise<T> {
  mkdirSync(directory, { recursive: true });
  const started = Date.now();
  let waited = false;
  let lease;
  while ((lease = tryAcquireDirectoryLease(join(directory, 'train.lock'))) === 'held') {
    if (!waited) trainEvent(directory, { event: 'lock-wait-start', id, token, lock: 'train' });
    waited = true;
    await Bun.sleep(25);
  }
  if (waited) trainEvent(directory, { event: 'lock-wait-end', id, token, lock: 'train', seconds: (Date.now() - started) / 1000 });
  try {
    return updateTrain(directory, token, work);
  } finally { lease.release(); }
}

function remove(train: Train, token: string, directory: string, reason: string, invalidate: boolean): void {
  const index = train.entries.findIndex(entry => entry.token === token);
  if (index < 0) return;
  const [removed] = train.entries.splice(index, 1);
  trainEvent(directory, { event: 'removed', id: removed!.id, token, reason, position: index + 1 });
  if (!invalidate) return;
  for (const entry of train.entries.slice(index)) {
    entry.revision++;
    delete entry.base;
    delete entry.after;
    trainEvent(directory, { event: 'invalidated', id: entry.id, token: entry.token, revision: entry.revision, reason });
  }
}

export interface TrainOptions<P extends { after: string }> {
  directory: string;
  id: string;
  handoffAt?: string;
  advance?: boolean;
  head(): string;
  prepare(base: string): Promise<P | undefined>;
  gate(prepared: P, context: TrainContext): Promise<string | undefined>;
  /** Called only at the front, or to record a failed gate. Must refuse unexpected main movement. */
  finish(prepared: P, failure?: string): Promise<void>;
}
export interface TrainContext { token: string; revision: number; position: number }

/** Each caller owns its worktree and gates. The durable queue only orders candidates and main advances.
 * Preparing/gating never holds the train lock or a ledger lock. A dead owner is removed by any waiter.
 * https://docs.gitlab.com/ci/pipelines/merge_trains/ describes the cumulative-tree invariant. */
export async function runMergeTrain<P extends { after: string }>(options: TrainOptions<P>): Promise<void> {
  const { directory, id } = options;
  let token: string = randomUUID();
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error('Cannot identify merge train owner');
  await locked(directory, id, token, train => {
    const reservation = train.entries.find(entry => entry.id === id && !entry.owner);
    if (reservation) {
      token = reservation.token;
      reservation.owner = identity;
      return;
    }
    const entry: Entry = { token, id, owner: identity, queuedAt: new Date().toISOString(),
      handoffAt: options.handoffAt, revision: 0, advance: options.advance !== false };
    train.entries.push(entry);
    trainEvent(directory, { event: 'queued', id, token, position: train.entries.length, handoffAt: options.handoffAt });
  });
  let revision = -1;
  let prepared: P | undefined;
  let passedSeconds = 0;
  let recordedLanding = false;
  try {
    for (;;) {
      const next = await locked(directory, id, token, train => {
        for (const entry of [...train.entries]) if (entry.owner && !processAlive(entry.owner)) {
          const landed = entry.advance && entry.after === options.head();
          if (landed) trainEvent(directory, { event: 'landed', id: entry.id, token: entry.token,
            after: entry.after, handoffAt: entry.handoffAt, reason: 'recovered after owner exited' });
          remove(train, entry.token, directory, landed ? 'already landed' : 'owner exited', !landed);
        }
        const index = train.entries.findIndex(entry => entry.token === token);
        const entry = train.entries[index];
        if (!entry) throw new Error(`${id} left the merge train`);
        const predecessor = train.entries[index - 1];
        const base = predecessor ? predecessor.after : options.head();
        // A gate-only entry has no landing tree, so successors wait for it to leave.
        if (!base || (predecessor && !predecessor.advance)) return undefined;
        if (entry.base && entry.base !== base) {
          entry.revision++;
          delete entry.after;
          delete entry.base;
          for (const successor of train.entries.slice(index + 1)) {
            successor.revision++;
            delete successor.base;
            delete successor.after;
          }
        }
        entry.base = base;
        return { base, revision: entry.revision, position: index + 1 };
      });
      if (!next) { await Bun.sleep(50); continue; }
      if (revision !== next.revision) {
        if (prepared) trainEvent(directory, { event: 'discarded', id, token, revision,
          seconds: passedSeconds, reason: 'predecessor removed or main changed' });
        prepared = undefined;
        revision = next.revision;
        passedSeconds = 0;
        const candidate = await options.prepare(next.base);
        if (!candidate) return;
        prepared = candidate;
        const published = await locked(directory, id, token, train => {
          const entry = train.entries.find(item => item.token === token)!;
          if (entry.revision !== revision) return false;
          entry.after = candidate.after;
          trainEvent(directory, { event: 'prepared', id, token, ...next, after: candidate.after });
          return true;
        });
        if (!published) continue;
        const started = Date.now();
        trainEvent(directory, { event: 'gate-start', id, token, ...next, after: candidate.after });
        let failure: string | undefined;
        try { failure = await options.gate(candidate, { token, revision, position: next.position }); }
        catch (error) {
          trainEvent(directory, { event: 'gate-end', id, token, revision, position: next.position, passed: false,
            seconds: (Date.now() - started) / 1000, reason: String(error) });
          throw error;
        }
        const seconds = (Date.now() - started) / 1000;
        trainEvent(directory, { event: 'gate-end', id, token, revision, position: next.position, passed: !failure, seconds });
        if (!failure) passedSeconds = seconds;
        const valid = await locked(directory, id, token, train =>
          train.entries.find(entry => entry.token === token)?.revision === revision);
        if (!valid) continue;
        if (failure) {
          // A caller may recover a landing another process already made despite this stale failure.
          await options.finish(candidate, failure);
          await locked(directory, id, token, train => remove(train, token, directory, 'recovered landing', false));
          return;
        }
      }
      if (next.position !== 1) { await Bun.sleep(50); continue; }
      // No entry ahead can now be removed. Enqueues behind us cannot change this candidate.
      await options.finish(prepared!);
      trainEvent(directory, { event: options.advance === false ? 'gate-passed' : 'landed', id, token,
        revision, after: prepared!.after, position: 1, handoffAt: options.handoffAt });
      recordedLanding = true;
      await locked(directory, id, token, train => remove(train, token, directory, 'landed', options.advance === false));
      return;
    }
  } finally {
    await locked(directory, id, token, train => {
      if (!train.entries.some(entry => entry.token === token)) return;
      // Git may advance before post-merge bookkeeping throws. That tree is still the
      // predecessor every successor gated; removing it must preserve their green work.
      const landed = options.advance !== false && prepared && options.head() === prepared.after;
      if (landed && prepared && !recordedLanding) trainEvent(directory, { event: 'landed', id, token,
        revision, after: prepared.after, handoffAt: options.handoffAt, reason: 'recovered after main advanced' });
      else if (!landed && passedSeconds) trainEvent(directory, { event: 'discarded', id, token,
        revision, seconds: passedSeconds, reason: 'entry stopped after its gate passed' });
      remove(train, token, directory, landed ? 'already landed' : 'entry stopped', !landed);
    });
  }
}

export function trainMetrics(directory: string): { landings: number; discardedGateSeconds: number; p95HandoffToMainSeconds: number | null } {
  const path = join(directory, 'train-events.jsonl');
  const events = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as TrainEvent) : [];
  const landed = [...new Map(events.filter(event => event.event === 'landed').map(event => [event.token, event])).values()];
  const latencies = landed.flatMap(event => event.handoffAt && Number.isFinite(Date.parse(event.handoffAt))
    ? [(Date.parse(event.at) - Date.parse(event.handoffAt)) / 1000] : []).sort((a, b) => a - b);
  return { landings: landed.length,
    discardedGateSeconds: events.filter(event => event.event === 'discarded').reduce((sum, event) => sum + (event.seconds ?? 0), 0),
    p95HandoffToMainSeconds: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null };
}
