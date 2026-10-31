import { createKernelClient } from '@rezics/client';
import { starterChoices } from './starters';
import type { CreateCommand, LifecycleCommand, ListInput, OwnedZone } from './model';
import { changeOwnedZone, createOwnedZone, readOwnedZones } from './request';

export type Scenario =
  | 'list'
  | 'empty'
  | 'trash'
  | 'denied'
  | 'conflict'
  | 'expired'
  | 'fenced'
  | 'actor'
  | 'closed'
  | 'missing'
  | 'invalid'
  | 'stale'
  | 'unavailable'
  | 'uncertain'
  | 'saving';
export const fixtureZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e70';
const otherId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e71';
const ownerId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e72';
export function fixtureZone(deleted = false): OwnedZone {
  const deletedAt = new Date(Date.now() - 20 * 86_400_000);
  return {
    id: fixtureZoneId,
    revision: '3',
    labels: { ...starterChoices.find((starter) => starter.id === 'book')!.labels },
    ownerId,
    visibility: 'private',
    appearance: {},
    navigation: [{ route: '' }, { route: 'editions' }],
    deletedAt: deleted ? deletedAt.toISOString() : null,
    restoreUntil: deleted ? new Date(deletedAt.getTime() + 30 * 86_400_000).toISOString() : null,
  };
}

/** Instance-local synthetic native responses. Nothing is installed in a shared fixture or response cache. */
export function zonesFixture(scenario: Scenario = 'list') {
  let zones = scenario === 'empty' ? [] : [fixtureZone(['trash', 'expired'].includes(scenario))];
  if (scenario === 'expired') zones[0]!.restoreUntil = '2026-01-01T12:00:00.000Z';
  if (scenario === 'list') zones.push({ ...fixtureZone(), id: otherId, visibility: 'public' });
  let attempts = 0;
  const calls: {
    method: string;
    path: string;
    query: string;
    key: string | null;
    match: string | null;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const receipts = new Map<string, unknown>();
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  const fetcher = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body: unknown = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json();
    calls.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      key: request.headers.get('idempotency-key'),
      match: request.headers.get('if-match'),
      authorization: request.headers.get('authorization'),
      body,
    });
    if (!request.headers.has('authorization')) return reply({ code: 'authentication_required' }, 401);
    if (scenario === 'actor') return reply({ code: 'account_suspended' }, 403);
    if (scenario === 'closed') return reply({ code: 'platform_closed' }, 403);
    if (request.method === 'GET') {
      if (scenario === 'denied') return reply({ code: 'forbidden' }, 403);
      if (scenario === 'unavailable') return reply({ code: 'dependency_unavailable' }, 503);
      if (scenario === 'stale') return reply({ code: 'stale_cursor' }, 409);
      if (scenario === 'missing') return reply({ code: 'not_found' }, 404);
      const deleted = url.searchParams.get('deleted') === 'true';
      // A continuation is opaque; this fake does not teach the product how to decode it.
      const page = zones.filter((zone) => !!zone.deletedAt === deleted);
      return reply({
        zones: url.searchParams.has('cursor') ? page.slice(1) : page.slice(0, 1),
        next: !url.searchParams.has('cursor') && page.length > 1 ? 'opaque+/cursor==' : null,
      });
    }
    if (scenario === 'saving') return new Promise<Response>(() => {});
    if (scenario === 'denied') return reply({ code: 'forbidden' }, 403);
    if (scenario === 'fenced' || scenario === 'expired') return reply({ code: 'conflict' }, 409);
    if (scenario === 'conflict') return reply({ code: 'precondition_failed' }, 412);
    if (scenario === 'missing') return reply({ code: 'not_found' }, 404);
    if (scenario === 'invalid')
      return reply(
        { code: 'invalid_request', errors: [{ pointer: '/configuration/labels/en', code: 'invalid_format' }] },
        400,
      );
    if (scenario === 'unavailable') return reply({ code: 'dependency_unavailable' }, 503);
    const key = request.headers.get('idempotency-key')!;
    if (receipts.has(key))
      return reply(receipts.get(key), request.method === 'POST' && url.pathname === '/v1/zones' ? 201 : 200);
    let zone: OwnedZone;
    if (url.pathname === '/v1/zones' && request.method === 'POST') {
      const input = body as {
        configuration: { labels: OwnedZone['labels']; primaryLanguage?: OwnedZone['primaryLanguage'] };
        visibility: OwnedZone['visibility'];
      };
      zone = {
        ...fixtureZone(),
        labels: input.configuration.labels,
        ...(input.configuration.primaryLanguage ? { primaryLanguage: input.configuration.primaryLanguage } : {}),
        visibility: input.visibility,
        revision: '1',
      };
      zones = [zone];
    } else {
      zone = zones.find((candidate) => url.pathname.startsWith(`/v1/zones/${candidate.id}`))!;
      if (!zone) return reply({ code: 'not_found' }, 404);
      if (request.headers.get('if-match') !== `"${zone.revision}"`) return reply({ code: 'precondition_failed' }, 412);
      const deleted = request.method === 'DELETE';
      zone = {
        ...zone,
        revision: String(Number(zone.revision) + 1),
        deletedAt: deleted ? '2026-10-31T12:00:00.000Z' : null,
        restoreUntil: deleted ? '2026-11-30T12:00:00.000Z' : null,
      };
      zones = zones.map((candidate) => (candidate.id === zone.id ? zone : candidate));
    }
    const saved = { zone };
    receipts.set(key, saved);
    if (scenario === 'uncertain' && attempts++ === 0) throw new Error('Synthetic response lost after commit');
    return reply(saved, url.pathname === '/v1/zones' ? 201 : 200);
  }) as typeof fetch;
  const client = createKernelClient('https://kernel.invalid', { fetch: fetcher });
  const viewer = (method = 'GET') =>
    new Request('https://site.invalid/action', { method, headers: { authorization: 'Bearer synthetic-viewer' } });
  return {
    client,
    calls,
    initial: () => ({
      kind: 'ready' as const,
      page: { zones: structuredClone(zones), next: scenario === 'list' ? 'opaque+/cursor==' : null },
    }),
    list: (input: ListInput) => readOwnedZones(client, viewer(), {}, input),
    change: (command: LifecycleCommand) => changeOwnedZone(client, viewer('POST'), {}, command),
    create: (command: CreateCommand) => createOwnedZone(client, viewer('POST'), {}, command),
  };
}
