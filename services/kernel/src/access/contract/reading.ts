import type { AccessPool } from './vocabulary.ts';

/** Successful absence is unknown, never deleted; a failed batch has no identity evidence. */
export type AccessReadingIdentity =
  | Readonly<{ id: string; state: 'active'; handle: string | null }>
  | Readonly<{ id: string; state: 'deleted' | 'unknown' }>;
export type AccessReadingObservation<T> = Readonly<{ state: 'current'; value: T }> | Readonly<{ state: 'unavailable' }>;
export type AccessReadingPorts = Readonly<{
  observe<T>(read: () => Promise<T>, deadline?: number): Promise<AccessReadingObservation<T>>;
  identities(
    pool: AccessPool,
    ids: readonly string[],
    deadline?: number,
  ): Promise<AccessReadingObservation<readonly AccessReadingIdentity[]>>;
}>;
