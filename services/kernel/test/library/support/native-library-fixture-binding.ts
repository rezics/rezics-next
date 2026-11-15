import {
  bindLibraryDomain,
  composeLibraryDomain,
  peekLibraryDomain,
  unbindLibraryDomain,
} from '../../../src/composition/library.ts';
import { bindLibraryPresentation, peekLibraryPresentation } from '../../../src/library/domain-binding.ts';
import type { Pool } from 'pg';
import { createWorkClient } from '../../../src/work/client.ts';
import { bindExecutionContract } from '../../../src/command/execution-contract.ts';
import { workExecutionPort } from '../../../src/work/selected-runtime.ts';
import { historyExecutionPort } from '../../../src/history/application/index.ts';

/** Direct native services receive the same real execution ports as Kernel composition. */
export async function createNativeLibraryWorkClient(pool: Pool) {
  const url = pool.options.connectionString;
  if (!url) throw new TypeError('Native Library WorkClient requires its fixture database URL');
  const client = await createWorkClient(url, pool);
  try {
    return bindExecutionContract(client, workExecutionPort(), historyExecutionPort);
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** Install real Library producers for an Access fixture and restore only the binding it owns. */
export function bindNativeLibraryFixture(options: Parameters<typeof composeLibraryDomain>[0]): () => void {
  const previousDomain = peekLibraryDomain();
  const previousPresentation = peekLibraryPresentation();
  const installed = composeLibraryDomain(options);
  return () => {
    if (peekLibraryDomain() !== installed) return;
    if (previousDomain) bindLibraryDomain(previousDomain);
    else {
      unbindLibraryDomain();
      if (previousPresentation) bindLibraryPresentation(previousPresentation);
    }
  };
}
