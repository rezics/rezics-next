import type { KernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { admitKnowledgePrivateHead, isKnowledgeId, type KnowledgePrivateAddress } from './private-knowledge';

export const KNOWLEDGE_HISTORY_LIMIT = 20;
export type KnowledgeHistoryRow = Readonly<{
  revisionId: string;
  title: string;
  language: string | null;
  licence: string;
  sha256: string;
  createdAt: string;
}>;
export type KnowledgeHistoryPage = Readonly<{
  documentId: string;
  revisions: readonly KnowledgeHistoryRow[];
  next: string | null;
}>;
export type KnowledgeHistoryPair = Readonly<{ leftRevisionId: string; rightRevisionId: string }>;
export type KnowledgeHistoryReference = Readonly<{
  id: string;
  role: 'about' | 'cites' | 'explains' | 'uses' | 'inspired-by';
  sourceBlockId?: string;
  target:
    | null
    | { kind: 'subject'; subjectId: string }
    | { kind: 'document'; documentId: string }
    | { kind: 'revision'; documentId: string; revisionId: string; sha256: string; blockId?: string };
}>;
export type KnowledgeHistoryProvenance = Readonly<{
  documentId: string;
  revisionId: string;
  representation: 'authoring' | 'public';
  sha256: string;
  publicationId?: string;
}>;
export type KnowledgeHistoryRevision = Readonly<{
  documentId: string;
  revisionId: string;
  title: string;
  language: string | null;
  licence: string;
  sha256: string;
  subjectIds: readonly string[];
  body: DocumentSnapshot;
  /** Decoded canonical source, retained without normalization or reserialization. */
  source: string;
  references: readonly KnowledgeHistoryReference[];
  provenance: KnowledgeHistoryProvenance | null;
}>;
export type KnowledgeHistoryComparison = Readonly<{
  documentId: string;
  left: KnowledgeHistoryRevision;
  right: KnowledgeHistoryRevision;
}>;
export type KnowledgeHistoryFailure =
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'not-found'; status: 404 }
  | { state: 'stale'; status: 409 }
  | { state: 'unavailable'; status?: number }
  | { state: 'signed-out' | 'retired' };
export type KnowledgeHistoryRead = { state: 'ready'; page: KnowledgeHistoryPage } | KnowledgeHistoryFailure;
export type KnowledgeHistoryCompareRead =
  | { state: 'ready'; comparison: KnowledgeHistoryComparison }
  | KnowledgeHistoryFailure;
export type KnowledgeHistoryBinding = Readonly<{ viewer: string; csrfToken: string }>;
export type KnowledgeHistoryOperations = Readonly<{
  read: (
    address: KnowledgePrivateAddress,
    cursor: string | null,
    expected: KnowledgeHistoryBinding,
  ) => Promise<KnowledgeHistoryRead>;
  compare: (
    address: KnowledgePrivateAddress,
    pair: KnowledgeHistoryPair,
    expected: KnowledgeHistoryBinding,
  ) => Promise<KnowledgeHistoryCompareRead>;
}>;

type NativeInput = KnowledgePrivateAddress & { accountId: string; authorization: string };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const language = (value: unknown): value is string | null => value === null || text(value, 64);

/** HTTP input only: native continuations are opaque, including punctuation and whitespace. */
export function parseKnowledgeHistoryCursor(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return text(value, 4096) ? value : undefined;
}

export function parseKnowledgeHistoryPair(value: unknown): KnowledgeHistoryPair | null {
  if (
    !record(value) ||
    !isKnowledgeId(value.leftRevisionId) ||
    !isKnowledgeId(value.rightRevisionId) ||
    value.leftRevisionId === value.rightRevisionId
  )
    return null;
  return { leftRevisionId: value.leftRevisionId, rightRevisionId: value.rightRevisionId };
}

function failure(status: number): KnowledgeHistoryFailure {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status };
  if (status === 409) return { state: 'stale', status };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

export function admitKnowledgeHistory(value: unknown, documentId: string): KnowledgeHistoryRead {
  if (
    !record(value) ||
    value.documentId !== documentId ||
    !Array.isArray(value.revisions) ||
    value.revisions.length > KNOWLEDGE_HISTORY_LIMIT ||
    !(value.next === null || text(value.next, 4096))
  )
    return failure(502);
  const revisions: KnowledgeHistoryRow[] = [];
  for (const row of value.revisions) {
    if (
      !record(row) ||
      !isKnowledgeId(row.revisionId) ||
      !text(row.title, 512) ||
      !language(row.language) ||
      !text(row.licence, 128) ||
      !digest(row.sha256) ||
      !text(row.createdAt, 64) ||
      !Number.isFinite(Date.parse(row.createdAt))
    )
      return failure(502);
    revisions.push({
      revisionId: row.revisionId,
      title: row.title,
      language: row.language,
      licence: row.licence,
      sha256: row.sha256,
      createdAt: row.createdAt,
    });
  }
  return { state: 'ready', page: { documentId, revisions, next: value.next as string | null } };
}

function reference(value: unknown): value is KnowledgeHistoryReference {
  if (
    !record(value) ||
    !text(value.id, 256) ||
    !['about', 'cites', 'explains', 'uses', 'inspired-by'].includes(String(value.role)) ||
    !(value.sourceBlockId === undefined || text(value.sourceBlockId, 256))
  )
    return false;
  const target = value.target;
  if (target === null) return true;
  if (!record(target)) return false;
  if (target.kind === 'subject') return isKnowledgeId(target.subjectId);
  if (target.kind === 'document') return isKnowledgeId(target.documentId);
  return (
    target.kind === 'revision' &&
    isKnowledgeId(target.documentId) &&
    isKnowledgeId(target.revisionId) &&
    digest(target.sha256) &&
    (target.blockId === undefined || text(target.blockId, 256))
  );
}

function provenance(value: unknown): value is KnowledgeHistoryProvenance | null {
  return (
    value === null ||
    (record(value) &&
      isKnowledgeId(value.documentId) &&
      isKnowledgeId(value.revisionId) &&
      (value.representation === 'authoring' || value.representation === 'public') &&
      digest(value.sha256) &&
      (value.publicationId === undefined || isKnowledgeId(value.publicationId)))
  );
}

function admittedReference(value: KnowledgeHistoryReference): KnowledgeHistoryReference {
  const target = value.target;
  return {
    id: value.id,
    role: value.role,
    ...(value.sourceBlockId === undefined ? {} : { sourceBlockId: value.sourceBlockId }),
    target:
      target === null
        ? null
        : target.kind === 'subject'
          ? { kind: 'subject', subjectId: target.subjectId }
          : target.kind === 'document'
            ? { kind: 'document', documentId: target.documentId }
            : {
                kind: 'revision',
                documentId: target.documentId,
                revisionId: target.revisionId,
                sha256: target.sha256,
                ...(target.blockId === undefined ? {} : { blockId: target.blockId }),
              },
  };
}

function admittedProvenance(value: KnowledgeHistoryProvenance | null): KnowledgeHistoryProvenance | null {
  return value === null
    ? null
    : {
        documentId: value.documentId,
        revisionId: value.revisionId,
        representation: value.representation,
        sha256: value.sha256,
        ...(value.publicationId === undefined ? {} : { publicationId: value.publicationId }),
      };
}

async function admitRevision(
  value: unknown,
  revisionId: string,
  input: NativeInput,
): Promise<KnowledgeHistoryRevision | null> {
  if (
    !record(value) ||
    value.revisionId !== revisionId ||
    !Array.isArray(value.references) ||
    value.references.length > 64 ||
    !value.references.every(reference) ||
    !provenance(value.provenance)
  )
    return null;
  // Both APIs return the same canonical byte document. Reuse its digest and document parser admission.
  const admitted = await admitKnowledgePrivateHead(
    200,
    { document: { ...value, notebookId: input.notebookId, publicationId: null } },
    input,
  );
  if (admitted.state !== 'ready') return null;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value.canonicalBytes as string), (character) => character.charCodeAt(0)),
    );
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const { head } = admitted;
  return {
    documentId: head.documentId,
    revisionId: head.revisionId,
    title: head.title,
    language: head.language,
    licence: head.licence,
    sha256: value.sha256 as string,
    subjectIds: head.subjectIds,
    body: head.body,
    source,
    references: value.references.map(admittedReference),
    provenance: admittedProvenance(value.provenance),
  };
}

/** One explicit request, one native metadata page. Never refill or read row bodies. */
export async function readKnowledgeHistory(
  client: KernelClient,
  input: NativeInput & { cursor: string | null },
): Promise<KnowledgeHistoryRead> {
  const result = await client
    .accounts({ accountId: input.accountId })
    .knowledge.notebooks({ notebookId: input.notebookId })
    .documents({ documentId: input.documentId })
    .history.get({
      query: { limit: KNOWLEDGE_HISTORY_LIMIT, ...(input.cursor === null ? {} : { cursor: input.cursor }) },
      headers: { authorization: input.authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (!result.response || result.error || result.status !== 200) return failure(result.status);
  return admitKnowledgeHistory(result.data, input.documentId);
}

/** Pair orientation is authored input: never sort, substitute current head or scan local history. */
export async function readKnowledgeHistoryComparison(
  client: KernelClient,
  input: NativeInput & KnowledgeHistoryPair,
): Promise<KnowledgeHistoryCompareRead> {
  const result = await client
    .accounts({ accountId: input.accountId })
    .knowledge.notebooks({ notebookId: input.notebookId })
    .documents({ documentId: input.documentId })
    .compare.get({
      query: { leftRevisionId: input.leftRevisionId, rightRevisionId: input.rightRevisionId },
      headers: { authorization: input.authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (!result.response || result.error || result.status !== 200) return failure(result.status);
  const value: unknown = result.data;
  if (!record(value) || value.documentId !== input.documentId) return failure(502);
  const left = await admitRevision(value.left, input.leftRevisionId, input);
  const right = await admitRevision(value.right, input.rightRevisionId, input);
  return left && right ? { state: 'ready', comparison: { documentId: input.documentId, left, right } } : failure(502);
}
