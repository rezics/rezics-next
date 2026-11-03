import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding } from './cursor.ts';
import {
  readReleaseChildren,
  readReleaseGroups,
  ReleaseGroupingRestartRequired,
  type ReleaseChildContinuation,
  type ReleaseGroup,
  type ReleaseGroupContinuation,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from './release-search-grouping.ts';

export type ReleaseSearchPrincipal = 'anonymous' | `account:${string}`;

export class ReleaseSearchCursorInvalid extends Error {
  constructor() {
    super('invalid_format');
  }
}

type PrivateContinuation = ReleaseGroupContinuation | ReleaseChildContinuation;

export type ReleaseGroupsPage<Work, Release> = {
  status: 'ready' | 'preparing';
  groups: ReleaseGroup<Work, Release>[];
  next: string | null;
};

export type ReleaseChildrenPage<Release> = {
  status: 'ready' | 'preparing';
  children: Release[];
  next: string | null;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function physicalIdentity(value: unknown): boolean {
  return (
    object(value) &&
    Number.isSafeInteger(value.generation) &&
    typeof value.incarnation === 'string' &&
    typeof value.indexUuid === 'string'
  );
}

function continuation(value: unknown, stream: 'groups' | 'children', work?: string): value is PrivateContinuation {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.binding !== 'string' ||
    !value.binding ||
    (value.after !== null && typeof value.after !== 'string') ||
    !object(value.basis) ||
    typeof value.basis.releaseDigest !== 'string' ||
    typeof value.basis.epoch !== 'string' ||
    !physicalIdentity(value.basis.physical) ||
    (value.basis.calendarReadyFor !== null && !physicalIdentity(value.basis.calendarReadyFor))
  )
    return false;
  if (stream === 'children') return typeof work === 'string' && value.work === work;
  if (Object.hasOwn(value, 'work')) return false;
  if (value.pending === undefined) return true;
  return (
    object(value.pending) &&
    typeof value.pending.id === 'string' &&
    value.pending.id.length > 0 &&
    (value.pending.after === null || typeof value.pending.after === 'string')
  );
}

function binding(
  request: ReleaseGroupingRequest,
  principal: ReleaseSearchPrincipal,
  stream: 'groups' | 'children',
  work?: string,
): SearchCursorBinding {
  return {
    operation: `subjects.search.releases.${stream}-v1`,
    principal,
    request: { request, ...(work === undefined ? {} : { work }) },
  };
}

async function decode<Cursor extends PrivateContinuation>(
  ring: KeyRing,
  bound: SearchCursorBinding,
  token: string | undefined,
  stream: 'groups' | 'children',
  now: number,
  work?: string,
): Promise<Cursor | undefined> {
  if (token === undefined) return undefined;
  if (!token) throw new ReleaseSearchCursorInvalid();
  const decoded = await decodeSearchCursor(ring, bound, token, now);
  if (!decoded.ok) {
    if (decoded.reason === 'expired') throw new ReleaseGroupingRestartRequired();
    throw new ReleaseSearchCursorInvalid();
  }
  if (decoded.after.length !== 1 || typeof decoded.after[0] !== 'string') throw new ReleaseSearchCursorInvalid();
  let value: unknown;
  try {
    value = JSON.parse(decoded.after[0]);
  } catch {
    throw new ReleaseSearchCursorInvalid();
  }
  if (!continuation(value, stream, work)) throw new ReleaseSearchCursorInvalid();
  if (value.basis.physical.generation !== decoded.generation) throw new ReleaseGroupingRestartRequired();
  return value as Cursor;
}

async function encode(
  ring: KeyRing,
  bound: SearchCursorBinding,
  value: PrivateContinuation | null,
  now: number,
): Promise<string | null> {
  if (!value) return null;
  return encodeSearchCursor(
    ring,
    bound,
    {
      generation: value.basis.physical.generation,
      after: [JSON.stringify(value)],
    },
    now,
  );
}

/** Wraps the grouping policy's private state in the existing viewer-bound, expiring cursor lifecycle. */
export async function readReleaseGroupsPage<Work, Release>(input: {
  source: ReleaseGroupingSource<Work, Release>;
  request: ReleaseGroupingRequest;
  principal: ReleaseSearchPrincipal;
  cursors: KeyRing;
  cursor?: string;
  now?: number;
}): Promise<ReleaseGroupsPage<Work, Release>> {
  const now = input.now ?? Date.now();
  const bound = binding(input.request, input.principal, 'groups');
  const cursor = await decode<ReleaseGroupContinuation>(input.cursors, bound, input.cursor, 'groups', now);
  const page = await readReleaseGroups(input.source, input.request, cursor);
  return {
    status: page.status,
    groups: page.values,
    next: await encode(input.cursors, bound, page.next, now),
  };
}

/** Child progress has its own request binding and cursor, independent from the group stream. */
export async function readReleaseChildrenPage<Work, Release>(input: {
  source: ReleaseGroupingSource<Work, Release>;
  request: ReleaseGroupingRequest;
  principal: ReleaseSearchPrincipal;
  work: string;
  cursors: KeyRing;
  cursor?: string;
  now?: number;
}): Promise<ReleaseChildrenPage<Release>> {
  const now = input.now ?? Date.now();
  const bound = binding(input.request, input.principal, 'children', input.work);
  const cursor = await decode<ReleaseChildContinuation>(
    input.cursors,
    bound,
    input.cursor,
    'children',
    now,
    input.work,
  );
  const page = await readReleaseChildren(input.source, input.request, input.work, cursor);
  return {
    status: page.status,
    children: page.values,
    next: await encode(input.cursors, bound, page.next, now),
  };
}
