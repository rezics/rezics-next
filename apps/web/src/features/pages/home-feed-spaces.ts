import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../../kernel/platform-closed';

type NativeSpace = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['spaces']>['get']>>['data']>['space'];
export type HomeSpace = Pick<NativeSpace, 'spaceId' | 'title' | 'address' | 'headRevisionId' | 'realmId'>;
export type HomeSpaceRequest = { address: string; spaceId?: never } | { spaceId: string; address?: never };
export type HomeSpaceResult =
  | { status: 'ready'; space: HomeSpace }
  | { status: 'invalid' | 'unavailable' | 'denied' | 'auth' | 'closed' };
export type HomeSpaceReader = (input: HomeSpaceRequest, signal: AbortSignal) => Promise<HomeSpaceResult>;

export function homeFeedId(value: unknown): string | undefined {
  if (value === undefined) return;
  return v.parse(v.pipe(v.string(), v.uuid()), value);
}

/** URL admission only. Native address admission and normalization remain with spaceAddresses. */
export function homeSpaceAddress(value: string, origin: string): string {
  if (!value || value.length > 2048 || value !== value.trim()) throw new Error('Invalid Space address');
  if (!value.includes('/') && !value.includes(':') && !/[?#\\]/u.test(value)) return value;
  if (value.includes('\\')) throw new Error('Invalid Space URL');
  const url = new URL(value, origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid Space URL');
  const match = /^\/spaces\/([^/]+)$/u.exec(url.pathname);
  if (!match) throw new Error('Invalid Space URL');
  const address = decodeURIComponent(match[1]!);
  if (!address || /[/\\?#:]/u.test(address)) throw new Error('Invalid Space address');
  return address;
}

/** <=1 exact resolution +1 point; refresh is exactly one point. Never loads the Space page/Realm. */
export async function readHomeSpace(
  client: KernelClient,
  input: HomeSpaceRequest,
  authorization?: string,
  signal?: AbortSignal,
): Promise<HomeSpaceResult> {
  const options = {
    ...(authorization ? { headers: { authorization } } : {}),
    fetch: { cache: 'no-store' as const, redirect: 'manual' as const, ...(signal ? { signal } : {}) },
  };
  const failure = (status: number): HomeSpaceResult => ({
    status:
      status === 401
        ? 'auth'
        : status === 403
          ? 'denied'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable',
  });
  try {
    let spaceId = input.spaceId;
    if (spaceId === undefined) {
      const resolved = await client.spaceAddresses({ address: input.address }).get(options);
      if (resolved.status !== 200 || resolved.error || !resolved.data) return failure(resolved.status);
      spaceId = homeFeedId(resolved.data.spaceId)!;
    }
    if (signal?.aborted) return { status: 'unavailable' };
    const result = await client.spaces({ spaceId }).get(options);
    if (result.status !== 200 || result.error || !result.data) return failure(result.status);
    const space = result.data.space;
    if (
      space.spaceId !== spaceId ||
      space.state !== 'active' ||
      !space.realmId ||
      !homeFeedId(space.spaceId) ||
      !homeFeedId(space.headRevisionId) ||
      !homeFeedId(space.realmId) ||
      typeof space.title !== 'string' ||
      (space.address !== null && typeof space.address !== 'string')
    )
      return { status: 'unavailable' };
    return {
      status: 'ready',
      space: {
        spaceId: space.spaceId,
        title: space.title,
        address: space.address,
        headRevisionId: space.headRevisionId,
        realmId: space.realmId,
      },
    };
  } catch (error) {
    return { status: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** realmId is viewer-derived and independent of head/ETag. This is UI identity, never native authority. */
export function homeSpaceGeneration(space: HomeSpace): string {
  return JSON.stringify([space.spaceId, space.headRevisionId, space.realmId]);
}

type Snapshot = {
  status: HomeSpaceResult['status'] | 'idle' | 'loading';
  selected?: HomeSpace | undefined;
  candidate?: HomeSpace | undefined;
  available: boolean;
  changed: boolean;
};
/** One reviewed result and one selection. All lookup/point work belongs to a cancellable local generation. */
export function createHomeSpaceSelection(
  read: HomeSpaceReader,
  onSelection: (space: HomeSpace | undefined, available: boolean) => void,
) {
  let snapshot: Snapshot = { status: 'idle', available: true, changed: false };
  let generation = 0;
  let pending: AbortController | undefined;
  let attempted: HomeSpaceRequest | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const retire = () => {
    generation++;
    pending?.abort();
    pending = undefined;
  };
  const load = async (input: HomeSpaceRequest) => {
    retire();
    attempted = input;
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    const refreshing = input.spaceId !== undefined && snapshot.selected?.spaceId === input.spaceId;
    snapshot = { ...snapshot, candidate: undefined, status: 'loading', ...(refreshing ? { available: false } : {}) };
    if (refreshing) onSelection(snapshot.selected, false);
    emit();
    let result: HomeSpaceResult;
    try {
      result = await read(input, controller.signal);
    } catch {
      result = { status: 'unavailable' };
    }
    if (generation !== current) return;
    pending = undefined;
    if (refreshing) {
      if (result.status === 'ready') {
        const changed = homeSpaceGeneration(snapshot.selected!) !== homeSpaceGeneration(result.space);
        snapshot = { status: 'ready', selected: result.space, available: true, changed };
      } else snapshot = { ...snapshot, status: result.status, available: false };
      onSelection(snapshot.selected, snapshot.available);
    } else
      snapshot = {
        ...snapshot,
        status: result.status,
        candidate: result.status === 'ready' ? result.space : undefined,
      };
    emit();
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retire: () => {
      retire();
      snapshot = {
        ...snapshot,
        candidate: undefined,
        status: snapshot.selected && !snapshot.available ? 'unavailable' : 'idle',
      };
      emit();
    },
    lookup: (value: string, origin: string) => {
      let address: string;
      try {
        address = homeSpaceAddress(value, origin);
      } catch {
        retire();
        attempted = undefined;
        snapshot = { ...snapshot, candidate: undefined, status: 'invalid' };
        emit();
        return;
      }
      return load({ address });
    },
    select: () => {
      if (!snapshot.candidate || snapshot.status !== 'ready') return;
      retire();
      snapshot = { status: 'ready', selected: snapshot.candidate, available: true, changed: false };
      onSelection(snapshot.selected, true);
      emit();
    },
    refresh: () => (snapshot.selected ? load({ spaceId: snapshot.selected.spaceId }) : undefined),
    retry: () => (attempted ? load(attempted) : undefined),
    clear: () => {
      retire();
      attempted = undefined;
      snapshot = { status: 'idle', available: true, changed: false };
      onSelection(undefined, true);
      emit();
    },
  };
}
