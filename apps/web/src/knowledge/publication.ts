import type { KernelClient } from '@rezics/client';
import { isKnowledgeId, type KnowledgeCommand, type KnowledgePrivateHead } from './private-knowledge';

export type KnowledgePublicationCommand = Readonly<{
  documentId: string;
  expectedHeadRevisionId: string;
  expectedPublicationId: string | null;
  revisionId: string | null;
  idempotencyKey: string;
  authorization: string;
}>;
export type KnowledgePublicationReceipt = Readonly<{
  documentId: string;
  publicationId: string | null;
  revisionId: string | null;
}>;
export type KnowledgePublicationBinding = Readonly<{ viewer: string; csrfToken: string; credential: string }>;
export type KnowledgePublicationIntent = Readonly<
  Omit<KnowledgePublicationCommand, 'authorization'> & { binding: KnowledgePublicationBinding }
>;
export type KnowledgePublicationResult =
  | KnowledgeCommand<KnowledgePublicationReceipt>
  | { state: 'signed-out' | 'retired' }
  | { state: 'unavailable'; status?: number };

/** A private observation, including the publication pointer, is the complete review boundary. */
export function knowledgePublicationObservation(head: KnowledgePrivateHead): string {
  return JSON.stringify(head);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function reviewKnowledgePublication(
  head: KnowledgePrivateHead,
  binding: KnowledgePublicationBinding,
  action: 'publish' | 'withdraw',
) {
  const saved = freeze(structuredClone(head));
  const intent: KnowledgePublicationIntent = freeze({
    documentId: saved.documentId,
    expectedHeadRevisionId: saved.revisionId,
    expectedPublicationId: saved.publicationId,
    revisionId: action === 'withdraw' ? null : saved.revisionId,
    idempotencyKey: crypto.randomUUID(),
    binding: { ...binding },
  });
  return { head: saved, observation: knowledgePublicationObservation(saved), intent } as const;
}

/** Generated singular publication.$select maps to native publication:select. No private text is sent. */
export async function selectKnowledgePublication(
  client: KernelClient,
  input: KnowledgePublicationCommand,
): Promise<KnowledgeCommand<KnowledgePublicationReceipt>> {
  const headers = {
    authorization: input.authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  };
  const result = await client.knowledge.documents({ id: input.documentId }).publication.$select.post(
    {
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      expectedPublicationId: input.expectedPublicationId,
      revisionId: input.revisionId,
    },
    {
      headers,
      fetch: { cache: 'no-store', redirect: 'manual' },
    },
  );
  if (!result.response) return { state: 'uncertain' };
  if (result.status === 401 || result.status === 403) return { state: 'denied', status: result.status };
  if (result.status === 404) return { state: 'not-found', status: 404 };
  if (result.status === 412) return { state: 'conflict', status: 412 };
  // A server error without a proved no-effect response cannot release this immutable intent.
  if (result.status >= 500) return { state: 'uncertain' };
  if (result.error || result.status !== 200) return { state: 'unavailable', status: result.status };
  const value = result.data;
  if (
    !value ||
    value.documentId !== input.documentId ||
    (input.revisionId === null
      ? value.publicationId !== null || value.revisionId !== undefined
      : !isKnowledgeId(value.publicationId) || value.revisionId !== input.revisionId)
  )
    return { state: 'uncertain' };
  return {
    state: 'acknowledged',
    receipt: {
      documentId: input.documentId,
      publicationId: value.publicationId!,
      revisionId: input.revisionId,
    },
  };
}
