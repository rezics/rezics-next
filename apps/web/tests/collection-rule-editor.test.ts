import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFilter } from '@rezics/filter';
import { CollectionRuleEditor, RuleEditLink } from '../src/library/collection-rule-editor';
import { loadCollectionRule, loadRuleChoices, unavailableRuleChoices } from '../src/library/collection-rule-read';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { isSignedInPath } from '../src/session/guard';
import active from '../src/kernel/recorded/definitions-active.json';
import release from '../src/kernel/recorded/definitions-release.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { submitCollectionRule, validateRuleWrite } = await import('../src/library/collection-rule-actions');
const key = '10000000-0000-4000-8000-000000000001';
const filter = parseFilter({
  and: [
    { owner: { presence: true } },
    {
      or: [
        { not: { owner: { state: { profileId: 'retired-profile', stateSetId: 'old-set', in: ['old-state'] } } } },
        { type: { in: ['schema:Book'] } },
      ],
    },
  ],
});
const credential = async () => ({
  status: 'active' as const,
  subject: 'owner',
  accessToken: 'owner-token',
  csrfToken: 'a'.repeat(22),
});
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'rule-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
} as unknown as Partial<import('../src/session/client').SessionEnv>;
const request = () =>
  new Request('https://web.test/action', { method: 'POST', headers: { authorization: 'Bearer current-viewer' } });

test('canonical rule stories distinguish unavailable draft, actual create, private route and denial at shared widths', async () => {
  const story = await readFile(new URL('../src/stories/library-collection-rule.stories.tsx', import.meta.url), 'utf8');
  expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'Draft',
    'ActualCreate',
    'ActualReady',
    'PrivateUnavailable',
    'Denied',
  ]);
  expect(story).toContain(
    "admitted: ['collections', 'collection.create', 'collection_rule.get', 'collection_rule.update']",
  );
  expect(story).toContain('choices: unavailableRuleChoices()');
  expect(story).toContain('pageReady');
  expect(story).not.toMatch(/viewport|maxWidth/);
});

test('private native create and revision edit keep all Boolean leaves and retry the exact intent without claiming source success', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call.clone());
      return Response.json(
        { code: call.method === 'PUT' ? 'conflict' : 'dependency_unavailable' },
        { status: call.method === 'PUT' ? 409 : 503 },
      );
    },
  });
  const draft = { title: 'Private rule', description: '', filter, sort: 'id' as const, idempotencyKey: key };
  for (let retry = 0; retry < 2; retry++)
    expect(await submitCollectionRule(client, request(), {}, draft)).toEqual({ ok: false, reason: 'unavailable' });
  const firstBody = await calls[0]!.json();
  expect(firstBody).toEqual({
    membershipKind: 'dynamic',
    visibility: 'private',
    title: draft.title,
    description: '',
    rule: { filter, sort: 'id' },
  });
  expect(await calls[1]!.json()).toEqual(firstBody);
  expect(calls[0]!.headers.get('idempotency-key')).toBe(calls[1]!.headers.get('idempotency-key'));
  expect(
    await submitCollectionRule(
      client,
      request(),
      {},
      { id: 'saved', revision: 7, filter, sort: 'id', idempotencyKey: key },
    ),
  ).toEqual({ ok: false, reason: 'conflict' });
  expect(new URL(calls[2]!.url).pathname).toBe('/v1/collections/saved/rule');
  expect(await calls[2]!.json()).toEqual({ revision: 7, filter, sort: 'id' });
});

test('invalid NOT leaves and ordinal/public selectors cannot bypass the shared grammar', () => {
  expect(() =>
    validateRuleWrite({
      title: 'Rule',
      description: '',
      filter: { not: { owner: { unknown: true } } },
      sort: 'id',
      idempotencyKey: key,
    }),
  ).toThrow();
  expect(() =>
    validateRuleWrite({ title: 'Rule', description: '', filter, sort: 'ordinal', idempotencyKey: key }),
  ).toThrow();
  expect(() =>
    validateRuleWrite({
      title: 'Rule',
      description: '',
      filter,
      sort: 'id',
      visibility: 'public',
      idempotencyKey: key,
    }),
  ).toThrow();
});

test('private GET denial never falls back to criteria in public metadata and unavailable choices stay unavailable', async () => {
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      paths.push(new URL(new Request(input, init).url).pathname);
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  expect(
    await loadCollectionRule(
      client,
      new Request('https://web.test/rule', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } }),
      sessionEnv,
      'saved',
    ),
  ).toEqual({ state: 'denied' });
  expect(paths).toEqual(['/v1/collections/saved/rule']);
  expect((await loadRuleChoices(client, 'Bearer owner')).labels.state).toBe('unavailable');
});

test('choices use the native current release and one scoped bounded label page, preserving preparing separately', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const path = decodeURIComponent(new URL(call.url).pathname);
      if (path === '/v1/definitions/active') return Response.json(active);
      if (path === `/v1/definitions/releases/${active.digest}`) return Response.json(release);
      return Response.json({ code: 'semantic_not_ready' }, { status: 503 });
    },
  });
  const choices = await loadRuleChoices(client, 'Bearer current-viewer', { q: 'reading', cursor: 'native-cursor' });
  expect(choices.release.state).toBe('ready');
  expect(choices.release.profiles).toEqual(Object.values(release.release.libraryProfiles));
  expect(choices.labels).toEqual({ state: 'preparing', values: [], next: null });
  const labels = calls.find((call) => new URL(call.url).pathname === '/v1/libraryLabels')!;
  expect(Object.fromEntries(new URL(labels.url).searchParams)).toEqual({
    limit: '100',
    q: 'reading',
    cursor: 'native-cursor',
  });
  for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer current-viewer');
  for (const path of ['/en/library/rules/new', '/zh-Hant/collections/saved/rule'])
    expect(isSignedInPath(path)).toBe(true);
});

test('all locales retain historical owner meanings in the shared structured composer and builtins have no edit link', () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(
        createElement(CollectionRuleEditor, {
          page: {
            state: 'ready',
            viewerId: 'owner',
            id: 'saved',
            title: 'Rule',
            intent: key,
            choices: unavailableRuleChoices(),
            rule: {
              filter,
              sort: 'id',
              revision: 7,
              collectionRevision: 9,
              releaseDigest: 'stored-release',
              sourceGeneration: '12',
            },
          },
          viewerId: 'owner',
          collectionId: 'saved',
          admitted: ['collection_rule.get', 'collection_rule.update'],
          csrfToken: 'current-csrf',
          save: async () => ({ ok: false, reason: 'unavailable' }),
          reload: async () => ({ state: 'unavailable' }),
        }),
      );
      expect(html).toContain('old-state');
      expect(html).toContain('retired-profile');
      expect(html).toContain('stored-release');
      expect(html).toContain(m.library_collection_reload());
      expect(html).not.toContain('<textarea');
      const base = { id: 'saved', curatorAccountId: 'owner', membershipKind: 'dynamic' };
      expect(
        renderToStaticMarkup(createElement(RuleEditLink, { collection: base, viewerId: 'owner', allowed: true })),
      ).toContain('/collections/saved/rule');
      for (const builtinKind of ['everything', 'state', 'liked'])
        expect(
          renderToStaticMarkup(
            createElement(RuleEditLink, { collection: { ...base, builtinKind }, viewerId: 'owner', allowed: true }),
          ),
        ).toBe('');
      expect(
        renderToStaticMarkup(createElement(RuleEditLink, { collection: base, viewerId: 'other', allowed: true })),
      ).toBe('');
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

// Source transport coverage; these assertions do not establish native authorization proof.
test('private loader provenance comes only from the prepared session subject, including new pages', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const path = new URL(call.url).pathname;
      if (path === '/v1/collections/saved/rule')
        return Response.json({
          rule: {
            filter,
            sort: 'id',
            revision: 7,
            collectionRevision: 9,
            releaseDigest: 'stored-release',
            sourceGeneration: '12',
          },
        });
      if (path === '/v1/collections/saved') return Response.json({ collection: { title: 'Private rule' } });
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    },
  });
  const unbound = new Request('https://web.test/rule', { headers: { authorization: 'Bearer opaque-no-subject' } });
  expect(await loadCollectionRule(client, unbound, sessionEnv, 'saved')).toEqual({ state: 'denied' });
  expect(calls).toEqual([]);
  const bound = () =>
    new Request('https://web.test/rule', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
  const loaded = await loadCollectionRule(client, bound(), sessionEnv, 'saved');
  expect(loaded.state).toBe('ready');
  if (loaded.state !== 'ready') throw new Error('Expected private native rule');
  expect(loaded.viewerId).toBe('owner');
  expect(loaded.rule.filter).toEqual(filter);
  const created = await loadCollectionRule(client, bound(), sessionEnv);
  expect(created.state).toBe('new');
  if (created.state !== 'new') throw new Error('Expected a private create page');
  expect(created.viewerId).toBe('owner');
  for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer owner-token');
});
