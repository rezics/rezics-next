import type { KernelClient } from '@rezics/client';
import { parseDocument, type DocumentSnapshot } from '@rezics/document';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type KnowledgePrivateAddress = Readonly<{ notebookId: string; documentId: string }>;
export type KnowledgePrivateHead = Readonly<{
  accountId: string;
  notebookId: string;
  documentId: string;
  revisionId: string;
  publicationId: string | null;
  title: string;
  language: string | null;
  licence: string;
  subjectIds: readonly string[];
  body: DocumentSnapshot;
}>;
export type KnowledgePrivateRead =
  | { state: 'ready'; head: KnowledgePrivateHead }
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'not-found'; status: 404 }
  | { state: 'unavailable'; status: number };

export type KnowledgePrivateFailure =
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'not-found'; status: 404 }
  | { state: 'conflict'; status: 412 }
  | { state: 'unavailable'; status: number }
  | { state: 'uncertain' };

export type KnowledgeNotebookReceipt = Readonly<{ notebookId: string; structureRevisionId: string }>;
export type KnowledgeDocumentReceipt = Readonly<{
  notebookId: string;
  documentId: string;
  revisionId: string;
  structureRevisionId: string;
}>;
export type KnowledgeRevisionReceipt = Readonly<{ documentId: string; revisionId: string }>;
export type KnowledgeCommand<T> = { state: 'acknowledged'; receipt: T } | KnowledgePrivateFailure;

export type KnowledgeNotebookCommand = Readonly<{
  subjectId: string;
  title: string;
  idempotencyKey: string;
  authorization: string;
}>;
export type KnowledgeDocumentCommand = Readonly<{
  notebookId: string;
  structureRevisionId: string;
  subjectId: string;
  title: string;
  language: string | null;
  body: DocumentSnapshot;
  licence: string;
  idempotencyKey: string;
  authorization: string;
}>;
export type KnowledgeRevisionCommand = Readonly<{
  documentId: string;
  expectedHeadRevisionId: string;
  title: string;
  language: string | null;
  body: DocumentSnapshot;
  licence: string;
  subjectIds: readonly string[];
  idempotencyKey: string;
  authorization: string;
}>;

export function isKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

export function parseKnowledgePrivateSubjectSearch(value: unknown): { subjectId: string } | null {
  return isRecord(value) && isKnowledgeId(value.subjectId) ? { subjectId: value.subjectId } : null;
}

export function parseKnowledgePrivateAddress(value: unknown): KnowledgePrivateAddress | null {
  if (!isRecord(value) || !isKnowledgeId(value.notebookId) || !isKnowledgeId(value.documentId)) return null;
  return { notebookId: value.notebookId, documentId: value.documentId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function ids(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result: string[] = [];
  for (const item of value) {
    if (!isKnowledgeId(item)) return null;
    result.push(item);
  }
  return result;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !base64Pattern.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Admit one native current-head response against its exact routed address and stored digest. */
export async function admitKnowledgePrivateHead(
  status: number,
  value: unknown,
  address: KnowledgePrivateAddress & { accountId: string },
): Promise<KnowledgePrivateRead> {
  if (status !== 200) return privateReadFailure(status);
  const document = member(value, 'document');
  const documentId = member(document, 'documentId');
  const notebookId = member(document, 'notebookId');
  const revisionId = member(document, 'revisionId');
  const publicationId = member(document, 'publicationId');
  const title = member(document, 'title');
  const language = member(document, 'language');
  const licence = member(document, 'licence');
  const subjectIds = ids(member(document, 'subjectIds'));
  const canonicalBytes = member(document, 'canonicalBytes');
  const digest = member(document, 'sha256');
  if (
    !isKnowledgeId(address.accountId) ||
    !isKnowledgeId(documentId) ||
    !isKnowledgeId(notebookId) ||
    !isKnowledgeId(revisionId) ||
    !(publicationId === null || isKnowledgeId(publicationId)) ||
    documentId !== address.documentId ||
    notebookId !== address.notebookId ||
    !text(title, 1, 512) ||
    !(language === null || text(language, 1, 64)) ||
    !text(licence, 1, 128) ||
    !subjectIds ||
    typeof digest !== 'string' ||
    !digestPattern.test(digest)
  )
    return { state: 'unavailable', status: 502 };

  const bytes = decodeBase64(canonicalBytes);
  if (!bytes || (await sha256(bytes)) !== digest) return { state: 'unavailable', status: 502 };
  try {
    const parsed = parseDocument(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      state: 'ready',
      head: {
        accountId: address.accountId,
        notebookId,
        documentId,
        revisionId,
        publicationId,
        title,
        language,
        licence,
        subjectIds,
        body: parsed,
      },
    };
  } catch {
    return { state: 'unavailable', status: 502 };
  }
}

function privateReadFailure(status: number): KnowledgePrivateRead {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status: 404 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

function commandFailure(status: number): KnowledgePrivateFailure {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status: 404 };
  if (status === 412) return { state: 'conflict', status: 412 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

function receipt(value: unknown, fields: readonly string[]): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const field of fields) {
    const item = value[field];
    if (!isKnowledgeId(item)) return null;
    result[field] = item;
  }
  return result;
}

function commandResult<T>(
  result: { response?: Response; status: number; error?: unknown; data?: unknown },
  expectedStatus: readonly number[],
  receiptFields: readonly string[],
): KnowledgeCommand<T> {
  if (!result.response) return { state: 'uncertain' };
  if (result.error) return commandFailure(result.status);
  if (!expectedStatus.includes(result.status)) return commandFailure(result.status);
  const acknowledged = receipt(result.data, receiptFields);
  if (!acknowledged) return { state: 'uncertain' };
  return { state: 'acknowledged', receipt: acknowledged as T };
}

/** Read only the current private head at this account/notebook/document address. */
export async function readKnowledgePrivateHead(
  client: KernelClient,
  input: KnowledgePrivateAddress & { accountId: string; authorization: string },
): Promise<KnowledgePrivateRead> {
  const result = await client
    .accounts({ accountId: input.accountId })
    .knowledge.notebooks({ notebookId: input.notebookId })
    .documents({ documentId: input.documentId })
    .get({
      headers: { authorization: input.authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (result.error || !result.response) return privateReadFailure(result.status);
  return admitKnowledgePrivateHead(result.status, result.data, input);
}

/** Create the notebook only from the writer's explicit submit action. */
export async function createKnowledgePrivateNotebook(
  client: KernelClient,
  input: KnowledgeNotebookCommand,
): Promise<KnowledgeCommand<KnowledgeNotebookReceipt>> {
  const headers = {
    authorization: input.authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  };
  const result = await client.knowledge.notebooks.post({ subjectId: input.subjectId, title: input.title }, { headers });
  return commandResult(result, [200, 201], ['notebookId', 'structureRevisionId']);
}

/** Create one root document from the receipt of the already acknowledged notebook command. */
export async function createKnowledgePrivateDocument(
  client: KernelClient,
  input: KnowledgeDocumentCommand,
): Promise<KnowledgeCommand<KnowledgeDocumentReceipt>> {
  const headers = {
    authorization: input.authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  };
  const result = await client.knowledge.notebooks({ id: input.notebookId }).documents.post(
    {
      title: input.title,
      language: input.language,
      body: input.body,
      licence: input.licence,
      subjectIds: [input.subjectId],
      expectedStructureRevisionId: input.structureRevisionId,
      parentPlacementId: null,
    },
    { headers },
  );
  return commandResult(result, [200, 201], ['notebookId', 'documentId', 'revisionId', 'structureRevisionId']);
}

/** Revise only the exact current head observed by the caller. */
export async function reviseKnowledgePrivateDocument(
  client: KernelClient,
  input: KnowledgeRevisionCommand,
): Promise<KnowledgeCommand<KnowledgeRevisionReceipt>> {
  const headers = {
    authorization: input.authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  };
  const result = await client.knowledge.documents({ id: input.documentId }).revisions.$revise.post(
    {
      title: input.title,
      language: input.language,
      body: input.body,
      licence: input.licence,
      subjectIds: [...input.subjectIds],
      expectedHeadRevisionId: input.expectedHeadRevisionId,
    },
    { headers },
  );
  return commandResult(result, [200], ['documentId', 'revisionId']);
}
