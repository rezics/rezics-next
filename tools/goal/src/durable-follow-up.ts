import { createHash } from 'node:crypto';
import type { WorkerStore } from './store.ts';
import type { PendingBriefProposal, Task } from './types.ts';

function normalizedBriefText(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trimEnd();
}

export function briefProposalHash(markdown: string): string {
  return createHash('sha256').update(normalizedBriefText(markdown)).digest('hex');
}

export function sameBriefProposalText(left: string, right: string): boolean {
  return normalizedBriefText(left) === normalizedBriefText(right);
}

/** A proposal still replaces the brief it was recorded against; a later replacement on the task supersedes it. */
export function proposalAppliesToCurrentAttempt(proposal: PendingBriefProposal, task: Task): boolean {
  const current = briefProposalHash(task.brief.markdown);
  return current === proposal.previousBriefHash && current !== proposal.newBriefHash;
}

/** Persist a replacement brief so an automatic retry can consume it even if this command loses the task lease. */
export function recordReplacementBrief(
  store: WorkerStore,
  task: Task,
  markdown: string,
  writtenForAttempt: number,
): PendingBriefProposal | undefined {
  if (sameBriefProposalText(markdown, task.brief.markdown)) return undefined;
  const newBriefHash = briefProposalHash(markdown);
  const newest = store.newestPendingBriefProposal(task.id);
  if (newest?.newBriefHash === newBriefHash) return newest;
  return store.saveBriefProposal({
    taskId: task.id,
    writtenForAttempt,
    previousBriefHash: briefProposalHash(task.brief.markdown),
    newBriefHash,
    markdown,
    createdAt: new Date().toISOString(),
  });
}

/** Take the pending set and return the newest proposal that still applies to this task. */
export function consumeApplicableBriefProposal(store: WorkerStore, task: Task): PendingBriefProposal | undefined {
  const pending = store.takePendingBriefProposals(task.id);
  const newest = pending.at(-1);
  if (!newest || !proposalAppliesToCurrentAttempt(newest, task)) return undefined;
  return newest;
}
