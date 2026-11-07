/** Low-level callers retain a native default; process composition supplies the same application and effects. */
import { createCollectionMutationApplication } from './application/index.ts';
import { createNativeCollectionMutationPorts } from './adapters/collection-mutation.ts';
import { peekLibraryDomain } from './domain-binding.ts';
import type { PoolClient } from 'pg';
import type { CollectionMutationApplication } from './contract/index.ts';

type Client = Pick<PoolClient, 'query'>;
let native: CollectionMutationApplication<Client> | undefined;

export function collectionMutationApplication(): CollectionMutationApplication<Client> {
  const composed = peekLibraryDomain()?.collectionMutations;
  if (composed) return composed;
  return (native ??= createCollectionMutationApplication(createNativeCollectionMutationPorts()));
}
