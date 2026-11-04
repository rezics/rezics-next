import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { AttemptRef } from './contracts.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { WorkerEvent, WorkerStore } from './store.ts';
import type { Task } from './types.ts';

const DECISION_EVENT = 'owner-contract-decision-accepted';
const DELIVERY_EVENT = 'owner-contract-decision-delivery';
export const MAX_WORKER_PROMPT_CHARACTERS = defaultPolicy.workerPrompt.characters;

type DocumentReference = { path: string; change?: string };
type OwnerDecision = {
  id: string;
  managerId: string;
  senderSessionId: string;
  decidedAt: number;
  sequence: number;
  summary: string;
  documentRefs: DocumentReference[];
};

export type OwnerDecisionDelivery = {
  decisionId: string;
  decisionSequence: number;
  summaryDelivered: boolean;
  documentRefs: { path: string; status: 'delivered' | 'pending' }[];
};

export type PreparedOwnerDecisionPrompt = {
  prompt: string;
  delivery?: OwnerDecisionDelivery;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableId(decisionId: string, managerId: string): string {
  const id = `${managerId}:${decisionId}`;
  return id.length <= 128
    ? id
    : createHash('sha256')
        .update(JSON.stringify([managerId, decisionId]))
        .digest('hex');
}

function safeDocumentReference(value: unknown, policy: ControlPolicy): DocumentReference | undefined {
  const item = record(value);
  if (!item || typeof item.path !== 'string') return undefined;
  const path = item.path.trim();
  if (
    !path ||
    Buffer.byteLength(path) > policy.brief.bytes ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    return undefined;
  return {
    path,
    ...(typeof item.change === 'string' && item.change.trim()
      ? { change: item.change.trim().slice(0, policy.inbox.managerMessageCharacters) }
      : {}),
  };
}

/** Only this command ingress promotes caller data to a persisted owner decision. */
export function submitOwnerDecision(store: WorkerStore, ref: AttemptRef, input: unknown, env: NodeJS.ProcessEnv): void {
  const policy = store.policy;
  store.write(ref, () => {
    const actor = authenticatedManager(store.db, env);
    const task = store.task(ref.taskId);
    if (!actor || actor.id !== task.brief.manager)
      throw new Error('owner decisions require the authenticated owning manager session');
    if (ref.attempt < 1) throw new Error('owner decisions require a current worker attempt');
    const body = record(input);
    if (
      !body ||
      Object.keys(body).some((key) => !['decisionId', 'summary', 'documentRefs'].includes(key)) ||
      typeof body.decisionId !== 'string' ||
      !body.decisionId.trim() ||
      body.decisionId.length > 128 ||
      typeof body.summary !== 'string' ||
      !body.summary.trim() ||
      body.summary.trim().length > policy.inbox.managerMessageCharacters ||
      (body.documentRefs !== undefined && !Array.isArray(body.documentRefs)) ||
      (Array.isArray(body.documentRefs) && body.documentRefs.some((item) => !safeDocumentReference(item, policy))) ||
      Buffer.byteLength(JSON.stringify(body)) > policy.brief.bytes
    )
      throw new Error('owner decision requires decisionId, summary and optional repository-relative documentRefs');
    const accepted = {
      decisionId: body.decisionId.trim(),
      summary: body.summary.trim(),
      documentRefs: body.documentRefs ?? [],
      managerId: actor.id,
      senderSessionId: actor.sessionId,
      taskId: task.id,
      attempt: ref.attempt,
    };
    if (Buffer.byteLength(JSON.stringify(accepted)) > policy.brief.bytes)
      throw new Error('owner decision exceeds the existing prompt input limit');
    store.event(ref, DECISION_EVENT, accepted);
  });
}

function decisionFromEvent(
  event: WorkerEvent,
  task: Task,
  ref: AttemptRef,
  policy: ControlPolicy,
): OwnerDecision | undefined {
  if (
    event.kind !== DECISION_EVENT ||
    event.task_id !== task.id ||
    event.attempt !== ref.attempt ||
    Buffer.byteLength(event.body) > policy.brief.bytes
  )
    return undefined;
  let body: Record<string, unknown> | undefined;
  try {
    body = record(JSON.parse(event.body));
  } catch {
    return undefined;
  }
  if (!body) return undefined;
  const managerId = body.managerId;
  const senderSessionId = body.senderSessionId;
  const summary = body.summary;
  const references = Array.isArray(body.documentRefs) ? body.documentRefs : [];
  const refs = references.map((reference) => safeDocumentReference(reference, policy));
  if (
    managerId !== task.brief.manager ||
    typeof senderSessionId !== 'string' ||
    !senderSessionId.trim() ||
    typeof body.decisionId !== 'string' ||
    !body.decisionId.trim() ||
    (body.kind !== undefined && body.kind !== 'decision') ||
    body.senderProvenance !== undefined ||
    body.taskId !== task.id ||
    body.attempt !== ref.attempt ||
    typeof summary !== 'string' ||
    !summary.trim() ||
    summary.trim().length > policy.inbox.managerMessageCharacters ||
    (body.documentRefs !== undefined && !Array.isArray(body.documentRefs)) ||
    refs.some((reference) => reference === undefined)
  )
    return undefined;
  const decidedAt = Date.parse(event.at) || 0;
  return {
    id: stableId(body.decisionId.trim(), managerId),
    managerId,
    senderSessionId: senderSessionId.trim(),
    decidedAt,
    sequence: event.sequence,
    summary: summary.trim(),
    documentRefs: [...new Map((refs as DocumentReference[]).map((reference) => [reference.path, reference])).values()],
  };
}

function availableInWorktree(worktree: string, path: string): boolean {
  try {
    const root = realpathSync(worktree);
    const target = resolve(root, path);
    const relativePath = relative(root, target);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
      return false;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const realRelative = relative(root, realpathSync(target));
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return false;
    accessSync(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function deliveredState(events: readonly WorkerEvent[], decision: OwnerDecision) {
  let summaryDelivered = false;
  const deliveredDocumentPaths = new Set<string>();
  for (const event of events) {
    if (event.kind !== DELIVERY_EVENT) continue;
    let body: Record<string, unknown> | undefined;
    try {
      body = record(JSON.parse(event.body));
    } catch {
      continue;
    }
    if (
      body?.decisionId !== decision.id ||
      body.decisionSequence !== decision.sequence ||
      event.sequence <= decision.sequence
    )
      continue;
    if (body.summaryDelivered === true) summaryDelivered = true;
    if (Array.isArray(body.documentRefs)) {
      for (const reference of body.documentRefs) {
        const item = record(reference);
        if (item?.status === 'delivered' && typeof item.path === 'string') deliveredDocumentPaths.add(item.path);
      }
    }
  }
  return { summaryDelivered, deliveredDocumentPaths };
}

function latestDecision(
  events: readonly WorkerEvent[],
  task: Task,
  ref: AttemptRef,
  policy: ControlPolicy,
): OwnerDecision | undefined {
  const unique = new Map<string, OwnerDecision>();
  for (const event of events) {
    const decision = decisionFromEvent(event, task, ref, policy);
    if (!decision) continue;
    const previous = unique.get(decision.id);
    if (!previous || decision.sequence < previous.sequence) unique.set(decision.id, decision);
  }
  return [...unique.values()]
    .sort((left, right) => left.decidedAt - right.decidedAt || left.sequence - right.sequence)
    .at(-1);
}

export function prepareOwnerDecisionPrompt(
  store: Pick<WorkerStore, 'ownerDecisionEvents'>,
  task: Task,
  ref: AttemptRef,
  prompt: string,
  policy: ControlPolicy = defaultPolicy,
): PreparedOwnerDecisionPrompt {
  if (task.id !== ref.taskId || task.currentAttempt !== ref.attempt) return { prompt };
  const events = store.ownerDecisionEvents(ref);
  const decision = latestDecision(events, task, ref, policy);
  if (!decision) return { prompt };

  const delivered = deliveredState(events, decision);
  const pendingDocuments = decision.documentRefs.filter(
    (reference) =>
      !delivered.deliveredDocumentPaths.has(reference.path) || !availableInWorktree(task.worktree, reference.path),
  );
  if (delivered.summaryDelivered && pendingDocuments.length === 0) return { prompt };

  const lines = [
    `Owner decision ${decision.id} from authenticated manager ${decision.managerId}: this prompt carries the decision.`,
    ...(delivered.summaryDelivered ? [] : [`Decision: ${decision.summary}`]),
  ];
  const documentRefs: OwnerDecisionDelivery['documentRefs'] = [];
  const fits = (block: string) =>
    `${prompt}\n\n${block}`.length <= policy.workerPrompt.characters &&
    Buffer.byteLength(`${prompt}\n\n${block}`) <= policy.brief.bytes;
  let omitted = 0;
  for (const reference of pendingDocuments) {
    const available = availableInWorktree(task.worktree, reference.path);
    const status = available ? 'delivered' : 'pending';
    const change = reference.change ? ` — ${reference.change}` : '';
    const line = available
      ? `- Document reference delivered and available in the worker worktree: ${reference.path}${change}`
      : `- Document reference pending and unavailable in the worker worktree: ${reference.path}${change}`;
    if (!fits([...lines, line].join('\n'))) {
      omitted++;
      continue;
    }
    lines.push(line);
    documentRefs.push({ path: reference.path, status });
  }
  if (omitted) {
    const notice = () =>
      `- ${omitted} document reference(s) remain pending because this prompt reached its total input limit.`;
    while (lines.length > (delivered.summaryDelivered ? 1 : 2) && !fits([...lines, notice()].join('\n'))) {
      lines.pop();
      documentRefs.pop();
      omitted++;
    }
    lines.push(notice());
  }
  if (!fits(lines.join('\n')))
    throw new Error('owner decision and worker prompt exceed the existing total prompt input limit');
  const receipt: OwnerDecisionDelivery = {
    decisionId: decision.id,
    decisionSequence: decision.sequence,
    summaryDelivered: !delivered.summaryDelivered,
    documentRefs,
  };
  return { prompt: `${prompt}\n\n${lines.join('\n')}`, delivery: receipt };
}
