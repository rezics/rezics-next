import type { KernelClient } from '@rezics/client';
import { parseDocument, serializeDocument } from '@rezics/document';
import { admitKnowledgePrivateHead, isKnowledgeId, type KnowledgeDocumentReceipt, type KnowledgePrivateHead } from './private-knowledge';

type CopyRoute = ReturnType<KernelClient['knowledge']['notebooks']>['documents']['$copy']['post'];
export type KnowledgeCopyBody = Parameters<CopyRoute>[0];
export type KnowledgeTransferSource = KnowledgeCopyBody['source'];
type ExportRoute = ReturnType<KernelClient['knowledge']['documents']>['export']['get'];
export type KnowledgeExportEnvelope = NonNullable<Awaited<ReturnType<ExportRoute>>['data']>;
export type KnowledgeTransferBinding = Readonly<{ viewer: string; csrfToken: string; credential: string }>;
export type KnowledgeCopyIntent = Readonly<KnowledgeCopyBody & {
  notebookId: string;
  idempotencyKey: string;
  binding: KnowledgeTransferBinding;
}>;
export type KnowledgeTransferFailure = { state: 'denied' | 'not-found' | 'unavailable' | 'retired' | 'signed-out' };
export type KnowledgeExportResult = { state: 'ready'; bytes: string } | KnowledgeTransferFailure;
export type KnowledgeCopyResult =
  | { state: 'acknowledged'; receipt: KnowledgeDocumentReceipt }
  | { state: 'conflict' | 'uncertain' }
  | KnowledgeTransferFailure;
export type KnowledgeCopyReadback = { state: 'ready'; head: KnowledgePrivateHead; provenance: KnowledgeExportEnvelope['provenance'] } | KnowledgeTransferFailure;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const digest = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const representation = (v: unknown) => v === 'public' || v === 'authoring';
const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((key) => keys.includes(key));
const provenance = (v: unknown): boolean => record(v) &&
  closed(v, ['documentId', 'revisionId', 'representation', 'sha256', 'publicationId']) &&
  isKnowledgeId(v.documentId) && isKnowledgeId(v.revisionId) && representation(v.representation) && digest(v.sha256) &&
  (v.publicationId === undefined || isKnowledgeId(v.publicationId));

/** HTTP source union: no head/live shortcut, extra account operand or implicit representation upgrade. */
export function parseKnowledgeTransferSource(value: unknown): KnowledgeTransferSource | null {
  if (!record(value) || !isKnowledgeId(value.documentId) || !isKnowledgeId(value.revisionId)) return null;
  if (value.representation === 'public' && closed(value, ['representation', 'documentId', 'revisionId']))
    return { representation: 'public', documentId: value.documentId, revisionId: value.revisionId };
  if (value.representation === 'authoring' && isKnowledgeId(value.accountId) && isKnowledgeId(value.notebookId) &&
    closed(value, ['representation', 'accountId', 'notebookId', 'documentId', 'revisionId']))
    return { representation: 'authoring', accountId: value.accountId, notebookId: value.notebookId, documentId: value.documentId, revisionId: value.revisionId };
  return null;
}

function reference(value: unknown): boolean {
  if (!record(value) || !closed(value, ['id', 'role', 'sourceBlockId', 'target']) || !text(value.id, 256) ||
    !['about', 'cites', 'explains', 'uses', 'inspired-by'].includes(value.role as string) ||
    (value.sourceBlockId !== undefined && !text(value.sourceBlockId, 256))) return false;
  const target = value.target;
  if (target === null) return true;
  if (!record(target)) return false;
  if (target.kind === 'subject') return closed(target, ['kind', 'subjectId']) && isKnowledgeId(target.subjectId);
  if (!isKnowledgeId(target.documentId)) return false;
  if (target.kind === 'document') return closed(target, ['kind', 'documentId']);
  return target.kind === 'revision' && closed(target, ['kind', 'documentId', 'revisionId', 'sha256', 'blockId']) &&
    isKnowledgeId(target.revisionId) && digest(target.sha256) && (target.blockId === undefined || text(target.blockId, 256));
}

/** Validate the HTTP envelope independently of Document, using the native field/cardinality/body limits. */
export function admitKnowledgeExport(value: unknown, source: KnowledgeTransferSource): boolean {
  if (!record(value) || !closed(value, ['version', 'representation', 'selection', 'title', 'language', 'licence', 'subjectIds', 'snapshot', 'references', 'provenance', 'sha256']) ||
    value.version !== 'knowledge-document-export-v1' || value.representation !== source.representation ||
    !provenance(value.selection) || !record(value.selection) || value.selection.representation !== source.representation ||
    value.selection.documentId !== source.documentId || value.selection.revisionId !== source.revisionId ||
    (source.representation === 'public' && !isKnowledgeId(value.selection.publicationId)) ||
    !text(value.title, 512) || !(value.language === null || text(value.language, 64)) || !text(value.licence, 128) ||
    !Array.isArray(value.subjectIds) || value.subjectIds.length > 64 || !value.subjectIds.every(isKnowledgeId) ||
    !Array.isArray(value.references) || value.references.length > 64 || !value.references.every(reference) ||
    !(value.provenance === null || provenance(value.provenance)) || !digest(value.sha256)) return false;
  try {
    const body = serializeDocument(parseDocument(value.snapshot));
    return new TextEncoder().encode(body).byteLength <= 2 * 1024 * 1024;
  } catch {
    return false;
  }
}

const fetchOptions = { cache: 'no-store', redirect: 'manual' } as const;
function failure(status: number): KnowledgeTransferFailure {
  return { state: status === 401 || status === 403 ? 'denied' : status === 404 ? 'not-found' : 'unavailable' };
}

/** Capture the native canonical JSON before Eden parses it. Never reconstruct an export from editor JSON. */
export async function exportKnowledgeTransfer(
  clientFor: (decorate: (fetcher: typeof fetch) => typeof fetch) => KernelClient,
  source: KnowledgeTransferSource,
  authorization?: string,
): Promise<KnowledgeExportResult> {
  let bytes: string | null = null;
  const client = clientFor((fetcher) => (async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status === 200) bytes = await response.clone().text();
    return response;
  }) as typeof fetch);
  const options = { query: { revisionId: source.revisionId }, fetch: fetchOptions,
    ...(authorization ? { headers: { authorization } } : {}) };
  const result = source.representation === 'public'
    ? await client.knowledge.documents({ id: source.documentId }).export.get(options)
    : await client.accounts({ accountId: source.accountId }).knowledge.notebooks({ notebookId: source.notebookId })
      .documents({ documentId: source.documentId }).export.get(options);
  if (result.status !== 200) return failure(result.status);
  return bytes !== null && admitKnowledgeExport(result.data, source) ? { state: 'ready', bytes } : { state: 'unavailable' };
}

/** Unknown effects retain the sealed command, including its original credential and idempotency key. */
export async function copyKnowledgeTransfer(client: KernelClient, intent: KnowledgeCopyIntent, authorization: string): Promise<KnowledgeCopyResult> {
  const result = await client.knowledge.notebooks({ id: intent.notebookId }).documents.$copy.post({
    source: intent.source,
    expectedStructureRevisionId: intent.expectedStructureRevisionId,
    parentPlacementId: intent.parentPlacementId,
  }, { headers: { authorization, 'idempotency-key': JSON.stringify(intent.idempotencyKey) }, fetch: fetchOptions });
  if (!result.response || result.status >= 500) return { state: 'uncertain' };
  if (result.status === 412 || result.status === 409) return { state: 'conflict' };
  if (result.error || (result.status !== 201 && result.status !== 200)) return failure(result.status);
  const receipt = result.data;
  if (!receipt || receipt.notebookId !== intent.notebookId || !isKnowledgeId(receipt.documentId) ||
    !isKnowledgeId(receipt.placementId) || !isKnowledgeId(receipt.revisionId) || !isKnowledgeId(receipt.structureRevisionId)) return { state: 'uncertain' };
  return { state: 'acknowledged', receipt: {
    notebookId: receipt.notebookId, documentId: receipt.documentId, placementId: receipt.placementId,
    revisionId: receipt.revisionId, structureRevisionId: receipt.structureRevisionId,
  } };
}

/** A receipt is not an editor observation. Read the exact copied revision with the destination's owner authority. */
export async function readKnowledgeCopy(client: KernelClient, receipt: KnowledgeDocumentReceipt, viewer: string, authorization: string): Promise<KnowledgeCopyReadback> {
  const result = await client.accounts({ accountId: viewer }).knowledge.notebooks({ notebookId: receipt.notebookId })
    .documents({ documentId: receipt.documentId }).get({ query: { revisionId: receipt.revisionId }, headers: { authorization }, fetch: fetchOptions });
  const read = await admitKnowledgePrivateHead(result.status, result.data, { ...receipt, accountId: viewer });
  if (read.state !== 'ready') return { state: read.state };
  const document = result.data?.document;
  if (read.head.revisionId !== receipt.revisionId || !document || !(document.provenance === null || provenance(document.provenance))) return { state: 'unavailable' };
  return { ...read, provenance: document.provenance };
}

export function sealKnowledgeCopy(input: Omit<KnowledgeCopyIntent, 'idempotencyKey'>): KnowledgeCopyIntent {
  const intent = structuredClone({ ...input, idempotencyKey: crypto.randomUUID() });
  Object.freeze(intent.source);
  Object.freeze(intent.binding);
  return Object.freeze(intent);
}
