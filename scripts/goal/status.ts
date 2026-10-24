import { printScopeProgress } from '../qa/cases/outcomes.ts';
import { withLedger, activeGoals, root, managerOf, stateDir } from './ledger.ts';
import { running, lastAttempt, elapsed, transportContinuations, transportDrop, readResult, hasHandoff } from './launch.ts';
import { clearRefusal } from './merge.ts';
import { currentUsage, codexAccounts, describeAccount } from './usage.ts';
import { heavyQaStatus, heavyQaWaiters, sharedLifecycleStatus, sharedLifecycleWaiters, qaWaitStatusLines, gateLaneStatus, gateLaneWaiters } from './qa-slots.ts';
import { goalMeasures } from './measures.ts';
import { inboxEntries } from './regress.ts';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { validGoalSlug } from './briefs.ts';
import { MAX_TRANSPORT_CONTINUATIONS, engineOf, isCodex } from './types.ts';
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
    + `waiting ${tasks.filter(task => task.waitingResume).length}; `
    + `Claude 5h ${usage.used ?? '?'}% ${usage.level}`
    + (usage.projected !== undefined ? `, projected ${usage.projected}% at reset in ${usage.resetInMinutes}m` : '')
    + (usage.ageSeconds !== undefined ? ` (${usage.ageSeconds}s old)` : ''));
  if (usage.weekUsed !== undefined) {
    console.log(`Claude 7d ${usage.weekUsed}%`);
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
    const reason = settlementReason(task);
    const missingHandoff = task.state === 'exited' && !task.waitingResume && !reason
      && ((isCodex(engineOf(attempt)) && (!attempt.lastMessage || !existsSync(attempt.lastMessage)))
        || !hasHandoff(readResult(attempt).text));
    console.log(`${task.id} ${(task.waitingResume ? 'waiting' : task.state).padEnd(8)} ${task.goal ?? '-'} ${engineOf(attempt)}/${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`
      + (running(task) ? `; window ${workerWindowName(task)}` : '')
      + (running(task) && continuations > 0 ? `; continued by itself ${continuations}` : '')
      + (repeated ? '\n  stopped after repeated transport errors' : '')
      + (task.waitingResume ? `\n  resume waiting: ${task.waitingResume.reason}`
        : reason ? `\n  ${reason}` : missingHandoff
          ? `\n  attempt ended without a handoff ${elapsed(attempt.endedAt ?? attempt.startedAt)} ago; resume ${task.id} --fresh -m <text>, or add --engine <engine> to move it` : '')
      + (task.state === 'conflict' && task.refusal ? `\n  ${task.refusal}` : ''));
  }
  const caller = process.env.GOAL_ID;
  const exitedGoals = [...new Set(tasks.filter(task => task.state === 'exited').map(task => task.goal))];
  const free = Math.max(0, Number(process.env.GOAL_MAX_WORKERS ?? 25) - live.length);
  for (const slug of exitedGoals.filter(slug => !caller || caller === 'program' || slug === caller)) {
    const exited = tasks.filter(task => task.state === 'exited' && task.goal === slug)
      .sort((a, b) => Date.parse(lastAttempt(a).endedAt ?? lastAttempt(a).startedAt)
        - Date.parse(lastAttempt(b).endedAt ?? lastAttempt(b).startedAt) || a.id.localeCompare(b.id));
    console.log(`Goal ${slug ?? '-'}: ${exited.length} exited; longest exited: ${exited.slice(0, 3)
      .map(task => `${task.id} ${elapsed(lastAttempt(task).endedAt ?? lastAttempt(task).startedAt)}`).join(', ')}; ${free} live worker places free`);
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
  if (Object.keys((ledger as QueueLedger).queue ?? {}).length) await listQueue();
}
