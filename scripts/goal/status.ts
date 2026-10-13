import { printScopeProgress } from '../qa/cases/outcomes.ts';
import { withLedger, activeGoals, root, managerOf, stateDir } from './ledger.ts';
import { running, lastAttempt, elapsed, transportContinuations, transportDrop } from './launch.ts';
import { clearRefusal } from './merge.ts';
import { currentUsage, codexAccounts, describeAccount } from './usage.ts';
import { heavyQaStatus, heavyQaWaiters, sharedLifecycleStatus, sharedLifecycleWaiters, qaWaitStatusLines, gateLaneStatus, gateLaneWaiters } from './qa-slots.ts';
import { goalMeasures } from './measures.ts';
import { inboxEntries } from './regress.ts';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { validGoalSlug } from './briefs.ts';
import { MAX_TRANSPORT_CONTINUATIONS, engineOf } from './types.ts';
import { settlementReason } from './settle.ts';
import { termspacesSession, termspacesTarget, windowTurns, workerWindowName, turnWindowName } from './windows.ts';
import { listQueue, type QueueLedger } from './queue.ts';

export async function status(): Promise<void> {
  await printScopeProgress();
  const ledger = await withLedger(current => {
    for (const task of Object.values(current.tasks)) {
      if (task.state === 'running' && !running(task)) {
        task.state = 'exited';
        clearRefusal(task);
        lastAttempt(task).endedAt ??= new Date().toISOString();
      }
    }
    return current;
  });
  const tasks = Object.values(ledger.tasks);
  const usage = currentUsage();
  const live = tasks.filter(task => task.state === 'starting' || running(task));
  console.log(termspacesSession()
    ? `Goal windows: ${termspacesTarget().session} on ${termspacesTarget().socket}`
    : `Goal windows unavailable: termspaces session ${termspacesTarget().session} missing on ${termspacesTarget().socket}; workers run unwatched, manager turns wait`);
  for (const turn of windowTurns(stateDir).filter(turn=>turn.phase !== 'done')) {
    console.log(`Goal ${turn.goal}: turn ${turn.n} ${turn.phase}; window ${turnWindowName(turn)}`);
  }
  console.log(`program elapsed ${ledger.startedAt ? elapsed(ledger.startedAt) : 'not started'}; `
    + `live ${live.length}/${process.env.GOAL_MAX_WORKERS ?? 25}; `
    + `Claude 5h ${usage.used ?? '?'}% ${usage.level}`
    + (usage.projected !== undefined ? `, projected ${usage.projected}% at reset in ${usage.resetInMinutes}m` : '')
    + (usage.ageSeconds !== undefined ? ` (${usage.ageSeconds}s old)` : ''));
  if (usage.weekUsed !== undefined) {
    console.log(`Claude 7d ${usage.weekUsed}%, projected ${usage.weekProjected}–${usage.weekProjectedHigh}% at reset in ${usage.weekResetInHours}h: `
      + `${usage.weekAdvice}`);
  }
  for (const account of codexAccounts()) console.log(describeAccount(account));
  console.log(`heavy QA: ${heavyQaStatus()}`);
  for (const waiting of heavyQaWaiters()) console.log(waiting);
  console.log(`shared lifecycle: ${sharedLifecycleStatus()}`);
  for (const waiting of sharedLifecycleWaiters()) console.log(waiting);
  for (const waiting of qaWaitStatusLines()) console.log(waiting);
  console.log(`gate lanes: ${gateLaneStatus()}`);
  for (const waiting of gateLaneWaiters()) console.log(waiting);
  const active = activeGoals(ledger);
  await goalMeasures(ledger, { root, print: line => console.log(line) });
  for (const slug of active) {
    const own = tasks.filter(task => task.goal === slug);
    console.log(`Goal ${slug}: manager ${managerOf(ledger, slug)}; ${own.filter(task => task.state === 'starting' || running(task)).length} live, `
      + `${own.filter(task => !['verified', 'cancelled'].includes(task.state)).length} open; `
      + `${inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length} unacknowledged regressions`);
  }
  const inboxDirectory = join(stateDir, 'inbox');
  for (const file of existsSync(inboxDirectory) ? readdirSync(inboxDirectory).sort() : []) {
    if (!file.endsWith('.jsonl')) continue;
    const slug = file.slice(0, -6);
    if (!validGoalSlug(slug) || active.includes(slug)) continue;
    const count = inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length;
    if (count) console.log(`Goal ${slug}: inactive; ${count} unacknowledged regressions`);
  }
  for (const task of tasks.filter(t => !['verified', 'cancelled'].includes(t.state))) {
    if (task.state === 'starting') {
      console.log(`${task.id} starting ${task.goal ?? '-'} ${task.engine}/${task.effort} preparing worktree [${task.cases.join(' ')}] ${task.title}`);
      continue;
    }
    const attempt = lastAttempt(task);
    const continuations = transportContinuations(task);
    const repeated = task.state === 'exited' && transportDrop(attempt) && continuations >= MAX_TRANSPORT_CONTINUATIONS;
    console.log(`${task.id} ${task.state.padEnd(8)} ${task.goal ?? '-'} ${engineOf(attempt)}/${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`
      + (running(task) ? `; window ${workerWindowName(task)}` : '')
      + (running(task) && continuations > 0 ? `; continued by itself ${continuations}` : '')
      + (repeated ? '\n  stopped after repeated transport errors' : '')
      + (settlementReason(task) ? `\n  ${settlementReason(task)}` : '')
      + (task.state === 'conflict' && task.refusal ? `\n  ${task.refusal}` : ''));
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
  if (Object.keys((ledger as QueueLedger).queue ?? {}).length) await listQueue();
}
