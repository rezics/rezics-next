import type { KernelClient } from '@rezics/client';
import { parseDocument, type DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { recordPageReadCacheControl } from '../security/page-cache';

/** Native Knowledge identifiers are lowercase UUID strings. */
export const knowledgeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

export type KnowledgeReadRequest = {
  documentId: string;
  revisionId: string | null;
  locale: string;
};

export type KnowledgePublicDocument = {
  documentId: string;
  revisionId: string;
  publicationId: string;
  subjectId: string;
  title: string;
  language: string | null;
  licence: string;
  publishedAt: string;
  body: DocumentSnapshot;
};

export type KnowledgeReadState =
  | { state: 'preparing' }
  | { state: 'ready'; document: KnowledgePublicDocument }
  | { state: 'not-found'; status: 404 }
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'unavailable'; status: number };

export type KnowledgeCitationClipboard = {
  writeText: (text: string) => Promise<void>;
};

export type KnowledgeCitationCopyResult = 'success' | 'denied' | 'unavailable';

type KnowledgeDocuments = KernelClient['knowledge']['documents'];
type KnowledgeDocumentGet = ReturnType<KnowledgeDocuments>['get'];
type KnowledgePublicReadResult = Awaited<ReturnType<KnowledgeDocumentGet>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Admit one native identifier at the route or query boundary. */
export function knowledgeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return knowledgeIdPattern.test(id) ? id : null;
}

/** Live reads omit revisionId; an explicit exact address must carry one native identifier. */
export function knowledgeRevisionQuery(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return knowledgeId(value);
}

export function knowledgeLiveHref(locale: string, documentId: string): string {
  return `/${encodeURIComponent(locale)}/knowledge/documents/${encodeURIComponent(documentId)}`;
}

export function knowledgeExactHref(locale: string, documentId: string, revisionId: string): string {
  return `${knowledgeLiveHref(locale, documentId)}?revisionId=${encodeURIComponent(revisionId)}`;
}

export function knowledgeCitationHref(
  locale: string,
  document: Pick<KnowledgePublicDocument, 'documentId' | 'revisionId'>,
): string {
  return knowledgeExactHref(locale, document.documentId, document.revisionId);
}

export function sameKnowledgeRequest(left: KnowledgeReadRequest, right: KnowledgeReadRequest): boolean {
  return left.documentId === right.documentId && left.revisionId === right.revisionId && left.locale === right.locale;
}

export function parseKnowledgeReadRequest(input: unknown): KnowledgeReadRequest | null {
  if (!isRecord(input)) return null;
  const documentId = knowledgeId(input.documentId);
  const locale = input.locale;
  if (!documentId || typeof locale !== 'string' || locale.length < 1 || locale.length > 64) return null;
  if (!('revisionId' in input) || input.revisionId === null) return { documentId, revisionId: null, locale };
  const revisionId = knowledgeId(input.revisionId);
  return revisionId ? { documentId, revisionId, locale } : null;
}

function outcomeForStatus(status: number): KnowledgeReadState {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status: 404 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

function uuidList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const ids: string[] = [];
  for (const item of value) {
    const id = knowledgeId(item);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

function decodeCanonicalDocument(canonicalBytes: string): DocumentSnapshot | null {
  if (!base64Pattern.test(canonicalBytes) || canonicalBytes.length % 4 !== 0) return null;
  try {
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(canonicalBytes), (code) => code.charCodeAt(0))),
    );
    return parseDocument(json);
  } catch {
    return null;
  }
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10 || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function languageOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && value.length >= 1 && value.length <= 64) return value;
  return undefined;
}

/**
 * Admit only the public publication fields the native DTO actually returns. Null authorId is
 * deidentified attribution and is dropped rather than turned into an invented identity.
 */
export function admitKnowledgePublicResponse(
  status: number,
  body: unknown,
  request: KnowledgeReadRequest,
): KnowledgeReadState {
  if (status !== 200) return outcomeForStatus(status);
  const document = member(body, 'document');
  if (!isRecord(document)) return { state: 'unavailable', status: 502 };
  const documentId = knowledgeId(document.documentId);
  const revisionId = knowledgeId(document.revisionId);
  const publicationId = knowledgeId(document.publicationId);
  const subjectId = knowledgeId(document.subjectId);
  const title = document.title;
  const language = languageOf(document.language);
  const licence = document.licence;
  const published = publishedAt(document.publishedAt);
  const sha256 = document.sha256;
  const subjectIds = uuidList(document.subjectIds);
  const authorId = document.authorId;
  if (
    !documentId ||
    !revisionId ||
    !publicationId ||
    !subjectId ||
    typeof title !== 'string' ||
    title.length < 1 ||
    title.length > 512 ||
    language === undefined ||
    typeof licence !== 'string' ||
    licence.length < 1 ||
    licence.length > 128 ||
    !published ||
    typeof sha256 !== 'string' ||
    !sha256Pattern.test(sha256) ||
    !subjectIds ||
    (authorId !== null && !knowledgeId(authorId)) ||
    typeof document.canonicalBytes !== 'string'
  )
    return { state: 'unavailable', status: 502 };
  if (documentId !== request.documentId) return { state: 'unavailable', status: 502 };
  if (request.revisionId !== null && revisionId !== request.revisionId) return { state: 'unavailable', status: 502 };
  const parsed = decodeCanonicalDocument(document.canonicalBytes);
  if (!parsed) return { state: 'unavailable', status: 502 };
  return {
    state: 'ready',
    document: {
      documentId,
      revisionId,
      publicationId,
      subjectId,
      title,
      language,
      licence,
      publishedAt: published,
      body: parsed,
    },
  };
}

const publicReadFetch = { cache: 'no-store' as const, redirect: 'manual' as const };

/** One anonymous public read of the currently selected publication, optionally pinned to that revision. */
export async function readKnowledgePublicDocument(
  client: KernelClient,
  request: KnowledgeReadRequest,
): Promise<KnowledgeReadState> {
  try {
    const result: KnowledgePublicReadResult = await client.knowledge.documents({ id: request.documentId }).get({
      query: request.revisionId === null ? {} : { revisionId: request.revisionId },
      fetch: publicReadFetch,
    });
    return admitKnowledgePublicResponse(result.status, result.data, request);
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return { state: 'unavailable', status: 503 };
  }
}

export async function copyKnowledgeCitation(
  destination: string,
  clipboard?: KnowledgeCitationClipboard | null,
): Promise<KnowledgeCitationCopyResult> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'unavailable';
  try {
    await clipboard.writeText(destination);
    return 'success';
  } catch (error) {
    return isRecord(error) && error.name === 'NotAllowedError' ? 'denied' : 'unavailable';
  }
}

export const readKnowledgeDocument = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const request = parseKnowledgeReadRequest(input);
    if (!request) throw notFound();
    return request;
  })
  .handler(async ({ data }): Promise<KnowledgeReadState> => {
    const http = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(http, 'private, no-store');
    const page = await readKnowledgePublicDocument(kernelClient(data.locale), data);
    if (page.state === 'denied' || page.state === 'not-found' || page.state === 'unavailable')
      setResponseStatus(page.status);
    return page;
  });
