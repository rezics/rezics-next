/** Zone-owned Collection work and mounted-read vocabulary. Library implements this at composition. */

import type { TSchema } from 'typebox';
import type { Pool } from 'pg';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type ZoneCollectionWorkHost = {
  readonly initial: WorkAllowance;
  readonly deadline: number;
  remaining(): WorkAllowance;
  consume(receipt: WorkReceipt): void;
  bounded<T>(
    allowance: WorkAllowance,
    cost: Partial<WorkDimensions>,
    operation: () => Promise<T>,
    actual: ((result: T) => Partial<WorkDimensions>) | undefined,
    take: (receipt: WorkReceipt) => void,
  ): Promise<T>;
  isReceipt(value: unknown): value is WorkReceipt;
};

/** Current Collection owner projection used by Zone mounts and configuration admission. */
export type ZoneCollectionProjection = {
  readonly id: string;
  readonly revision: number;
  readonly membershipKind?: 'curated' | 'dynamic';
  readonly allowedVisibilityActions?: readonly ('private' | 'unlisted' | 'public')[];
  readonly title?: string | null;
  readonly description?: string | null;
  readonly visibility?: 'private' | 'unlisted' | 'public';
  readonly curatorAccountId?: string | null;
  readonly memberCount?: number;
  readonly orderEpoch?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly presentationKind?: string | null;
  readonly presentationKindSource?: string;
  readonly cover?: unknown;
  readonly coverSource?: string;
  readonly coverMediaId?: string | null;
  readonly attribution?: unknown;
  readonly generation?: string;
  readonly subjectIds?: readonly string[];
  readonly builtinKind?: 'everything' | 'state' | 'liked';
  readonly builtin?: unknown;
  readonly builtinLabels?: Readonly<Record<string, string>>;
};

/** Safe public Collection summary: the owner projection without editor visibility actions. */
export type ZoneCollectionPublicView = Omit<ZoneCollectionProjection, 'allowedVisibilityActions'> & {
  readonly id: string;
};

export type ZoneCollectionReadDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
};

export type ZoneCollectionReads = {
  readCollection(actor: Actor, id: string, deadline: number): Promise<ZoneCollectionProjection>;
  projectPublic(value: ZoneCollectionProjection): ZoneCollectionPublicView;
  isConcealed(error: unknown): boolean;
};

export type ZoneCollectionPort = {
  createWork(initial: WorkAllowance, deadline: number): ZoneCollectionWorkHost;
  reads(dependencies: ZoneCollectionReadDependencies): ZoneCollectionReads;
  resourceSchema(): TSchema;
};

let bound: ZoneCollectionPort | undefined;

export function bindZoneCollectionPort(port: ZoneCollectionPort): ZoneCollectionPort {
  bound = port;
  return port;
}

export function peekZoneCollectionPort(): ZoneCollectionPort | undefined {
  return bound;
}

export function requireZoneCollectionPort(): ZoneCollectionPort {
  if (!bound) throw new TypeError('Zone collection port is not composed');
  return bound;
}

export function unbindZoneCollectionPort(): void {
  bound = undefined;
}

export function zoneCollectionResourceSchema(): TSchema {
  return requireZoneCollectionPort().resourceSchema();
}

export function zoneCollectionReads(dependencies: ZoneCollectionReadDependencies): ZoneCollectionReads {
  return requireZoneCollectionPort().reads(dependencies);
}

export function createZoneCollectionWork(initial: WorkAllowance, deadline: number): ZoneCollectionWorkHost {
  return requireZoneCollectionPort().createWork(initial, deadline);
}
