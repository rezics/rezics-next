import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { resolveTargets, targetRead } from '../../../services/main/src/modules/target/resolve.ts';
import type { HomeStack } from './feed-read-support.ts';

export const local = (reference: string) => reference.slice(-36);
export interface Page {
  zone: string; path: string; routeRevision: string; about: string; targetRevision: string;
}
export interface Posted {
  profile: string; realm: string; about: string; author: string;
  reply: string; revisionId: string; placement: string;
}
export interface ReplyRow {
  reply: string; author: string; parent_reply: string | null; root_target: string;
  root_revision: string; origin_realm: string | null; body: Record<string, unknown>;
}

export async function threeWriteDebits(home: HomeStack, request: () => Promise<Response>) {
  const limit = home.deps.rateLimit;
  if (!limit) throw new Error('Discussion fixture requires the real Main rate limiter');
  const original = limit.store.consume;
  const calls: Parameters<typeof original>[] = [];
  limit.store.consume = async (...args) => {
    calls.push(args);
    return original.call(limit.store, ...args);
  };
  try {
    const response = await request();
    expect(calls).toHaveLength(3);
    const identity = JSON.stringify([home.author.principal.issuer, home.author.principal.subject]);
    expect(calls.every(([key, family]) => key === identity && family === 'write')).toBe(true);
    expect(calls[1]![2]).toEqual(calls[0]![2]);
    expect(calls[2]![2]).toEqual(calls[0]![2]);
    return response;
  } finally { limit.store.consume = original; }
}

export async function arrange(home: HomeStack) {
  const author = await home.provision('Discussion author', home.author.token);
  const reader = await home.provision('Discussion participant', home.reader.token);
  expect(home.author.principalId).not.toBe(home.reader.principalId);
  const admin = new AccessRealmManagement(home.stack.accessPool);
  const realmFor = async () => {
    const realm = await home.json<{ realm: string; space: string }>(await home.call('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: `Discussion ${randomUUID()}`, topics: [],
      handle: `discussion-${randomUUID().slice(0, 12)}`, capabilities: ['realm'], actingSubject: author,
    }, home.author.token), 201);
    await admin.initialize({ ...home.author.principal, emailVerified: true }, realm.realm, author, home.stack.env);
    return realm;
  };
  const policy = async (realm: string, mode: 'open' | 'mandatory') => {
    const path = `/v1/realms/${local(realm)}/settings`;
    const current = await home.json<{ generation: string; ruleBasis: { revision: string | null } }>(
      await home.call('GET', `${path}?actingSubject=${encodeURIComponent(author)}`, undefined, home.author.token));
    await home.json(await home.call('PUT', path, { actingSubject: author,
      expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
      reason: 'Set discussion admission', settings: { visibility: 'public', reviewMode: mode,
        reviewRequired: mode === 'mandatory', whoMaySubmit: 'granted', rules: [] },
    }, home.author.token), 201);
  };
  const realm = await realmFor();
  await policy(realm.realm, 'open');
  const site = await home.json<{ zone: string; space: string; navigationRevision: string }>(
    await home.call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Discussion site', language: 'en',
      handle: `discussion-site-${randomUUID().slice(0, 12)}`, capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: author }, home.author.token), 201);
  expect(site.space).not.toBe(realm.space);
  const sitePath = `/v1/zones/${local(site.zone)}`;
  const head = async () => (await readZoneConfiguration(home.stack.env, site.zone)).revision;
  const configure = async (patch: object) => home.json<{ revision: string }>(await home.call('PUT',
    `${sitePath}/configuration`, { expectedHead: await head(), actingSubject: author, ...patch }, home.author.token));
  await configure({ defaultRealm: realm.realm, prepareHomeDocument: true });
  const homeDocument = (await readZoneConfiguration(home.stack.env, site.zone)).homeDocument!;
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await home.json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    await home.call('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: homeDocument,
      variantId, expectedHead: null, document: fromPlainText('Discussion site home', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: author }, home.author.token), 201);
  let navigationRevision = site.navigationRevision;
  const publish = async () => home.json(await home.call('POST', `${sitePath}/site-publications`, {
    routesRevision: navigationRevision, navigationRevision, expectedHead: await head(), actingSubject: author,
    pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
      contentEpoch: draft.sourcePosition.dataEpoch }],
  }, home.author.token), 201);
  const targetRevision = async (about: string) => {
    const [target] = await targetRead(home.stack.env, { access: home.stack.access },
      session => resolveTargets(session, [about], 'discussion'));
    return target!.revision;
  };
  const route = async (path: string) => home.json<{ realm: string | null; revision: string; resource: { id: string } }>(
    await home.call('GET', `${sitePath}/routes?${new URLSearchParams({ path })}`));
  const page = async (segment: string): Promise<Page> => {
    const work = await home.stack.publicWork(author, ['en'], `Discussion page ${segment}`);
    const mounted = await home.json<{ revision: string }>(await home.call('POST', `${sitePath}/mounts`, {
      expectedHead: navigationRevision, target: work.work, routeSegment: segment,
      disclosure: 'public', actingSubject: author,
    }, home.author.token));
    navigationRevision = mounted.revision;
    await publish();
    const path = `/${segment}`, resolved = await route(path);
    expect(resolved.realm).toBe(realm.realm);
    expect(resolved.resource.id).toBe(work.work);
    return { zone: site.zone, path, routeRevision: resolved.revision, about: work.work,
      targetRevision: await targetRevision(work.work) };
  };
  const input = (page: Page, actor: string, body: string) => ({ profile: 'realm-about-post-v1' as const,
    ...page, actingSubject: actor, language: 'en', direction: 'ltr' as const, body });
  const post = (page: Page, actor: string, body: string, token: string, key = randomUUID()) =>
    home.call('POST', `/v1/realms/${local(realm.realm)}/about-posts`, input(page, actor, body), token, key);
  const rows = async (about: string) => (await home.stack.contentPool.query<ReplyRow>(`
    SELECT c.id AS reply,c.author,c.parent_reply,c.root_target,c.root_revision,c.origin_realm,r.body
    FROM content.reply c JOIN content.variant v ON v.id=c.variant_id
    JOIN content.revision r ON r.id=v.draft_head WHERE c.root_target=$1 ORDER BY c.id`, [about])).rows;
  const effects = async (about: string) => (await home.stack.contentPool.query(`SELECT
    (SELECT count(*)::int FROM content.realm_about_thread WHERE realm=$1 AND about=$2) AS threads,
    (SELECT count(*)::int FROM content.realm_about_post_operation WHERE realm=$1 AND about=$2) AS operations,
    (SELECT count(*)::int FROM content.reply WHERE root_target=$2) AS replies,
    (SELECT count(*)::int FROM content.revision WHERE body->>'rootTarget'=$2) AS revisions`,
  [realm.realm, about])).rows[0];
  return { author, reader, realm, site, sitePath, page, input, post, rows, effects,
    realmFor, policy, configure, publish, route, targetRevision };
}

