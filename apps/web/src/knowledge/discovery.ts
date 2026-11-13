import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { knowledgeExactHref, knowledgeId } from './public-read';

export const KNOWLEDGE_DISCOVERY_PAGE_LIMIT = 20;
export const KNOWLEDGE_DISCOVERY_CURSOR_MAXIMUM = 4864;
const sha256Pattern = /^[0-9a-f]{64}$/;
const fetchPolicy = { cache: 'no-store' as const, redirect: 'manual' as const };

export type KnowledgeDiscoveryDocument = Readonly<{
  subjectId: string;
  documentId: string;
  publicationId: string;
  revisionId: string;
  publishedAt: string;
  title: string;
  language: string | null;
  licence: string;
  sha256: string;
}>;
export type KnowledgeDiscoveryPage = Readonly<{
  documents: readonly KnowledgeDiscoveryDocument[];
  next: string | null;
}>;
export type KnowledgeDiscoveryRequest = Readonly<{
  subjectId: string;
  cursor: string | null;
  locale: string;
}>;
export type KnowledgeDiscoveryFailure =
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'restart'; status: 409 }
  | { state: 'unavailable'; status: number };
export type KnowledgeDiscoveryRead =
  | { state: 'ready'; page: KnowledgeDiscoveryPage }
  | { state: 'preparing'; next: string }
  | KnowledgeDiscoveryFailure;
export type KnowledgeDiscoveryWire = Readonly<{
  limit: typeof KNOWLEDGE_DISCOVERY_PAGE_LIMIT;
  cursor?: string;
}>;
type KnowledgeDocumentsGet = ReturnType<KernelClient['subjects']>['knowledgeDocuments']['get'];
type KnowledgeDocumentsResult = Awaited<ReturnType<KnowledgeDocumentsGet>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function languageOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  return text(value, 1, 64) ? value : undefined;
}

function publishedAt(value: unknown): string | null {
  if (!text(value, 10, 64)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value);
}

function closed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const documentKeys = [
  'subjectId',
  'documentId',
  'publicationId',
  'revisionId',
  'publishedAt',
  'title',
  'language',
  'licence',
  'sha256',
] as const;

/** Bound one opaque continuation; absent and empty mean the first replacing page. */
export function parseKnowledgeDiscoveryCursor(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  return text(value, 1, KNOWLEDGE_DISCOVERY_CURSOR_MAXIMUM) ? value : undefined;
}

/** HTTP input only: original Subject identity, opaque frontier and the page locale. */
export function parseKnowledgeDiscoveryRequest(value: unknown): KnowledgeDiscoveryRequest | null {
  if (!isRecord(value)) return null;
  const subjectId = knowledgeId(value.subjectId);
  const locale = value.locale;
  const cursor = parseKnowledgeDiscoveryCursor(value.cursor);
  if (!subjectId || typeof locale !== 'string' || locale.length < 1 || locale.length > 64 || cursor === undefined)
    return null;
  return { subjectId, cursor, locale };
}

export function knowledgeDiscoveryWire(cursor: string | null): KnowledgeDiscoveryWire {
  return cursor === null
    ? { limit: KNOWLEDGE_DISCOVERY_PAGE_LIMIT }
    : { limit: KNOWLEDGE_DISCOVERY_PAGE_LIMIT, cursor };
}

function failure(status: number): KnowledgeDiscoveryFailure {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 409) return { state: 'restart', status: 409 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

function admitDocument(value: unknown, subjectId: string): KnowledgeDiscoveryDocument | null {
  if (!isRecord(value) || !closed(value, documentKeys)) return null;
  const rowSubjectId = knowledgeId(value.subjectId);
  const documentId = knowledgeId(value.documentId);
  const publicationId = knowledgeId(value.publicationId);
  const revisionId = knowledgeId(value.revisionId);
  const title = value.title;
  const language = languageOf(value.language);
  const licence = value.licence;
  const published = publishedAt(value.publishedAt);
  if (
    rowSubjectId !== subjectId ||
    !documentId ||
    !publicationId ||
    !revisionId ||
    !text(title, 1, 512) ||
    language === undefined ||
    !text(licence, 1, 128) ||
    !published ||
    !digest(value.sha256)
  )
    return null;
  return {
    subjectId: rowSubjectId,
    documentId,
    publicationId,
    revisionId,
    publishedAt: published,
    title,
    language,
    licence,
    sha256: value.sha256,
  };
}

function pageCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return text(value, 1, KNOWLEDGE_DISCOVERY_CURSOR_MAXIMUM) ? value : undefined;
}

function admitReady(value: unknown, subjectId: string): KnowledgeDiscoveryRead {
  if (!isRecord(value) || value.state !== 'ready') return failure(502);
  const next = pageCursor(value.next);
  const rows = member(value, 'documents');
  if (next === undefined || !Array.isArray(rows) || rows.length > KNOWLEDGE_DISCOVERY_PAGE_LIMIT) return failure(502);
  const documents: KnowledgeDiscoveryDocument[] = [];
  for (const row of rows) {
    const admitted = admitDocument(row, subjectId);
    if (!admitted) return failure(502);
    documents.push(admitted);
  }
  return { state: 'ready', page: { documents, next } };
}

function admitPreparing(value: unknown): KnowledgeDiscoveryRead {
  if (!isRecord(value) || value.state !== 'preparing') return failure(502);
  const next = pageCursor(value.next);
  if (!next) return failure(502);
  return { state: 'preparing', next };
}

/**
 * Admit only the closed public list fields. Author identity, bodies, notebook paths and totals
 * are refused rather than invented or hydrated per row.
 */
export function admitKnowledgeDiscovery(
  status: number,
  body: unknown,
  request: Pick<KnowledgeDiscoveryRequest, 'subjectId'>,
): KnowledgeDiscoveryRead {
  if (status === 202) return admitPreparing(body);
  if (status === 200) return admitReady(body, request.subjectId);
  return failure(status);
}

/** One generated public page. Native order, titles and exact identities are preserved without row reads. */
export async function readKnowledgeDiscovery(
  client: KernelClient,
  request: KnowledgeDiscoveryRequest,
  authorization?: string,
): Promise<KnowledgeDiscoveryRead> {
  const cursor = parseKnowledgeDiscoveryCursor(request.cursor);
  if (!knowledgeId(request.subjectId) || cursor === undefined) return failure(400);
  try {
    const result: KnowledgeDocumentsResult = await client.subjects({ id: request.subjectId }).knowledgeDocuments.get({
      query: knowledgeDiscoveryWire(cursor),
      ...(authorization === undefined ? {} : { headers: { authorization } }),
      fetch: fetchPolicy,
    });
    return admitKnowledgeDiscovery(result.status, result.data, request);
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return failure(503);
  }
}

export function knowledgeDiscoveryExactHref(
  locale: string,
  document: Pick<KnowledgeDiscoveryDocument, 'documentId' | 'revisionId'>,
  returnTo?: string,
): string {
  const href = knowledgeExactHref(locale, document.documentId, document.revisionId);
  if (!returnTo) return href;
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set('returnTo', returnTo);
  return `${url.pathname}${url.search}`;
}
