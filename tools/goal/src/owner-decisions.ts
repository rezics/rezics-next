import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { AttemptRef } from './contracts.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { WorkerEvent, WorkerStore } from './store.ts';
import type { Task } from './types.ts';
import { briefProposalHash } from './durable-follow-up.ts';

const DECISION_EVENT = 'owner-contract-decision-accepted';
const DELIVERY_EVENT = 'owner-contract-decision-delivery';
export const MAX_WORKER_PROMPT_CHARACTERS = defaultPolicy.workerPrompt.characters;

type DocumentReference = { path: string; change?: string };
type OwnerDecision = {
  id: string;
  originatingAttempt: number;
  contractSha256?: string;
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
  originatingAttempt: number;
  managerId: string;
  senderSessionId: string;
  summaryDelivered: boolean;
  documentRefs: { path: string; status: 'delivered' | 'pending' }[];
};

/** A worktree-relative file that the prompt points to when the decision does not fit the prompt. */
export type OwnerDecisionFile = { path: string; content: string };

export type PreparedOwnerDecisionPrompt = {
  prompt: string;
  delivery?: OwnerDecisionDelivery;
  file?: OwnerDecisionFile;
};

const DECISION_FILE_DIRECTORY = '.temp/owner-decisions';

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
      contractSha256: briefProposalHash(task.brief.markdown),
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
    event.attempt < 1 ||
    event.attempt > ref.attempt ||
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
    body.attempt !== event.attempt ||
    (body.contractSha256 !== undefined &&
      (typeof body.contractSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.contractSha256))) ||
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
    originatingAttempt: event.attempt,
    ...(typeof body.contractSha256 === 'string' ? { contractSha256: body.contractSha256 } : {}),
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

type DecisionDeliveryState = { summaryDelivered: boolean; deliveredDocumentPaths: Set<string> };
type OwnerDecisionProjection = { decision: OwnerDecision | undefined; delivery: DecisionDeliveryState };

function decisionDeliveryKey(decisionId: string, decisionSequence: number): string {
  return JSON.stringify([decisionId, decisionSequence]);
}

function projectOwnerDecision(
  events: readonly WorkerEvent[],
  task: Task,
  ref: AttemptRef,
  policy: ControlPolicy,
): OwnerDecisionProjection {
  const earliestById = new Map<string, OwnerDecision>();
  const deliveryByDecision = new Map<string, DecisionDeliveryState>();
  let supersededThrough = 0;
  for (const event of events) {
    if (event.task_id !== task.id || event.attempt < 0 || event.attempt > ref.attempt) continue;
    if (event.kind === 'owner-contract-decisions-superseded') {
      supersededThrough = Math.max(supersededThrough, event.sequence);
      continue;
    }
    if (event.kind === DECISION_EVENT) {
      const decision = decisionFromEvent(event, task, ref, policy);
      if (!decision) continue;
      const previous = earliestById.get(decision.id);
      if (!previous || decision.sequence < previous.sequence) earliestById.set(decision.id, decision);
      continue;
    }
    if (event.kind !== DELIVERY_EVENT) continue;
    let body: Record<string, unknown> | undefined;
    try {
      body = record(JSON.parse(event.body));
    } catch {
      continue;
    }
    if (!body) continue;
    const decisionId = body.decisionId;
    const decisionSequence = body.decisionSequence;
    if (typeof decisionId !== 'string' || typeof decisionSequence !== 'number' || event.sequence <= decisionSequence)
      continue;
    const accepted = earliestById.get(decisionId);
    if (!accepted || accepted.sequence !== decisionSequence || event.attempt < accepted.originatingAttempt) continue;
    const key = decisionDeliveryKey(decisionId, decisionSequence);
    let delivery = deliveryByDecision.get(key);
    if (!delivery) {
      delivery = { summaryDelivered: false, deliveredDocumentPaths: new Set<string>() };
      deliveryByDecision.set(key, delivery);
    }
    if (body.summaryDelivered === true) delivery.summaryDelivered = true;
    if (Array.isArray(body.documentRefs)) {
      for (const reference of body.documentRefs) {
        const item = record(reference);
        if (item?.status === 'delivered' && typeof item.path === 'string')
          delivery.deliveredDocumentPaths.add(item.path);
      }
    }
  }

  let decision: OwnerDecision | undefined;
  const contractHash = task.brief.markdown === undefined ? undefined : briefProposalHash(task.brief.markdown);
  for (const candidate of earliestById.values()) {
    if (
      candidate.sequence <= supersededThrough ||
      (candidate.contractSha256 !== undefined && candidate.contractSha256 !== contractHash)
    )
      continue;
    if (
      !decision ||
      candidate.decidedAt > decision.decidedAt ||
      (candidate.decidedAt === decision.decidedAt && candidate.sequence > decision.sequence)
    )
      decision = candidate;
  }
  const delivery = decision ? deliveryByDecision.get(decisionDeliveryKey(decision.id, decision.sequence)) : undefined;
  return {
    decision,
    delivery: delivery ?? { summaryDelivered: false, deliveredDocumentPaths: new Set<string>() },
  };
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
  const projection = projectOwnerDecision(events, task, ref, policy);
  const decision = projection.decision;
  if (!decision) return { prompt };

  const delivered = projection.delivery;
  const availabilityByPath = new Map<string, boolean>();
  for (const reference of decision.documentRefs)
    availabilityByPath.set(reference.path, availableInWorktree(task.worktree, reference.path));
  const pendingDocuments = decision.documentRefs.filter(
    (reference) =>
      !delivered.deliveredDocumentPaths.has(reference.path) || availabilityByPath.get(reference.path) === false,
  );
  if (delivered.summaryDelivered && pendingDocuments.length === 0) return { prompt };

  // The brief limit admits the decision event; the assembled worker input has its own budget.
  const remainingCharacters = policy.workerPrompt.characters - prompt.length - 2;
  const remainingBytes = policy.prompt.workerTotalBytes - Buffer.byteLength(prompt) - 2;
  const fits = (block: string) => block.length <= remainingCharacters && Buffer.byteLength(block) <= remainingBytes;
  const header = `Owner decision ${decision.id} from authenticated manager ${decision.managerId}: this prompt carries the decision.`;
  const summary = `Decision: ${decision.summary}`;
  // A summary that does not fit becomes a pointer to the decision file, so no decision refuses a launch.
  const pointer = `${DECISION_FILE_DIRECTORY}/${decision.sequence}.md`;
  let lines: string[];
  let file: OwnerDecisionFile | undefined;
  if (delivered.summaryDelivered) lines = [header];
  else if (fits([header, summary].join('\n'))) lines = [header, summary];
  else {
    lines = [
      `Owner decision from authenticated manager ${decision.managerId} does not fit this prompt: read ${pointer} before continuing.`,
    ];
    file = { path: pointer, content: decisionFileContent(decision) };
  }
  // Do not acknowledge a decision the worker did not receive, or exceed either existing input limit.
  if (!fits(lines.join('\n'))) return { prompt };
  const fixed = lines.length;
  const documentRefs: OwnerDecisionDelivery['documentRefs'] = [];
  let omitted = 0;
  for (const reference of pendingDocuments) {
    const available = availabilityByPath.get(reference.path) === true;
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
    while (lines.length > fixed && !fits([...lines, notice()].join('\n'))) {
      lines.pop();
      documentRefs.pop();
      omitted++;
    }
    if (fits([...lines, notice()].join('\n'))) lines.push(notice());
  }
  const receipt: OwnerDecisionDelivery = {
    decisionId: decision.id,
    decisionSequence: decision.sequence,
    originatingAttempt: decision.originatingAttempt,
    managerId: decision.managerId,
    senderSessionId: decision.senderSessionId,
    summaryDelivered: !delivered.summaryDelivered,
    documentRefs,
  };
  return { prompt: `${prompt}\n\n${lines.join('\n')}`, delivery: receipt, ...(file ? { file } : {}) };
}

function decisionFileContent(decision: OwnerDecision): string {
  const references = decision.documentRefs.map(
    (reference) => `- ${reference.path}${reference.change ? ` — ${reference.change}` : ''}`,
  );
  return [
    `Owner decision ${decision.id} from authenticated manager ${decision.managerId}.`,
    '',
    decision.summary,
    ...(references.length ? ['', 'Document references:', ...references] : []),
    '',
  ].join('\n');
}

/** Places the pointer's target in the worker worktree before the worker starts, so the prompt's path resolves. */
export function writeOwnerDecisionFile(worktree: string, file: OwnerDecisionFile): void {
  const path = join(worktree, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.content);
}
