/** Common current-owner query contract. Search preparation remains owned by Search; Library binds its Source. */

import type { PreparedSearchScope } from './capabilities.ts';
import type { LibraryActor } from './actors.ts';
import type { CollectionSourceObservation, PreparedCollectionSource } from './source.ts';
import type { WorkAllowance, WorkReceipt } from './work-dimensions.ts';

export type OwnerQueryFilter = Readonly<{
  prepared: PreparedSearchScope['prepared'];
  work: WorkReceipt;
  scope: PreparedSearchScope['scope'];
}>;

export type OwnerQueryOpen = Readonly<{
  source: PreparedCollectionSource;
  observation: CollectionSourceObservation;
  work: WorkReceipt;
  close(): void;
  originals(subjectId: string): Promise<readonly string[]>;
  filter(filter: unknown, releaseDigest: string): Promise<OwnerQueryFilter>;
}>;

export type OwnerQueryInput = Readonly<{
  actor: LibraryActor;
  collectionId: string;
  deadline: number;
  at?: unknown;
  work: {
    remaining(): WorkAllowance;
    native(receipt: WorkReceipt): void;
    receipt(): WorkReceipt;
    plan?: unknown;
  };
  logical?: boolean;
}>;
