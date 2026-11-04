import type { Release } from '@rezics/definitions';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../../kernel/client';

export type CatalogueFileReaderDefinitions =
  | { ok: true; digest: string; release: Release }
  | { ok: false; reason: 'unavailable' };

/** Read only the current immutable definitions; the ordinary Subject read remains the reader's evidence. */
export const loadCatalogueFileReaderDefinitions = createServerFn({ method: 'GET', strict: false })
  .validator((input?: undefined) => {
    if (input !== undefined) throw new Error('Invalid catalogue file reader request');
    return undefined;
  })
  .handler(async (): Promise<CatalogueFileReaderDefinitions> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const client = kernelClient();
      const active = await client.definitions.active.get();
      if (active.status !== 200 || !active.data?.digest) return { ok: false, reason: 'unavailable' };
      const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
      if (bundle.status !== 200 || !bundle.data || bundle.data.digest !== active.data.digest)
        return { ok: false, reason: 'unavailable' };
      const release = bundle.data.release;
      if (!release.types || !release.properties) return { ok: false, reason: 'unavailable' };
      return { ok: true, digest: active.data.digest, release };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
