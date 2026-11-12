import type { KernelClient } from '@rezics/client';
import { NotebookPen } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import type { NavigationContribution } from '../shell/navigation';
import { isKnowledgeId } from './private-knowledge';

export const knowledgeNavigation = {
  id: 'knowledge.owned',
  kind: 'navigation',
  group: 'personal',
  order: 7,
  href: '/knowledge',
  label: ({ locale }) => m.knowledge_navigation_heading({}, { locale }),
  icon: NotebookPen,
  match: 'prefix',
  signedIn: true,
  operation: 'knowledge_notebook.owned_list',
} satisfies NavigationContribution;

export const KNOWLEDGE_NAVIGATION_PAGE_LIMIT = 20;
export const KNOWLEDGE_NAVIGATION_BREADCRUMB_LIMIT = 32;
export const KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM = 4096;

export type KnowledgeOwnedNotebook = Readonly<{
  notebookId: string;
  subjectId: string;
  title: string;
  structureRevisionId: string;
  createdAt: string;
}>;
export type KnowledgeOwnedNotebooksPage = Readonly<{
  notebooks: readonly KnowledgeOwnedNotebook[];
  next: string | null;
}>;
export type KnowledgeOutlinePlacement = Readonly<{
  placementId: string;
  documentId: string;
  parentPlacementId: string | null;
  position: string;
  title: string;
}>;
export type KnowledgeOutlinePage = Readonly<{
  notebookId: string;
  structureRevisionId: string;
  parentPlacementId: string | null;
  placements: readonly KnowledgeOutlinePlacement[];
  next: string | null;
}>;
export type KnowledgeNavigationFailure =
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'not-found'; status: 404 }
  | { state: 'stale'; status: 409 }
  | { state: 'unavailable'; status: number };
export type KnowledgeOwnedNotebooksRead =
  | { state: 'ready'; page: KnowledgeOwnedNotebooksPage }
  | KnowledgeNavigationFailure;
export type KnowledgeOutlineRead = { state: 'ready'; page: KnowledgeOutlinePage } | KnowledgeNavigationFailure;
export type KnowledgeOwnedNotebooksQuery = Readonly<{
  accountId: string;
  cursor: string | null;
  authorization: string;
}>;
export type KnowledgeOutlineQuery = Readonly<{
  accountId: string;
  notebookId: string;
  parentPlacementId: string | null;
  cursor: string | null;
  authorization: string;
}>;
export type KnowledgeBreadcrumb = Readonly<{ placementId: string; title: string }>;
export type KnowledgeOwnedNotebooksWire = Readonly<{ limit: typeof KNOWLEDGE_NAVIGATION_PAGE_LIMIT; cursor?: string }>;
export type KnowledgeOutlineWire = Readonly<{
  limit: typeof KNOWLEDGE_NAVIGATION_PAGE_LIMIT;
  cursor?: string;
  parentPlacementId?: string;
}>;

const positionPattern = /^(?:0|[1-9][0-9]{0,18})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function createdAt(value: unknown): value is string {
  return text(value, 20, 40) && Number.isFinite(Date.parse(value));
}

function cursorToken(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return text(value, 1, KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM) ? value : undefined;
}

function navigationFailure(status: number): KnowledgeNavigationFailure {
  if (status === 401 || status === 403) return { state: 'denied', status };
  if (status === 404) return { state: 'not-found', status: 404 };
  if (status === 409) return { state: 'stale', status: 409 };
  return { state: 'unavailable', status: status >= 400 && status <= 599 ? status : 502 };
}

function readFailure(result: {
  response?: Response;
  status: number;
  error?: unknown;
}): KnowledgeNavigationFailure | null {
  if (!result.response || result.error) return navigationFailure(result.status);
  if (result.status !== 200) return navigationFailure(result.status);
  return null;
}

/** Bound one opaque continuation token; absent and empty mean the first replacing page. */
export function parseKnowledgeNavigationCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return text(value, 1, KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM) ? value : undefined;
}

/** Always limit 20. A supplied cursor is the native opaque token from the previous replacing page. */
export function knowledgeOwnedNotebooksWire(cursor: string | null): KnowledgeOwnedNotebooksWire {
  return cursor === null
    ? { limit: KNOWLEDGE_NAVIGATION_PAGE_LIMIT }
    : { limit: KNOWLEDGE_NAVIGATION_PAGE_LIMIT, cursor };
}

/** Root omits parentPlacementId. Nested reads send the explicitly chosen placement. */
export function knowledgeOutlineWire(parentPlacementId: string | null, cursor: string | null): KnowledgeOutlineWire {
  return {
    limit: KNOWLEDGE_NAVIGATION_PAGE_LIMIT,
    ...(cursor === null ? {} : { cursor }),
    ...(parentPlacementId === null ? {} : { parentPlacementId }),
  };
}

function admitNotebook(value: unknown): KnowledgeOwnedNotebook | null {
  if (
    !isRecord(value) ||
    !isKnowledgeId(value.notebookId) ||
    !isKnowledgeId(value.subjectId) ||
    !isKnowledgeId(value.structureRevisionId) ||
    !text(value.title, 1, 256) ||
    !createdAt(value.createdAt)
  )
    return null;
  return {
    notebookId: value.notebookId,
    subjectId: value.subjectId,
    title: value.title,
    structureRevisionId: value.structureRevisionId,
    createdAt: value.createdAt,
  };
}

function admitPlacement(value: unknown, expectedParent: string | null): KnowledgeOutlinePlacement | null {
  const parentPlacementId = member(value, 'parentPlacementId');
  if (
    !isRecord(value) ||
    !isKnowledgeId(value.placementId) ||
    !isKnowledgeId(value.documentId) ||
    !(parentPlacementId === null || isKnowledgeId(parentPlacementId)) ||
    parentPlacementId !== expectedParent ||
    typeof value.position !== 'string' ||
    !positionPattern.test(value.position) ||
    !text(value.title, 1, 512)
  )
    return null;
  return {
    placementId: value.placementId,
    documentId: value.documentId,
    parentPlacementId,
    position: value.position,
    title: value.title,
  };
}

/** Admit one replacing owned-notebook page. Extra rows or a malformed continuation are unavailable. */
export function admitKnowledgeOwnedNotebooks(status: number, value: unknown): KnowledgeOwnedNotebooksRead {
  if (status !== 200) return navigationFailure(status);
  const next = cursorToken(member(value, 'next'));
  const rows = member(value, 'notebooks');
  if (!Array.isArray(rows) || rows.length > KNOWLEDGE_NAVIGATION_PAGE_LIMIT || next === undefined)
    return { state: 'unavailable', status: 502 };
  const notebooks: KnowledgeOwnedNotebook[] = [];
  for (const row of rows) {
    const admitted = admitNotebook(row);
    if (!admitted) return { state: 'unavailable', status: 502 };
    notebooks.push(admitted);
  }
  return { state: 'ready', page: { notebooks, next } };
}

/** Admit one replacing outline page against the requested notebook and parent. */
export function admitKnowledgeOutline(
  status: number,
  value: unknown,
  query: Pick<KnowledgeOutlineQuery, 'notebookId' | 'parentPlacementId'>,
): KnowledgeOutlineRead {
  if (status !== 200) return navigationFailure(status);
  const notebookId = member(value, 'notebookId');
  const structureRevisionId = member(value, 'structureRevisionId');
  const parentPlacementId = member(value, 'parentPlacementId');
  const next = cursorToken(member(value, 'next'));
  const rows = member(value, 'placements');
  if (
    notebookId !== query.notebookId ||
    parentPlacementId !== query.parentPlacementId ||
    !isKnowledgeId(notebookId) ||
    !isKnowledgeId(structureRevisionId) ||
    !(parentPlacementId === null || isKnowledgeId(parentPlacementId)) ||
    !Array.isArray(rows) ||
    rows.length > KNOWLEDGE_NAVIGATION_PAGE_LIMIT ||
    next === undefined
  )
    return { state: 'unavailable', status: 502 };
  const placements: KnowledgeOutlinePlacement[] = [];
  for (const row of rows) {
    const admitted = admitPlacement(row, query.parentPlacementId);
    if (!admitted) return { state: 'unavailable', status: 502 };
    placements.push(admitted);
  }
  return {
    state: 'ready',
    page: { notebookId, structureRevisionId, parentPlacementId, placements, next },
  };
}

const fetchPolicy = { cache: 'no-store' as const, redirect: 'manual' as const };

/** Current-viewer owned notebooks only. One Open/More/Retry reads one replacing page. */
export async function readKnowledgeOwnedNotebooks(
  client: KernelClient,
  input: KnowledgeOwnedNotebooksQuery,
): Promise<KnowledgeOwnedNotebooksRead> {
  if (!isKnowledgeId(input.accountId)) return { state: 'unavailable', status: 502 };
  const cursor = parseKnowledgeNavigationCursor(input.cursor);
  if (cursor === undefined) return { state: 'unavailable', status: 400 };
  const result = await client.accounts({ accountId: input.accountId }).knowledge.notebooks.get({
    query: knowledgeOwnedNotebooksWire(cursor),
    headers: { authorization: input.authorization },
    fetch: fetchPolicy,
  });
  const failed = readFailure(result);
  if (failed) return failed;
  return admitKnowledgeOwnedNotebooks(result.status, result.data);
}

/** Immediate children of root or one explicitly chosen parent. Sparse next remains a continuation. */
export async function readKnowledgeOutline(
  client: KernelClient,
  input: KnowledgeOutlineQuery,
): Promise<KnowledgeOutlineRead> {
  if (
    !isKnowledgeId(input.accountId) ||
    !isKnowledgeId(input.notebookId) ||
    !(input.parentPlacementId === null || isKnowledgeId(input.parentPlacementId))
  )
    return { state: 'unavailable', status: 502 };
  const cursor = parseKnowledgeNavigationCursor(input.cursor);
  if (cursor === undefined) return { state: 'unavailable', status: 400 };
  const result = await client
    .accounts({ accountId: input.accountId })
    .knowledge.notebooks({ notebookId: input.notebookId })
    .outline.get({
      query: knowledgeOutlineWire(input.parentPlacementId, cursor),
      headers: { authorization: input.authorization },
      fetch: fetchPolicy,
    });
  const failed = readFailure(result);
  if (failed) return failed;
  return admitKnowledgeOutline(result.status, result.data, input);
}

/** Most-recent visited placements, never reconstructed ancestry. Cap 32. */
export function pushKnowledgeBreadcrumb(
  trail: readonly KnowledgeBreadcrumb[],
  next: KnowledgeBreadcrumb,
): KnowledgeBreadcrumb[] {
  const without = trail.filter((item) => item.placementId !== next.placementId);
  const combined = [...without, next];
  return combined.length <= KNOWLEDGE_NAVIGATION_BREADCRUMB_LIMIT
    ? combined
    : combined.slice(combined.length - KNOWLEDGE_NAVIGATION_BREADCRUMB_LIMIT);
}

export function popKnowledgeBreadcrumb(trail: readonly KnowledgeBreadcrumb[]): {
  trail: KnowledgeBreadcrumb[];
  parentPlacementId: string | null;
} {
  const next = trail.slice(0, -1);
  return { trail: next, parentPlacementId: next.at(-1)?.placementId ?? null };
}

export function sameKnowledgeOwnedNotebooksQuery(
  left: Pick<KnowledgeOwnedNotebooksQuery, 'accountId' | 'cursor'>,
  right: Pick<KnowledgeOwnedNotebooksQuery, 'accountId' | 'cursor'>,
): boolean {
  return left.accountId === right.accountId && left.cursor === right.cursor;
}

export function sameKnowledgeOutlineQuery(
  left: Pick<KnowledgeOutlineQuery, 'accountId' | 'notebookId' | 'parentPlacementId' | 'cursor'>,
  right: Pick<KnowledgeOutlineQuery, 'accountId' | 'notebookId' | 'parentPlacementId' | 'cursor'>,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.notebookId === right.notebookId &&
    left.parentPlacementId === right.parentPlacementId &&
    left.cursor === right.cursor
  );
}
