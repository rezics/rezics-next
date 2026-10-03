import { RelationshipError } from './api.ts';
import type { FollowEdit, RelationshipsApi } from './types.ts';

/** Exercise the production relationship adapter against a story's in-memory Main.
 * Realm and Space addresses can name the same relationship, just as Main resolves them. */
export function relationshipStoryFetch(
  api: RelationshipsApi,
  fallback: typeof fetch,
  aliases: Readonly<Record<string, string>> = {},
): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://storybook.test');
    const target = (id: string) => aliases[id] ?? id;
    try {
      if (url.pathname === '/api/main/v1/me/follow-state')
        return Response.json(await api.state(target(url.searchParams.get('target')!), url.searchParams.get('kind') ?? 'realm'));
      if (url.pathname === '/api/main/v1/follows' && init?.method === 'POST') {
        const edit = JSON.parse(String(init.body)) as FollowEdit & { following: boolean; expectedRevision: string | null };
        return Response.json(await api.set({ ...edit, target: target(edit.target) }, new Headers(init.headers).get('idempotency-key') ?? undefined));
      }
      if (url.pathname === '/api/main/v1/me/follows/batch' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { targets: FollowEdit[] };
        return Response.json(await api.batch(body.targets.map(edit => ({ ...edit, target: target(edit.target) })),
          new Headers(init.headers).get('idempotency-key') ?? undefined));
      }
    } catch (error) {
      if (error instanceof RelationshipError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
    return fallback(input, init);
  }, fallback);
}
