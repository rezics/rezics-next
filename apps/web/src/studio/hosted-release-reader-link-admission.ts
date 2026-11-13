import type { KernelClient } from '@rezics/client';
import { createHostedCatalogueApi } from '../books/reader/native-api';
import type { HostedReleaseReaderAddress } from './hosted-release-reader-link';

/** The supplied client must be anonymous. Read only metadata for the confirmed exact release. */
export async function publicHostedReleaseAdmission(
  client: KernelClient,
  address: HostedReleaseReaderAddress,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await createHostedCatalogueApi(client, null, signal).catalogue(address.catalogueId, {
    kind: 'publication',
    revisionId: address.releaseRevisionId,
  });
  return (
    result.state === 'ready' &&
    result.value.catalogueId === address.catalogueId &&
    result.value.kind === 'publication' &&
    result.value.revisionId === address.releaseRevisionId
  );
}
