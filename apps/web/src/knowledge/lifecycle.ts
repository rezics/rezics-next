import type { KernelClient } from '@rezics/client';
import { isKnowledgeId, type KnowledgePrivateAddress, type KnowledgePrivateFailure } from './private-knowledge';

export type KnowledgeLifecycle = Readonly<{
  documentId: string;
  notebookId: string;
  structureRevisionId: string;
  generation: string;
  state: 'active' | 'trashed';
  restoreUntil: string | null;
}>;
export type KnowledgeLifecycleReceipt = KnowledgeLifecycle &
  Readonly<{ complete: boolean; reason: 'subtree_work_required' | null }>;
export type KnowledgeLifecycleBinding = Readonly<{ viewer: string; csrfToken: string; credential: string }>;
export type KnowledgeLifecycleRead =
  | { state: 'ready'; lifecycle: KnowledgeLifecycle; binding: KnowledgeLifecycleBinding }
  | Exclude<KnowledgePrivateFailure, { state: 'conflict' | 'uncertain' }>
  | { state: 'signed-out' | 'retired' };
export type KnowledgeLifecycleIntent = Readonly<{
  address: KnowledgePrivateAddress;
  action: 'trash' | 'restore';
  expectedStructureRevisionId: string;
  expectedGeneration: string;
  idempotencyKey: string;
  binding: KnowledgeLifecycleBinding;
}>;
export type KnowledgeLifecycleResult =
  | { state: 'acknowledged'; receipt: KnowledgeLifecycleReceipt }
  | KnowledgePrivateFailure
  | { state: 'signed-out' | 'retired' };
export type KnowledgeLifecycleOperations = Readonly<{
  read: (
    address: KnowledgePrivateAddress,
    expected: Pick<KnowledgeLifecycleBinding, 'viewer' | 'csrfToken'>,
  ) => Promise<KnowledgeLifecycleRead>;
  change: (intent: KnowledgeLifecycleIntent) => Promise<KnowledgeLifecycleResult>;
}>;

export function isKnowledgeLifecycleGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value);
}

/** Validate the native metadata response at its exact owner-route boundary. */
export function admitKnowledgeLifecycle(value: unknown, address: KnowledgePrivateAddress): KnowledgeLifecycle | null {
  if (typeof value !== 'object' || value === null) return null;
  const dto = value as Record<string, unknown>;
  if (
    dto.documentId !== address.documentId ||
    dto.notebookId !== address.notebookId ||
    !isKnowledgeId(dto.structureRevisionId) ||
    !isKnowledgeLifecycleGeneration(dto.generation) ||
    !(dto.state === 'active' || dto.state === 'trashed') ||
    (dto.state === 'active'
      ? dto.restoreUntil !== null
      : typeof dto.restoreUntil !== 'string' || !Number.isFinite(Date.parse(dto.restoreUntil)))
  ) return null;
  return {
    documentId: address.documentId,
    notebookId: address.notebookId,
    structureRevisionId: dto.structureRevisionId,
    generation: dto.generation,
    state: dto.state,
    restoreUntil: dto.restoreUntil as string | null,
  };
}

function failure(status: number): KnowledgePrivateFailure {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status: 404 };
  if (status === 412) return { state: 'conflict', status: 412 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

export async function readKnowledgeLifecycle(
  client: KernelClient,
  input: KnowledgePrivateAddress & { accountId: string; authorization: string },
): Promise<{ state: 'ready'; lifecycle: KnowledgeLifecycle } | Exclude<KnowledgePrivateFailure, { state: 'conflict' | 'uncertain' }>> {
  const result = await client.accounts({ accountId: input.accountId }).knowledge
    .notebooks({ notebookId: input.notebookId }).documents({ documentId: input.documentId }).lifecycle.get({
      headers: { authorization: input.authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (result.error || !result.response || result.status !== 200) {
    if (result.status === 401 || result.status === 403) return { state: 'denied', status: result.status };
    if (result.status === 404) return { state: 'not-found', status: 404 };
    return { state: 'unavailable', status: result.status >= 400 ? result.status : 502 };
  }
  const lifecycle = admitKnowledgeLifecycle(result.data, input);
  return lifecycle ? { state: 'ready', lifecycle } : { state: 'unavailable', status: 502 };
}

export async function changeKnowledgeLifecycle(
  client: KernelClient,
  input: Omit<KnowledgeLifecycleIntent, 'binding'> & { authorization: string },
): Promise<KnowledgeLifecycleResult> {
  const resource = client.knowledge.documents({ id: input.address.documentId });
  const body = {
    expectedStructureRevisionId: input.expectedStructureRevisionId,
    expectedGeneration: input.expectedGeneration,
  };
  const options = { headers: {
    authorization: input.authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  } };
  const result = input.action === 'trash'
    ? await resource.$trash.post(body, options)
    : await resource.$restore.post(body, options);
  if (!result.response) return { state: 'uncertain' };
  if (result.error || result.status !== 200) return failure(result.status);
  const lifecycle = admitKnowledgeLifecycle(result.data, input.address);
  const dto = result.data as Record<string, unknown>;
  if (!lifecycle || typeof dto.complete !== 'boolean' ||
    (dto.complete
      ? dto.reason !== null || lifecycle.state !== (input.action === 'trash' ? 'trashed' : 'active')
      : dto.reason !== 'subtree_work_required' || lifecycle.state !== (input.action === 'trash' ? 'active' : 'trashed'))
  ) return { state: 'uncertain' };
  return { state: 'acknowledged', receipt: {
    ...lifecycle,
    complete: dto.complete,
    reason: dto.reason as KnowledgeLifecycleReceipt['reason'],
  } };
}

export function reviewKnowledgeLifecycle(
  lifecycle: KnowledgeLifecycle,
  binding: KnowledgeLifecycleBinding,
  action: 'trash' | 'restore',
): KnowledgeLifecycleIntent {
  return Object.freeze({
    address: Object.freeze({ notebookId: lifecycle.notebookId, documentId: lifecycle.documentId }),
    action,
    expectedStructureRevisionId: lifecycle.structureRevisionId,
    expectedGeneration: lifecycle.generation,
    idempotencyKey: crypto.randomUUID(),
    binding: Object.freeze({ ...binding }),
  });
}

export function knowledgeRestoreExpired(lifecycle: KnowledgeLifecycle, now = Date.now()): boolean {
  return lifecycle.state === 'trashed' && Date.parse(lifecycle.restoreUntil!) <= now;
}
