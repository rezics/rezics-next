import { createKernelClient } from '@rezics/client';
import { useEffect, useMemo, useState } from 'react';
import {
  RealmDiscoverySection,
  loadRealmDiscovery,
  type RealmDiscoveryCard,
  type RealmDiscoverySort,
  type RealmDiscoveryState,
} from '../../../community/realm-discovery';
import realm from '../../../kernel/recorded/board-realm-realm.json';
import { getLocale } from '../../../paraglide/runtime.js';

// Presentation fixtures only: these responses make no claim that this Realm qualified in a native window.
export const discoveryRealm: RealmDiscoveryCard = {
  realmId: realm.realm.realmId,
  spaceId: realm.realm.spaceId,
  name: realm.realm.title,
  description: realm.realm.summary,
  avatar: null,
};
const selectedRealm: RealmDiscoveryCard = {
  ...discoveryRealm,
  avatar: {
    id: '0192f3a0-6c1e-7b2a-a001-000000000001',
    containerId: discoveryRealm.realmId,
    digest: 'a'.repeat(64),
    width: 320,
    height: 320,
    variants: [
      { format: 'webp', width: 160, height: 160 },
      { format: 'webp', width: 320, height: 320 },
    ],
    placeholder: null,
    focalPoint: { x: 0.5, y: 0.5 },
    credit: null,
  },
};
type Example = 'available' | 'image' | 'initials' | 'sparse' | 'empty' | 'loading' | 'unavailable' | 'closed';
const continuation = 'realm-discovery-pattern-continuation';

/** Story-only transport exercises the shared adapter; the section receives only its declared public props. */
export function DiscoveryFixture({
  variant = 'available',
  sort = 'popular',
}: {
  variant?: Example;
  sort?: RealmDiscoverySort;
}) {
  const [state, setState] = useState<RealmDiscoveryState>({ kind: 'loading' });
  const client = useMemo(() => {
    let attempts = 0;
    return createKernelClient('https://kernel.story', {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname !== '/v1/realms/discovery' || url.searchParams.get('sort') !== sort)
            return Response.json({ code: 'not_found' }, { status: 404 });
          attempts++;
          if (variant === 'closed') return Response.json({ code: 'platform_closed' }, { status: 403 });
          if (variant === 'unavailable' && attempts === 1)
            return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
          if (variant === 'empty') return Response.json({ realms: [], next: null });
          if (variant === 'sparse' && !url.searchParams.has('cursor'))
            return Response.json({ realms: [], next: continuation });
          if (url.searchParams.has('cursor') && url.searchParams.get('cursor') !== continuation)
            return Response.json({ code: 'invalid_cursor' }, { status: 400 });
          return Response.json({
            realms: [
              variant === 'image'
                ? selectedRealm
                : variant === 'initials'
                  ? { ...discoveryRealm, description: '' }
                  : discoveryRealm,
            ],
            next: null,
          });
        },
        { preconnect() {} },
      ),
    });
  }, [sort, variant]);
  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    if (variant !== 'loading')
      void loadRealmDiscovery(client, { sort }).then((value) => {
        if (current) setState(value);
      });
    return () => {
      current = false;
    };
  }, [client, sort, variant]);
  async function read(cursor?: string) {
    setState({ kind: 'loading' });
    setState(await loadRealmDiscovery(client, { sort, ...(cursor === undefined ? {} : { cursor }) }));
  }
  const next = state.kind === 'ready' ? state.next : null;
  return (
    <div className="mx-auto w-full max-w-xl p-4 sm:p-6">
      <RealmDiscoverySection
        sort={sort}
        state={state}
        locale={getLocale()}
        {...(next === null ? {} : { onNext: () => void read(next) })}
        onRetry={() => void read()}
      />
    </div>
  );
}
