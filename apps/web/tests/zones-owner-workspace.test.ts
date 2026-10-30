import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_LOCALES } from '@rezics/composition';
import { CreateZone } from '../src/features/zones/manage/create';
import { ZonesOwnerWorkspace } from '../src/features/zones/manage/workspace';
import { fixtureZone, fixtureZoneId, zonesFixture } from '../src/features/zones/manage/fixtures';
import { copyStarter, starterChoices } from '../src/features/zones/manage/starters';
import {
  invalidLabels,
  listHref,
  zonePaths,
  type CreateCommand,
  type LifecycleCommand,
} from '../src/features/zones/manage/model';
import { changeOwnedZone, createOwnedZone, readOwnedZones } from '../src/features/zones/manage/request';
import { isSignedInPath } from '../src/session/guard';
import type { SessionEnv } from '../src/session/client';

const command = (): CreateCommand => ({
  starter: 'book',
  labels: copyStarter('book')!.labels,
  key: crypto.randomUUID(),
});
const mutation = (operation: LifecycleCommand['operation'] = 'delete', revision = '3'): LifecycleCommand => ({
  id: fixtureZoneId,
  revision,
  operation,
  key: crypto.randomUUID(),
});

test('My Zones list trash and starter creation are a real owner-to-reader product journey', async () => {
  const api = zonesFixture();
  const first = await api.list({ deleted: false });
  expect(first.kind).toBe('ready');
  if (first.kind !== 'ready') throw new Error('Expected an owned page');
  expect(first.page.zones).toHaveLength(1);
  expect(first.page.next).toBe('opaque+/cursor==');
  expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/v1/zones', body: null });
  const query = new URLSearchParams(api.calls[0]!.query);
  expect(query.get('limit')).toBe('20');
  expect(query.get('deleted')).toBe('false');
  expect(api.calls).toHaveLength(1);
  const next = await api.list({ deleted: false, cursor: first.page.next! });
  expect(next.kind === 'ready' && next.page.zones[0]?.visibility).toBe('public');
  expect(new URLSearchParams(api.calls[1]!.query).get('cursor')).toBe(first.page.next);

  const html = renderToStaticMarkup(
    createElement(ZonesOwnerWorkspace, {
      locale: 'ja',
      input: { deleted: false },
      outcome: first,
      onChange: api.change,
      onReload: () => {},
    }),
  );
  expect(html).toContain(`/ja/zones/${fixtureZoneId}`);
  expect(html).toContain(`/ja/my/zones/${fixtureZoneId}/edit`);
  expect(html).toContain('/ja/my/zones/new');
  expect(html).not.toContain('synthetic-viewer');
  expect(html).not.toContain('configuration');
  expect(html).not.toContain('book/all');

  const trashed = await api.change(mutation());
  expect(trashed.kind).toBe('saved');
  const deletedCall = api.calls.at(-1)!;
  expect(deletedCall).toMatchObject({ method: 'DELETE', path: `/v1/zones/${fixtureZoneId}`, match: '"3"', body: null });
  expect(deletedCall.key).toHaveLength(36);
  const trash = await api.list({ deleted: true });
  expect(new URLSearchParams(api.calls.at(-1)!.query).get('deleted')).toBe('true');
  if (trash.kind !== 'ready' || !trash.page.zones[0]) throw new Error('Expected a retained tombstone');
  const tombstone = trash.page.zones[0];
  expect(Date.parse(tombstone.restoreUntil!) - Date.parse(tombstone.deletedAt!)).toBe(30 * 86_400_000);
  const restored = await api.change(mutation('restore', tombstone.revision));
  expect(api.calls.at(-1)).toMatchObject({
    method: 'POST',
    path: `/v1/zones/${fixtureZoneId}:restore`,
    match: '"4"',
    body: {},
  });
  expect(restored.kind === 'saved' && restored.zone.deletedAt).toBeNull();

  const input = command();
  input.labels.ja = '私の本棚';
  const created = await api.create(input);
  expect(created.kind).toBe('saved');
  if (created.kind !== 'saved') throw new Error('Expected a created Zone');
  expect(api.calls.at(-1)).toMatchObject({
    method: 'POST',
    path: '/v1/zones',
    key: input.key,
    body: {
      configuration: { ...copyStarter('book'), labels: input.labels },
      mounts: [],
      visibility: 'private',
    },
  });
  expect(created.zone.visibility).toBe('private');
  expect(zonePaths('ja', created.zone.id)).toMatchObject({
    edit: `/ja/my/zones/${fixtureZoneId}/edit`,
    reader: `/ja/zones/${fixtureZoneId}`,
  });
  // Reader navigation is an ordinary route, never an owner token, configuration payload or readiness claim.
  expect(new URL(zonePaths('ja', created.zone.id).reader, 'https://site.invalid').search).toBe('');
  expect(api.calls.every((call) => call.authorization === 'Bearer synthetic-viewer')).toBe(true);
  expect(starterChoices).toHaveLength(8);
  for (const starter of starterChoices) expect(Object.keys(starter.labels).sort()).toEqual([...UI_LOCALES].sort());
  expect(copyStarter('book')!.labels.ja).not.toBe(input.labels.ja);
  expect(copyStarter('__proto__')).toBeUndefined();
  for (const locale of UI_LOCALES) {
    expect(isSignedInPath(`/${locale}/my/zones`)).toBe(true);
    expect(isSignedInPath(`/${locale}/my/zones/new`)).toBe(true);
    expect(isSignedInPath(`/${locale}/zones/${fixtureZoneId}`)).toBe(false);
  }
  const href = listHref('en', { deleted: true, cursor: 'opaque+/cursor==' });
  expect(new URL(href, 'https://site.invalid').searchParams.get('cursor')).toBe('opaque+/cursor==');
});

test('Uncertain create and lifecycle results replay the original native request without extra resources', async () => {
  const api = zonesFixture('uncertain');
  const input = command();
  expect(await api.create(input)).toEqual({ kind: 'unavailable' });
  expect(await api.create(input)).toMatchObject({ kind: 'saved', zone: { revision: '1' } });
  expect(api.calls[0]).toEqual(api.calls[1]);
  const lifecycle = zonesFixture('uncertain');
  const deletion = mutation();
  expect(await lifecycle.change(deletion)).toEqual({ kind: 'unavailable' });
  expect(await lifecycle.change(deletion)).toMatchObject({ kind: 'saved', zone: { revision: '4' } });
  expect(lifecycle.calls[0]).toEqual(lifecycle.calls[1]);
});

test('Current actor, Source/feature denial, expiry, write fences, CAS and validation remain explicit outcomes', async () => {
  for (const [scenario, kind] of [
    ['denied', 'denied'],
    ['actor', 'actor'],
    ['closed', 'closed'],
    ['missing', 'missing'],
    ['fenced', 'conflict'],
    ['expired', 'conflict'],
    ['conflict', 'conflict'],
    ['invalid', 'invalid'],
  ] as const) {
    const api = zonesFixture(scenario);
    // Every fake row has matching owner metadata; that never overrides a native refusal.
    expect(fixtureZone().ownerId).toBeTruthy();
    expect(await api.change(mutation())).toMatchObject({ kind });
    expect(await api.create(command())).toMatchObject({ kind });
  }
  expect(await zonesFixture('stale').list({ deleted: false, cursor: 'stale' })).toEqual({ kind: 'stale' });
  const malformed = command();
  malformed.labels.en = '';
  malformed.labels.ja = '<script>';
  expect(invalidLabels(malformed.labels)).toEqual(['/configuration/labels/en', '/configuration/labels/ja']);
  const api = zonesFixture();
  expect(await api.create(malformed)).toMatchObject({ kind: 'invalid' });
  expect(api.calls).toHaveLength(0);
  expect(await api.change({ ...mutation(), revision: '*' })).toEqual({ kind: 'invalid' });
  expect(api.calls).toHaveLength(0);
  const html = renderToStaticMarkup(
    createElement(CreateZone, {
      locale: 'en',
      session: 'signed-in',
      onCreate: api.create,
      onNavigate: () => {},
    }),
  );
  expect(html).toContain('/en/my/zones');
  expect(html).toContain('value=""');
  expect(html).toContain('Create private Zone');
  expect(html).not.toContain('book/all');
});

const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.invalid',
  API_RESOURCE: 'https://kernel.invalid',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'site',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', accessToken: 'request-only', subject: 'owner', csrfToken: csrf }),
    }),
  },
} as unknown as Partial<SessionEnv>;
function sessionRequest(method: string, token = csrf) {
  return new Request('https://site.invalid/action', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'X-CSRF-Token': token,
    },
  });
}

test('Owner actions keep credentials per request and use existing session/CSRF handling', async () => {
  const api = zonesFixture();
  expect(await readOwnedZones(api.client, new Request('https://site.invalid/'), {}, { deleted: false })).toEqual({
    kind: 'signed-out',
  });
  expect(api.calls).toHaveLength(0);
  expect(await readOwnedZones(api.client, sessionRequest('GET'), sessionEnv, { deleted: false })).toMatchObject({
    kind: 'ready',
  });
  expect(api.calls.at(-1)!.authorization).toBe('Bearer request-only');
  expect(await createOwnedZone(api.client, sessionRequest('POST', 'wrong'), sessionEnv, command())).toEqual({
    kind: 'denied',
  });
  expect(await changeOwnedZone(api.client, sessionRequest('POST', 'wrong'), sessionEnv, mutation())).toEqual({
    kind: 'denied',
  });
  expect(api.calls).toHaveLength(1);
  expect(await createOwnedZone(api.client, sessionRequest('POST'), sessionEnv, command())).toMatchObject({
    kind: 'saved',
  });
  expect(await readOwnedZones(api.client, new Request('https://site.invalid/'), {}, { deleted: true })).toEqual({
    kind: 'signed-out',
  });
  expect(api.calls).toHaveLength(2);
});
