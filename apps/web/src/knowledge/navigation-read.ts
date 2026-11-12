import type { KernelClient } from '@rezics/client';
import { isKnowledgeId } from './private-knowledge';

export type KnowledgeNavigationAddress =
  | { kind: 'owned' }
  | { kind: 'outline'; notebookId: string; parentPlacementId: string | null };
export type KnowledgeNavigationRequest = KnowledgeNavigationAddress & { cursor?: string };
export type KnowledgeNotebookRow = Readonly<{
  notebookId: string;
  subjectId: string;
  title: string;
  structureRevisionId: string;
  createdAt: string;
}>;
export type KnowledgePlacementRow = Readonly<{
  placementId: string;
  documentId: string;
  parentPlacementId: string | null;
  position: string;
  title: string;
}>;
export type KnowledgeNavigationPage =
  | { kind: 'owned'; notebooks: readonly KnowledgeNotebookRow[]; next: string | null }
  | {
      kind: 'outline';
      notebookId: string;
      parentPlacementId: string | null;
      structureRevisionId: string;
      placements: readonly KnowledgePlacementRow[];
      next: string | null;
    };
export type KnowledgeNavigationResult =
  | { state: 'ready'; page: KnowledgeNavigationPage }
  | { state: 'denied' | 'unavailable' | 'changed' | 'signed-out' | 'retired' };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const cursor = (v: unknown): v is string | null => v === null || text(v, 4096);

/** The POST BFF boundary accepts addresses and opaque frontiers, never an account operand. */
export function parseKnowledgeNavigationRequest(value: unknown): KnowledgeNavigationRequest | null {
  if (!record(value) || (value.cursor !== undefined && !text(value.cursor, 4096))) return null;
  const frontier = value.cursor === undefined ? {} : { cursor: value.cursor as string };
  if (value.kind === 'owned') return { kind: 'owned', ...frontier };
  if (value.kind !== 'outline' || !isKnowledgeId(value.notebookId)) return null;
  if (value.parentPlacementId !== null && !isKnowledgeId(value.parentPlacementId)) return null;
  return { kind: 'outline', notebookId: value.notebookId, parentPlacementId: value.parentPlacementId, ...frontier };
}

/** Validate third-party rows before making them actionable. Preserve source order and placement identity. */
export function admitKnowledgeNavigationPage(
  status: number,
  value: unknown,
  request: KnowledgeNavigationRequest,
): KnowledgeNavigationResult {
  if (status === 401 || status === 403) return { state: 'denied' };
  if (status === 409 || (status === 404 && request.kind === 'outline')) return { state: 'changed' };
  if (status !== 200 || !record(value) || !cursor(value.next)) return { state: 'unavailable' };
  if (request.kind === 'owned') {
    if (!Array.isArray(value.notebooks) || value.notebooks.length > 20) return { state: 'unavailable' };
    const notebooks: KnowledgeNotebookRow[] = [];
    for (const row of value.notebooks) {
      if (
        !record(row) ||
        !isKnowledgeId(row.notebookId) ||
        !isKnowledgeId(row.subjectId) ||
        !isKnowledgeId(row.structureRevisionId) ||
        !text(row.title, 256) ||
        typeof row.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(row.createdAt))
      )
        return { state: 'unavailable' };
      notebooks.push({
        notebookId: row.notebookId,
        subjectId: row.subjectId,
        structureRevisionId: row.structureRevisionId,
        title: row.title,
        createdAt: row.createdAt,
      });
    }
    return { state: 'ready', page: { kind: 'owned', notebooks, next: value.next } };
  }
  if (
    value.notebookId !== request.notebookId ||
    value.parentPlacementId !== request.parentPlacementId ||
    !isKnowledgeId(value.structureRevisionId) ||
    !Array.isArray(value.placements) ||
    value.placements.length > 20
  )
    return { state: 'unavailable' };
  const placements: KnowledgePlacementRow[] = [];
  for (const row of value.placements) {
    if (
      !record(row) ||
      !isKnowledgeId(row.placementId) ||
      !isKnowledgeId(row.documentId) ||
      row.parentPlacementId !== request.parentPlacementId ||
      !text(row.title, 512) ||
      typeof row.position !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,37})$/.test(row.position)
    )
      return { state: 'unavailable' };
    placements.push({
      placementId: row.placementId,
      documentId: row.documentId,
      parentPlacementId: request.parentPlacementId,
      title: row.title,
      position: row.position,
    });
  }
  return {
    state: 'ready',
    page: {
      kind: 'outline',
      notebookId: request.notebookId,
      parentPlacementId: request.parentPlacementId,
      structureRevisionId: value.structureRevisionId,
      placements,
      next: value.next,
    },
  };
}

/** Exactly one generated native GET per admitted request; no refill, document lookup or authority fan-out. */
export async function readKnowledgeNavigation(
  client: KernelClient,
  input: { accountId: string; authorization: string; request: KnowledgeNavigationRequest },
): Promise<KnowledgeNavigationResult> {
  const { request } = input;
  const options = {
    query: { limit: 20, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
    headers: { authorization: input.authorization },
    fetch: { cache: 'no-store', redirect: 'manual' } as const,
  };
  const notebooks = client.accounts({ accountId: input.accountId }).knowledge.notebooks;
  const result =
    request.kind === 'owned'
      ? await notebooks.get(options)
      : await notebooks({ notebookId: request.notebookId }).outline.get({
          ...options,
          query: {
            ...options.query,
            ...(request.parentPlacementId === null ? {} : { parentPlacementId: request.parentPlacementId }),
          },
        });
  return admitKnowledgeNavigationPage(result.status, result.data, request);
}
