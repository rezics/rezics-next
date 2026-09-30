import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { png, sha, startMediaStack } from './media-support.ts';
import type { PublicProfile } from '../../../services/main/src/modules/realm-profile/schema.ts';
import { clearQueued, flagged, screening } from './g-571-screen-support.ts';

async function json<T>(response: Response, expected = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}
const short = (id: string) => id.slice(-36);

test('G571: Agent profile saves a screening selection; public reads withhold it until clearance and writes deny holds', async () => {
  const s = await startMediaStack('g571-agent-screen', { autoClearUploads: false });
  try {
    await clearQueued(s);
    const owner = await s.member('profile-controller');
    const app = createMainApp(s.fuseki, { environment: s.env, access: s.access, media: s.media,
      account: { verify: async (request: Request) => {
        if (request.headers.get('authorization') !== `Bearer ${owner.token}`) throw new Error('unknown QA bearer');
        return owner.principal;
      } },
      profiles: new ProfilesAccess(s.accessPool), agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      agentProfiles: new AgentPublicProfiles(s.accessPool, s.env, s.store),
      personPreferences: new PersonPreferencesStore(s.accessPool), agentHandles: new AgentVanityHandles(s.accessPool) });
    const call = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: method === 'GET' ? {} : { authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const { agent } = await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Screening author' }));
    for (const [scope, action] of [[`media:owner:${agent}`, 'media.upload'], [`media:avatar:${agent}`, 'media.avatar']]) {
      await s.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await s.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,'infinity')`, [randomUUID(), owner.principalId, agent, action]);
      await s.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,'infinity')`,
      [randomUUID(), agent, scope, action]);
    }
    const path = `/v1/agents/${short(agent)}`;
    const initial = await json<{ revision: string }>(await call('GET', path), 200);
    const upload = async (bytes: Uint8Array) => {
      const reserved = await json<{ asset: string; upload: string }>(await owner.send('POST', '/v1/media/uploads', {
        profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
        sha256: sha(bytes), disclosure: 'public', actingSubject: agent }));
      expect(await json(await s.call('PUT', `/v1/media/uploads/${reserved.upload}/bytes`, {
        token: owner.token, raw: bytes }))).toMatchObject({ status: 'activated', clearance: 'screening' });
      return reserved;
    };
    const select = async (asset: string, expectedSelection: string | null) => json<{ selection: string }>(
      await owner.send('PUT', `/v1/resources/${short(agent)}/avatar`, { profile: 'resource-avatar-selection-v1',
        asset, expectedSelection, actingSubject: agent }));
    const save = (expectedHead: string, avatarSelection: string) => call('PUT', `${path}/profile`, {
      profile: 'agent-public-profile-v1', expectedHead, displayName: 'Screening author', avatarSelection, bio: null });
    const image = await upload(png(111, 111));
    const { selection } = await select(image.asset, null);
    const saved = await json<{ revision: string }>(await save(initial.revision, selection));
    expect(await json(await call('GET', path), 200)).toMatchObject({ revision: saved.revision,
      avatarSelection: null, avatarUrl: null });
    expect((await s.call('GET', `/v1/media/avatars/${selection}`)).status).toBe(404);
    await clearQueued(s);
    expect(await json(await call('GET', path), 200)).toMatchObject({ avatarSelection: selection,
      avatarUrl: `/v1/media/avatars/${selection}` });
    expect((await s.call('GET', `/v1/media/avatars/${selection}`)).status).toBe(200);
    const clearedSave = await json<{ revision: string }>(await save(saved.revision, selection));
    const held = await upload(png(112, 112));
    const next = await select(held.asset, selection);
    // The previous publicly delivered head is not the newly requested write basis.
    expect((await save(clearedSave.revision, selection)).status).toBe(400);
    const { worker, store } = screening(s, { classify: async () => flagged });
    await worker.tick();
    expect((await save(clearedSave.revision, next.selection)).status).toBe(400);
    const representation = (await s.store.readUpload(held.upload))!.representation!;
    expect(await store.reviewOriginal(representation, 'held', randomUUID(), 'rejected')).toBe('applied');
    expect((await save(clearedSave.revision, next.selection)).status).toBe(400);
  } finally { await s.stop(); }
}, 180_000);

test('G571: community icon and banner saves accept screening or cleared selections, withhold public bytes, and deny holds', async () => {
  const s = await startMediaStack('g571-community-screen', { autoClearUploads: false });
  try {
    await clearQueued(s);
    const manager = await s.member('community-manager');
    await manager.grant('space:create:root', 'space.create');
    const { realm } = await json<{ realm: string }>(await manager.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Pending images', capabilities: ['realm'], actingSubject: manager.actor }));
    await manager.grant(`realm:profile:${realm}`, 'realm.profile.publish');
    await manager.grant(`media:avatar:${realm}`, 'media.avatar');
    const select = async (asset: string, expectedSelection: string | null, context?: string) => json<{ selection: string }>(
      await manager.send('PUT', `/v1/resources/${short(realm)}/avatar`, { profile: 'resource-avatar-selection-v1',
        asset, expectedSelection, actingSubject: manager.actor, ...(context ? { context } : {}) }));
    const image = await manager.upload(png(113, 113));
    expect(await (await manager.read(`/v1/media/uploads/${image.upload}`)).json()).toMatchObject({
      status: 'activated', clearance: 'screening' });
    const icon = await select(image.asset, null);
    const banner = await select(image.asset, null, realm);
    const path = `/v1/realms/${short(realm)}`;
    const publication: PublicProfile = { name: { original: 'en', labels: { en: 'Pending images' } },
      description: { original: 'en', labels: { en: 'A reading community.' } },
      iconSelection: icon.selection, bannerSelection: banner.selection, rules: [],
      count: { kind: 'unknown', value: null }, moderators: [] };
    const save = (expectedHead: string | null, images = publication) => manager.send('PUT', `${path}/profile`, {
      profile: 'realm-public-profile-v2', expectedHead, actingSubject: manager.actor, publication: images });
    const saved = await json<{ revision: string }>(await save(null));
    expect(await json(await s.call('GET', path), 200)).toMatchObject({ profileRevision: saved.revision,
      icon: { kind: 'fallback' }, banner: null });
    for (const { selection } of [icon, banner]) expect((await s.call('GET', `/v1/media/avatars/${selection}`)).status).toBe(404);
    await clearQueued(s);
    expect(await json(await s.call('GET', path), 200)).toMatchObject({
      icon: { kind: 'image', selection: icon.selection }, banner: { kind: 'image', url: `/v1/media/avatars/${banner.selection}` } });
    for (const { selection } of [icon, banner]) expect((await s.call('GET', `/v1/media/avatars/${selection}`)).status).toBe(200);
    const clearedSave = await json<{ revision: string }>(await save(saved.revision));
    const held = await manager.upload(png(114, 114));
    const nextIcon = await select(held.asset, icon.selection);
    const nextBanner = await select(held.asset, banner.selection, realm);
    const { worker, store } = screening(s, { classify: async () => flagged });
    await worker.tick();
    // Each field is checked separately; an accepted cleared field cannot mask a held one.
    expect((await save(clearedSave.revision, { ...publication, iconSelection: nextIcon.selection,
      bannerSelection: null })).status).toBe(400);
    expect((await save(clearedSave.revision, { ...publication, iconSelection: null,
      bannerSelection: nextBanner.selection })).status).toBe(400);
    expect(await store.reviewOriginal(held.representation, 'held', randomUUID(), 'rejected')).toBe('applied');
    expect((await save(clearedSave.revision, { ...publication, iconSelection: nextIcon.selection,
      bannerSelection: nextBanner.selection })).status).toBe(400);
  } finally { await s.stop(); }
}, 180_000);
