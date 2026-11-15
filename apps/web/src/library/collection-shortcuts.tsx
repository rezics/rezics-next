import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useQuery } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { personalRead, readQueryKey } from '../session/reading-policy';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import type { SessionEnv } from '../session/client';
import { loadMineCollectionsPage } from './mine-collections';
import { useHydrated } from './shelf-rows';
import { getLocale } from '../paraglide/runtime.js';

const readShortcuts = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('cache-control', 'private, no-store');
  return loadMineCollectionsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, {});
});
export function CollectionShortcuts() {
  const hydrated = useHydrated();
  const { data } = useQuery({
    queryKey: readQueryKey(['library', 'collection-shortcuts'], 'session'),
    queryFn: () => readShortcuts(),
    ...personalRead,
    enabled: hydrated && personalRead.enabled,
  });
  const collections = data?.signedIn ? data.collections.slice(0, 8) : [];
  return (
    <nav aria-label={m.library_collections()} className="flex flex-wrap items-center gap-2">
      {collections.map((collection) => (
        <a
          key={collection.id}
          href={`/${getLocale()}/collections/${encodeURIComponent(collection.id)}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {collection.title}
        </a>
      ))}
      <a
        href={`/${getLocale()}/library/collections`}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {m.library_all_collections()}
      </a>
    </nav>
  );
}
