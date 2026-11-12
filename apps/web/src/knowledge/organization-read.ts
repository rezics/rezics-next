import type { KernelClient } from '@rezics/client';
import { isKnowledgeId } from './private-knowledge';
import { admitKnowledgeNavigationPage, readKnowledgeNavigation, type KnowledgePlacementRow } from './navigation-read';

export type OrganizationRequest = Readonly<
  { notebookId: string; cursor?: string | undefined } & (
    | { kind: 'outline'; parentPlacementId: string | null }
    | { kind: 'historical'; parentPlacementId: string | null; revisionId: string }
    | { kind: 'history' }
  )
>;
export type OrganizationChange = Readonly<{
  placementId: string;
  action: 'placement_added' | 'placement_moved' | 'placement_reordered' | 'order_rebalanced';
  previousParentPlacementId: string | null;
  previousPosition: string | null;
  parentPlacementId: string | null;
  position: string;
}>;
export type OrganizationRevision = Readonly<{
  structureRevisionId: string;
  revisionNumber: string;
  historyAvailable: boolean;
  changeKind:
    | 'legacy'
    | 'baseline'
    | 'notebook_created'
    | 'placement_added'
    | 'placement_moved'
    | 'placement_reordered';
  createdAt: string;
  changes: readonly OrganizationChange[];
}>;
export type OrganizationOutline = Readonly<{
  kind: 'outline' | 'historical';
  notebookId: string;
  parentPlacementId: string | null;
  structureRevisionId: string;
  placements: readonly KnowledgePlacementRow[];
  next: string | null;
}>;
export type OrganizationPage =
  | OrganizationOutline
  | Readonly<{
      kind: 'history';
      notebookId: string;
      revisions: readonly OrganizationRevision[];
      next: string | null;
    }>;
export type OrganizationReadResult =
  | { state: 'ready'; page: OrganizationPage }
  | { state: 'denied' | 'unavailable' | 'changed' | 'signed-out' | 'retired' };
export type OrganizationBinding = Readonly<{ viewer: string; csrfToken: string; credential: string }>;
export type OrganizationIntent = Readonly<{
  notebookId: string;
  placementId: string;
  expectedStructureRevisionId: string;
  destinationParentPlacementId: string | null;
  beforePlacementId: string | null;
  idempotencyKey: string;
  binding: OrganizationBinding;
}>;
export type OrganizationReceipt = Readonly<{ notebookId: string; placementId: string; structureRevisionId: string }>;
export type OrganizationMoveResult =
  | { state: 'acknowledged'; receipt: OrganizationReceipt }
  | { state: 'uncertain' | 'conflict' | 'rejected' | 'denied' | 'unavailable' | 'signed-out' | 'retired' };
export type OrganizationOperations = Readonly<{
  read: (request: OrganizationRequest) => Promise<OrganizationReadResult>;
  prepare: () => Promise<
    { state: 'ready'; binding: OrganizationBinding } | { state: 'signed-out' | 'unavailable' | 'retired' }
  >;
  move: (intent: OrganizationIntent) => Promise<OrganizationMoveResult>;
}>;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableId = (v: unknown): v is string | null => v === null || isKnowledgeId(v);
const position = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,37})$/.test(v);
const next = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096);
const kinds = ['legacy', 'baseline', 'notebook_created', 'placement_added', 'placement_moved', 'placement_reordered'];
const actions = ['placement_added', 'placement_moved', 'placement_reordered', 'order_rebalanced'];

export function parseOrganizationRequest(value: unknown): OrganizationRequest | null {
  if (
    !record(value) ||
    !isKnowledgeId(value.notebookId) ||
    (value.cursor !== undefined && (value.cursor === null || !next(value.cursor)))
  )
    return null;
  const base = {
    notebookId: value.notebookId,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
  };
  if (value.kind === 'history') return { ...base, kind: 'history' };
  if (!nullableId(value.parentPlacementId)) return null;
  if (value.kind === 'outline') return { ...base, kind: 'outline', parentPlacementId: value.parentPlacementId };
  if (value.kind === 'historical' && isKnowledgeId(value.revisionId))
    return { ...base, kind: 'historical', revisionId: value.revisionId, parentPlacementId: value.parentPlacementId };
  return null;
}

/** Only the third-party HTTP response is decoded; history never becomes command authority. */
export function admitOrganizationPage(
  status: number,
  value: unknown,
  request: OrganizationRequest,
): OrganizationReadResult {
  if (request.kind !== 'history') {
    const result = admitKnowledgeNavigationPage(status, value, { ...request, kind: 'outline' });
    if (result.state !== 'ready') return result;
    const page = result.page as OrganizationOutline;
    if (request.kind === 'historical' && page.structureRevisionId !== request.revisionId)
      return { state: 'unavailable' };
    return { state: 'ready', page: { ...page, kind: request.kind } };
  }
  if (status === 401 || status === 403) return { state: 'denied' };
  if (status === 404 || status === 409) return { state: 'changed' };
  if (
    status !== 200 ||
    !record(value) ||
    value.notebookId !== request.notebookId ||
    !next(value.next) ||
    !Array.isArray(value.revisions) ||
    value.revisions.length > 20
  )
    return { state: 'unavailable' };
  const revisions: OrganizationRevision[] = [];
  for (const row of value.revisions) {
    if (
      !record(row) ||
      !isKnowledgeId(row.structureRevisionId) ||
      typeof row.revisionNumber !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(row.revisionNumber) ||
      typeof row.historyAvailable !== 'boolean' ||
      !kinds.includes(row.changeKind as string) ||
      typeof row.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      !Array.isArray(row.changes) ||
      row.changes.length > 129
    )
      return { state: 'unavailable' };
    const changes: OrganizationChange[] = [];
    for (const change of row.changes) {
      if (
        !record(change) ||
        !isKnowledgeId(change.placementId) ||
        !actions.includes(change.action as string) ||
        !nullableId(change.previousParentPlacementId) ||
        !nullableId(change.parentPlacementId) ||
        !(change.previousPosition === null || position(change.previousPosition)) ||
        !position(change.position)
      )
        return { state: 'unavailable' };
      changes.push(change as OrganizationChange);
    }
    revisions.push({ ...row, changes } as OrganizationRevision);
  }
  return { state: 'ready', page: { kind: 'history', notebookId: request.notebookId, revisions, next: value.next } };
}

export async function readOrganization(
  client: KernelClient,
  input: { accountId: string; authorization: string; request: OrganizationRequest },
): Promise<OrganizationReadResult> {
  const { request } = input;
  if (request.kind === 'outline')
    return (await readKnowledgeNavigation(client, { ...input, request })) as OrganizationReadResult;
  const notebook = client
    .accounts({ accountId: input.accountId })
    .knowledge.notebooks({ notebookId: request.notebookId });
  const options = {
    query: { limit: 20, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
    headers: { authorization: input.authorization },
    fetch: { cache: 'no-store', redirect: 'manual' } as const,
  };
  const result =
    request.kind === 'history'
      ? await notebook.history.get(options)
      : await notebook.outline.get({
          ...options,
          query: {
            ...options.query,
            revisionId: request.revisionId,
            ...(request.parentPlacementId === null ? {} : { parentPlacementId: request.parentPlacementId }),
          },
        });
  return admitOrganizationPage(result.status, result.data, request);
}

export async function moveOrganizationPlacement(
  client: KernelClient,
  input: Omit<OrganizationIntent, 'binding'> & { authorization: string },
): Promise<OrganizationMoveResult> {
  const result = await client.knowledge
    .notebooks({ id: input.notebookId })
    .placements({ placementId: input.placementId })
    .$move.post(
      {
        expectedStructureRevisionId: input.expectedStructureRevisionId,
        destinationParentPlacementId: input.destinationParentPlacementId,
        beforePlacementId: input.beforePlacementId,
      },
      {
        headers: { authorization: input.authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) },
        fetch: { cache: 'no-store', redirect: 'manual' },
      },
    );
  if (!result.response || result.status >= 500) return { state: 'uncertain' };
  if (result.status === 401 || result.status === 403) return { state: 'denied' };
  if (result.status === 412) return { state: 'conflict' };
  if (result.status !== 200 || result.error) return { state: 'rejected' };
  const value = result.data;
  if (
    !value ||
    value.notebookId !== input.notebookId ||
    value.placementId !== input.placementId ||
    !isKnowledgeId(value.structureRevisionId)
  )
    return { state: 'uncertain' };
  return {
    state: 'acknowledged',
    receipt: {
      notebookId: value.notebookId,
      placementId: value.placementId,
      structureRevisionId: value.structureRevisionId,
    },
  };
}
