import type { Pool } from 'pg';
import type { Release } from '@rezics/definitions';
import type { Anchor, LibraryDriver } from '../../../../../specs/library-driver.ts';
import type { WorkClient } from '../../../src/work/client.ts';
import type { Capture } from '../../support/growth.ts';
import { createLibraryDriver } from './outcome-driver.ts';

export type NativePersona =
  | 'owner'
  | 'other'
  | 'anonymous'
  | 'suspended'
  | 'steward'
  | 'ownerReadOnly'
  | 'unscoped'
  | 'libraryOnly'
  | 'progressOnly'
  | 'ungranted';
export type NativeRequest = Parameters<LibraryDriver['request']>[1];
export interface NativeConformanceWorld extends LibraryDriver {
  native: {
    pool: Pool;
    reader: Pool;
    databaseUrl: string;
    steward: Anchor;
    workClient: WorkClient;
    token(persona: Exclude<NativePersona, 'anonymous'>): string;
    request(persona: NativePersona, input: NativeRequest): Promise<Response>;
    rawRequest(
      persona: NativePersona,
      method: string,
      path: string,
      rawJson: string,
      headers?: Record<string, string>,
    ): Promise<Response>;
    subject(type: string, author?: NativePersona): Promise<Anchor>;
    rotateCursorKeys(): Promise<void>;
    hold(): Promise<void>;
    resume(): Promise<void>;
    capture<T>(operation: () => Promise<T>): Promise<{ value: T; capture: Capture }>;
  };
}

/** An absent native observation/producer must fail, never supply a modeled successful result. */
export function unavailable(surface: string): never {
  throw new Error(`Native Library dependency_unavailable: ${surface}`);
}
export const requestKey = () => `"${Bun.randomUUIDv7()}"`;
export async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status)
    throw new Error(`Native fixture HTTP ${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
export function write(
  world: NativeConformanceWorld,
  persona: NativePersona,
  method: NativeRequest['method'],
  path: string,
  body?: unknown,
  key = requestKey(),
) {
  return world.native.request(persona, { method, path, body, headers: { 'Idempotency-Key': key } });
}
export async function publish(world: NativeConformanceWorld, release: Release) {
  const { digest } = await json<{ digest: string }>(
    await write(world, 'steward', 'POST', '/v1/definitions/releases', { release }),
    201,
  );
  const head = await json<{ head: number }>(
    await world.native.request('anonymous', { method: 'GET', path: '/v1/definitions/active' }),
  );
  await json(
    await write(world, 'steward', 'POST', `/v1/definitions/releases/${digest}:activate`, { expected_head: head.head }),
  );
  return digest;
}
export async function worldWithRelease(release: Release) {
  const world = await createLibraryDriver();
  try {
    await publish(world, release);
    return world;
  } catch (error) {
    await world.close();
    throw error;
  }
}
export async function setGate(world: NativeConformanceWorld, gate: string, open: boolean) {
  await json(await write(world, 'steward', 'POST', `/v1/platform/exposure/${gate}:${open ? 'open' : 'close'}`));
}
export async function setEntry(
  world: NativeConformanceWorld,
  persona: NativePersona,
  subjectId: string,
  state: string | null,
) {
  const existing = await world.native.request(persona, { method: 'GET', path: `/v1/libraryEntries/${subjectId}` });
  if (existing.status !== 200 && existing.status !== 404) return existing;
  const guard =
    existing.status === 200
      ? (await json<{ libraryEntry: { revision: number; incarnationId: string } }>(existing)).libraryEntry
      : undefined;
  if (state !== null)
    return write(world, persona, 'PUT', `/v1/libraryEntries/${subjectId}`, {
      state,
      ...(guard ? { revision: guard.revision, incarnationId: guard.incarnationId } : {}),
    });
  const query = new URLSearchParams();
  if (guard) {
    query.set('revision', String(guard.revision));
    query.set('incarnationId', guard.incarnationId);
  }
  return write(world, persona, 'DELETE', `/v1/libraryEntries/${subjectId}?${query}`);
}
export async function addLabel(world: NativeConformanceWorld, subjectId: string, name: string) {
  const { label } = await json<{ label: { id: string } }>(
    await write(world, 'owner', 'POST', '/v1/libraryLabels', { name }),
    201,
  );
  return write(world, 'owner', 'POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId });
}
/** The base fixture has Auth service tokens but no Auth account-operation workflow host. */
export async function deleteAccount(
  _world: NativeConformanceWorld,
  _persona: NativePersona = 'owner',
): Promise<Response> {
  return unavailable('Auth account-operation approve/execute host binding (not a kernel account-delete route)');
}
export async function grantSubjectRead(
  world: NativeConformanceWorld,
  subjectId: string,
  viewer: 'owner' | 'other',
  readable: boolean,
) {
  const resource = { route: (await import('../../../src/route/route.ts')).routeOf(subjectId), id: subjectId };
  await json(
    await write(world, 'steward', 'POST', `/v1/grants${readable ? '' : ':revoke'}`, {
      resource,
      subject: { kind: 'account', id: world.accounts[viewer].id },
      actions: ['subject:read'],
      valid: '(,)',
    }),
    readable ? 201 : 200,
  );
}
