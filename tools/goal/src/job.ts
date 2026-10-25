import { watch, type FSWatcher } from 'node:fs';
import type { GateOutcome, GateOutcomeSink, LandingQueue, ManagerInbox, AttemptRef } from './contracts.ts';
import { waitForProcess } from './process.ts';
import { StaleAttemptError } from './contracts.ts';
import { classifyFailure } from './failures.ts';
import { evidenceBundle } from './evidence.ts';
import { consult } from './consult.ts';
import { readMeasurement } from './records.ts';
import { readRouting } from './routing.ts';
import { settle } from './settle.ts';
import { git, HeldTaskConflictError, type WorkerTasks, type RetryOptions } from './tasks.ts';
import type { ManagerEventKind } from './contracts.ts';
import type { RunningWorker } from './launch.ts';

function rebaseConflictFiles(outcome: GateOutcome): string[] {
  const files = new Set(outcome.conflictedFiles ?? []);
  const details = `${outcome.firstFailure?.assertion ?? ''}\n${outcome.firstFailure?.excerpt ?? ''}`;
  for (const line of details.split(/\r?\n/)) {
    const conflict = line.match(/\bCONFLICT \([^)]+\):\s*(?:Merge conflict in\s+)?(.+)$/);
    if (!conflict) continue;
    const file = conflict[1]!.replace(/\s+(?:deleted|added|modified) in\b.*$/, '').trim();
    if (file) files.add(file);
  }
  if (!files.size) for (const file of outcome.changedFiles) files.add(file);
  return [...files];
}

export class WorkerJob implements GateOutcomeSink {
  private readonly pending = new Set<Promise<void>>();
  constructor(readonly tasks: WorkerTasks, readonly landing: LandingQueue, readonly inbox: ManagerInbox,
    readonly consultation: typeof consult = consult, readonly afterSettle: () => Promise<void> = async () => {}) {}
  private track(work: Promise<void>): void {
    const handled = work.catch(error => { if (!(error instanceof StaleAttemptError)) throw error; });
    this.pending.add(handled);
    // Observe errors immediately while retaining them for drain().
    void handled.catch(() => {});
  }
  async drain(): Promise<void> {
    while (this.pending.size) {
      const batch = [...this.pending];
      await Promise.all(batch);
      for (const item of batch) this.pending.delete(item);
    }
  }
  async start(taskId: string, options: RetryOptions = {}): Promise<void> {
    const worker = await this.tasks.retry(taskId, options);
    await this.follow(worker);
  }
  private async startReleased(taskId: string): Promise<void> {
    try { await this.follow(await this.tasks.retryHeld(taskId)); }
    catch (error) {
      if (!(error instanceof HeldTaskConflictError)) throw error;
      const task = this.tasks.store.task(taskId), ref = { taskId, attempt: 0 };
      const event = { managerId: task.brief.manager, taskId, kind: 'spec-conflict' as const,
        summary: `spec-conflict: refusing to release task because ${error.detail}` };
      this.tasks.store.updateTask(ref, current => { current.state = 'stopped'; });
      this.tasks.store.event(ref, 'manager-event', event);
      this.inbox.deliver(event);
    }
  }
  private hasCommit(ref: AttemptRef): boolean {
    const task = this.tasks.store.task(ref.taskId);
    return Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`])) > 0;
  }
  async follow(worker: Pick<RunningWorker, 'attempt' | 'exited'>): Promise<void> {
    const ref = worker.attempt, store = this.tasks.store;
    const task = store.task(ref.taskId);
    const limits = readRouting(this.tasks.settings.routingFile).classes[task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>];
    let watcher: FSWatcher | undefined;
    let stopping: Promise<void> | undefined;
    const stopIfStalled = (timeLimit: boolean) => {
      try {
        store.assertCurrent(ref);
        const attempt = store.attempt(ref);
        const pool = this.tasks.settings.pools.find(candidate => candidate.name === attempt.pool);
        const measurement = readMeasurement(attempt, { configDirectory: pool?.configDirectory });
        const steps = Object.values(measurement.steps).reduce((a, b) => a + b, 0);
        if ((timeLimit || steps > limits.maxSteps) && !this.hasCommit(ref) && !stopping) {
          const evidencePath = evidenceBundle(task, store.attempt(ref));
          const event = { managerId: task.brief.manager, taskId: task.id, kind: 'stalled' as const, summary: 'Worker exceeded its class limit without a commit', evidencePath };
          store.updateAttempt(ref, a => { a.escalation = 'stalled'; });
          store.event(ref, 'manager-event', event);
          this.inbox.deliver(event);
          stopping = this.tasks.stop(task.id);
          void stopping.catch(() => {});
        }
      } catch (error) { if (!(error instanceof StaleAttemptError)) { stopping = Promise.reject(error); void stopping.catch(() => {}); } }
    };
    const timer = setTimeout(() => stopIfStalled(true), Math.max(0, limits.maxMs - (Date.now() - Date.parse(ref.startedAt))));
    try {
      watcher = watch(ref.logPath, () => stopIfStalled(false));
      try { await settle(this.tasks, worker, this.landing, async () => {
        clearTimeout(timer); watcher?.close(); await this.afterSettle();
      }); }
      catch (error) { if (!stopping || !(error instanceof StaleAttemptError)) throw error; }
      if (stopping) await stopping;
    } finally { clearTimeout(timer); watcher?.close(); }
    if (!stopping) {
      const fact = store.attempt(ref).failureKind;
      if (fact) this.onAttemptExit(ref);
    }
  }
  /** Launch/exit facts do not fabricate a gate outcome. */
  onAttemptExit(ref: AttemptRef): void {
    const store = this.tasks.store;
    let retry: RetryOptions | undefined;
    store.write(ref, () => {
      const task = store.task(ref.taskId), attempt = store.attempt(ref), kind = attempt.failureKind;
      if (!kind) return;
      if (store.events(task.id).some(event => event.attempt === ref.attempt && event.kind === 'attempt-exit-classified')) return;
      const failureClass = kind === 'tool' ? 'environment' : kind;
      const record = store.record(ref)!;
      record.outcome = 'stopped'; record.escalation = failureClass; store.putRecord(record);
      store.event(ref, 'attempt-exit-classified', { kind: failureClass, detail: attempt.blocker ?? attempt.result });
      store.updateAttempt(ref, a => { a.escalation = failureClass; });
      const evidencePath = evidenceBundle(task, store.attempt(ref));
      if (kind === 'spec-conflict' || kind === 'scope-growth') {
        store.updateTask(ref, t => { t.state = 'stopped'; });
        const event = { managerId: task.brief.manager, taskId: task.id, kind,
          summary: `${kind}: ${attempt.blocker ?? attempt.result}`.replace(/[\r\n]+/g, ' '), evidencePath };
        store.event(ref, 'manager-event', event); this.inbox.deliver(event);
      } else {
        const previous = ref.attempt > 1 ? store.attempt({ taskId: ref.taskId, attempt: ref.attempt - 1 }) : null;
        if (kind === 'tool' && previous?.failureKind === 'tool') {
          const firstLine = (previous.result || previous.blocker || 'Worker CLI failed before starting a session').split(/\r?\n/, 1)[0]!;
          store.updateTask(ref, t => { t.state = 'stopped'; });
          store.updateAttempt(ref, a => { a.escalation = 'stalled'; });
          record.escalation = 'stalled'; store.putRecord(record);
          const event = { managerId: task.brief.manager, taskId: task.id, kind: 'stalled' as const,
            summary: `Repeated launch failure: ${firstLine}`.replace(/[\r\n]+/g, ' '), evidencePath };
          store.event(ref, 'manager-event', event); this.inbox.deliver(event);
          return;
        }
        retry = { evidence: evidencePath, escalation: failureClass, fixRound: attempt.fixRound };
        if (kind === 'pool-exhausted') {
          const key = this.tasks.settings.pools.find(pool => pool.name === attempt.pool)?.allowanceKey;
          retry.excludePools = this.tasks.settings.pools.filter(pool => pool.allowanceKey === key).map(pool => pool.name);
        }
      }
    });
    if (retry) this.track(this.start(ref.taskId, retry));
  }
  onGateOutcome(outcome: GateOutcome): void {
    const store = this.tasks.store;
    // Stale gate results must be refused to their caller, not silently discarded.
    store.assertCurrent(outcome);
    const task = store.task(outcome.taskId), attempt = store.attempt(outcome);
    const record = store.record(outcome);
    if (!record) throw new Error('attempt must be settled before gate outcomes');
    let action: (() => Promise<void>) | undefined;
    let released: string[] = [];
    store.write(outcome, () => {
      const duplicate = store.events(task.id).some(e => e.attempt === outcome.attempt && e.kind === 'gate-outcome' && JSON.parse(e.body).stage === outcome.stage);
      if (duplicate) return;
      store.event(outcome, 'gate-outcome', outcome);
      record.diffLines = outcome.diffLines; record.changedFiles = [...outcome.changedFiles]; record.hostMs = (record.hostMs ?? 0) + outcome.hostMs;
      record.firstFailure = outcome.firstFailure?.fingerprint ?? null; record.outcome = outcome.passed ? 'passed' : 'gate-failed';
      if (outcome.passed) {
        if (outcome.mergedCommit) {
          store.updateTask(outcome, t => { t.state = 'merged'; t.mergedCommit = outcome.mergedCommit!; });
          const tasks = store.tasks(), byId = new Map(tasks.map(candidate => [candidate.id, candidate]));
          released = tasks.filter(candidate => candidate.state === 'held'
            && (candidate.brief.after ?? []).every(id => byId.get(id)?.state === 'merged')).map(candidate => candidate.id);
          for (const taskId of released) store.updateTask({ taskId, attempt: 0 }, candidate => { candidate.state = 'ready'; });
          const goalTasks = store.tasks().filter(candidate => candidate.brief.goal === task.brief.goal);
          const goalInFlight = goalTasks.some(candidate => ['ready', 'running', 'landing', 'held'].includes(candidate.state));
          const goalHasDependencies = goalTasks.some(candidate => (candidate.brief.after ?? []).length > 0);
          if (goalHasDependencies && !goalInFlight) {
            const event = { managerId: task.brief.manager, taskId: task.id, kind: 'goal-idle' as const,
              summary: `Goal ${task.brief.goal} has no tasks in flight.` };
            store.event(outcome, 'goal-idle', event);
            this.inbox.deliver(event);
          }
        }
        store.putRecord(record); return;
      }
      if (outcome.stage === 'rebase') {
        store.updateAttempt(outcome, a => {
          a.failure = outcome.firstFailure ?? null;
          a.approaches.push({ approach: `Attempt ${a.attempt}: ${a.profile.model}/${a.profile.effort}`,
            result: outcome.firstFailure ? `${outcome.firstFailure.assertion}: ${outcome.firstFailure.excerpt}` : 'Failed at rebase' });
        });
        const evidencePath = evidenceBundle(task, store.attempt(outcome));
        const files = rebaseConflictFiles(outcome);
        if (attempt.escalation === 'rebase-conflict') {
          record.escalation = 'spec-conflict';
          store.updateAttempt(outcome, a => { a.escalation = 'spec-conflict'; });
          store.updateTask(outcome, t => { t.state = 'stopped'; });
          const detail = files.length ? `conflicted files: ${files.join(', ')}` : outcome.firstFailure?.assertion ?? 'conflict with current main';
          const event = { managerId: task.brief.manager, taskId: task.id, kind: 'spec-conflict' as const,
            summary: `spec-conflict: repeated rebase conflict; ${detail}`.replace(/[\r\n]+/g, ' '), evidencePath };
          store.event(outcome, 'manager-event', event); this.inbox.deliver(event);
        } else {
          record.escalation = 'rebase-conflict';
          store.updateAttempt(outcome, a => { a.escalation = 'rebase-conflict'; });
          const options: RetryOptions = { evidence: evidencePath, escalation: 'rebase-conflict',
            fixRound: attempt.fixRound, conflictFiles: files };
          action = async () => { store.assertCurrent(outcome); await this.start(task.id, options); };
        }
        store.putRecord(record);
        return;
      }
      const limits = readRouting(this.tasks.settings.routingFile).classes[task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>];
      const failureClass = classifyFailure(outcome, task, attempt, record, limits, this.hasCommit(outcome));
      record.escalation = failureClass; record.earlyStop = !attempt.blocker || /RESULT:\s*success/i.test(attempt.result);
      store.updateAttempt(outcome, a => {
        a.failure = outcome.firstFailure ?? null; a.escalation = failureClass;
        a.approaches.push({ approach: `Attempt ${a.attempt}: ${a.profile.model}/${a.profile.effort}`,
          result: outcome.firstFailure ? `${outcome.firstFailure.assertion}: ${outcome.firstFailure.excerpt}` : `Failed at ${outcome.stage}` });
      });
      const evidencePath = evidenceBundle(task, store.attempt(outcome));
      const automatic = ['environment', 'pool-exhausted', 'repeated-assertion', 'new-failure', 'early-stop'].includes(failureClass);
      if (!automatic) {
        store.updateTask(outcome, t => { t.state = 'stopped'; });
        const event = { managerId: task.brief.manager, taskId: task.id, kind: failureClass as ManagerEventKind,
          summary: `${failureClass}: ${outcome.firstFailure?.assertion ?? outcome.stage}`.replace(/[\r\n]+/g, ' '), evidencePath };
        store.event(outcome, 'manager-event', event); this.inbox.deliver(event);
      } else {
        const previous = outcome.attempt > 1 ? store.attempt({ taskId: task.id, attempt: outcome.attempt - 1 }) : null;
        const previousRecord = previous ? store.record({ taskId: task.id, attempt: previous.attempt }) : null;
        if (failureClass === 'environment' && outcome.firstFailure?.fingerprint
          && previous?.escalation === 'environment' && previousRecord?.firstFailure === outcome.firstFailure.fingerprint) {
          record.escalation = 'stalled'; store.putRecord(record);
          store.updateTask(outcome, t => { t.state = 'stopped'; });
          store.updateAttempt(outcome, a => { a.escalation = 'stalled'; });
          const event = { managerId: task.brief.manager, taskId: task.id, kind: 'stalled' as const,
            summary: `Repeated environment failure: ${outcome.firstFailure.assertion}`.replace(/[\r\n]+/g, ' '), evidencePath };
          store.event(outcome, 'manager-event', event); this.inbox.deliver(event);
          return;
        }
        const options: RetryOptions = { evidence: evidencePath, escalation: failureClass,
          fixRound: attempt.fixRound + (['environment', 'pool-exhausted'].includes(failureClass) ? 0 : 1) };
        if (failureClass === 'pool-exhausted') {
          const key = this.tasks.settings.pools.find(p => p.name === attempt.pool)?.allowanceKey;
          options.excludePools = this.tasks.settings.pools.filter(p => p.allowanceKey === key).map(p => p.name);
        }
        action = async () => {
          store.assertCurrent(outcome);
          if (failureClass === 'repeated-assertion') {
            try {
              options.consultation = await this.consultation(this.tasks, outcome, evidencePath);
              options.consulted = true; record.consulted = true; store.putRecord(record);
            } catch (error) {
              store.assertCurrent(outcome);
              // A failed consultation transport is a tool event, so it does not wake a manager.
              store.event(outcome, 'consultation-unavailable', { error: String(error) });
              options.escalation = 'environment'; options.fixRound = attempt.fixRound;
              options.consulted = store.attempt(outcome).consulted;
            }
          }
          await this.start(task.id, options);
        };
      }
      store.putRecord(record);
    });
    for (const taskId of released) this.track(this.startReleased(taskId));
    if (action) this.track(action());
  }
  /** Reattach to a persisted running attempt after a controller restart using a kernel exit notification. */
  async recover(taskId: string): Promise<void> {
    const task = this.tasks.store.task(taskId);
    const ref = { taskId, attempt: task.currentAttempt };
    this.tasks.store.assertCurrent(ref);
    if (this.tasks.store.events(taskId).some(event => event.attempt === ref.attempt && event.kind === 'landing-requested')) { await this.afterSettle(); return; }
    const attempt = this.tasks.store.attempt(ref);
    if (!['running', 'exited'].includes(attempt.state)) throw new Error('only a running or exited attempt can be recovered');
    const exited = attempt.process ? waitForProcess(attempt.process).then(() => ({ code: null, signal: null }))
      : Promise.resolve({ code: null, signal: null });
    await this.follow({ attempt, exited });
  }
  async consultTask(taskId: string): Promise<void> {
    const task = this.tasks.store.task(taskId), ref = { taskId, attempt: task.currentAttempt };
    this.tasks.store.assertCurrent(ref);
    const path = evidenceBundle(task, this.tasks.store.attempt(ref));
    const answer = await this.consultation(this.tasks, ref, path);
    await this.start(taskId, { evidence: path, consultation: answer, consulted: true, escalation: 'consultation' });
  }
}
