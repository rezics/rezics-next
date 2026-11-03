import { afterAll, beforeAll, expect, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import {
  presentationSettingsFixture,
  type PresentationSettingsFixture,
} from './support/growth-realm-presentation-settings-fixture.ts';

let f: PresentationSettingsFixture;
beforeAll(async () => {
  f = await presentationSettingsFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test.serial(
  'settings open the current managed source, pin exact rules, preserve omitted fields and mint no writes',
  async () => {
    const s = await f.select();
    const path = `/v1/realms/${s.realmId}/settings`;
    const before = await f.snapshot(s);
    const empty = await f.call('GET', path);
    expect(empty.response.status, empty.text).toBe(200);
    expect(empty.response.headers.get('etag')).toBe(JSON.stringify(s.head));
    expect(empty.response.headers.get('cache-control')).toBe('private, no-store');
    expect(empty.value.snapshot).toMatchObject({
      realmId: s.realmId,
      head: s.head,
      state: 'active',
      canManage: true,
      presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
      avatar: { state: 'none', value: null },
      banner: { state: 'none', value: null },
      rules: { state: 'none', value: null },
    });
    expect(empty.value.host).toMatchObject({ spaceId: s.spaceId });
    expect(empty.value.operations.update).toMatchObject({
      method: 'PATCH',
      path: `/v1/realms/${s.realmId}`,
      ifMatch: JSON.stringify(s.head),
      available: true,
    });
    expect(empty.value.operations.boardScheme.method).toBe('PUT');
    expect(await f.snapshot(s)).toEqual(before);

    const saved = await f.patch(s, { presentation: s.presentation });
    expect(saved.response.status, saved.text).toBe(200);
    const oldHead = s.head;
    s.head = saved.value.realm.headRevisionId;
    const page = await f.call('GET', path);
    expect(page.response.status, page.text).toBe(200);
    expect(page.value.snapshot.head).toBe(s.head);
    expect(page.value.snapshot.head).not.toBe(oldHead);
    expect(page.value.snapshot.presentation).toEqual(s.presentation);
    expect(page.value.snapshot.rules.state).toBe('available');
    expect(page.value.snapshot.rules.value).toMatchObject({
      ...s.pin,
      licence: s.post.licence,
      sha256: s.post.sha256,
    });
    expect(serializeDocument(page.value.snapshot.rules.value.body)).toBe(serializeDocument(s.post.body));
    expect(page.value.snapshot.rules.value.revisionId).not.toBe(s.postHead);
    const stable = await f.snapshot(s);
    await f.call('GET', path);
    expect(await f.snapshot(s)).toEqual(stable);

    const stale = await f.patch(s, { summary: 'conflicting local choice' }, oldHead);
    expect(stale.response.status, stale.text).toBe(412);
    const refreshed = await f.call('GET', path);
    expect(refreshed.value.snapshot.head).toBe(s.head);
    expect(refreshed.value.snapshot.summary).not.toBe('conflicting local choice');
    const changed = await f.patch(s, { title: 'Refreshed title' });
    expect(changed.response.status, changed.text).toBe(200);
    const readback = await f.call('GET', path);
    expect(readback.response.status, readback.text).toBe(200);
    expect(readback.value.snapshot).toMatchObject({
      title: 'Refreshed title',
      head: changed.value.realm.headRevisionId,
      contextId: page.value.snapshot.contextId,
      votes: page.value.snapshot.votes,
      boardSchemeId: page.value.snapshot.boardSchemeId,
      presentation: s.presentation,
    });
  },
  120_000,
);

test.serial(
  'ordinary readership grants no settings access; native grant revocation retires settings',
  async () => {
    const s = await f.select();
    const path = `/v1/realms/${s.realmId}/settings`;
    const unrelated = await f.call('GET', path, {
      bearer: f.base.other.bearer,
    });
    expect(unrelated.response.status, unrelated.text).toBe(404);
    expect(unrelated.text).not.toContain(s.head);
    const publicRead = await f.base.system.kernel.handle(new Request(`https://content.test/v1/realms/${s.realmId}`));
    expect(publicRead.status).toBe(200);
    const anonymous = await f.base.system.kernel.handle(new Request(`https://content.test${path}`));
    expect(anonymous.status).toBe(404);
    expect(await anonymous.text()).not.toContain(s.head);
    await f.manage(s, f.base.other);
    const managed = await f.call('GET', path, { bearer: f.base.other.bearer });
    expect(managed.response.status, managed.text).toBe(200);
    await f.manage(s, f.base.other, true);
    const revoked = await f.call('GET', path, { bearer: f.base.other.bearer });
    expect(revoked.response.status, revoked.text).toBe(404);
    expect(revoked.text).not.toContain(s.head);
  },
  120_000,
);

test.serial(
  'concealed selected rules retain only their reference; removed hosts retire settings',
  async () => {
    const s = await f.select();
    const selected = await f.patch(s, { presentation: s.presentation });
    expect(selected.response.status, selected.text).toBe(200);
    const hidden = await f.call('POST', `/v1/posts/${s.postId}:takeDown`, {
      bearer: f.base.governance.bearer,
      body: { reason: 'Conceal the selected native rules' },
    });
    expect(hidden.response.status, hidden.text).toBe(200);
    const page = await f.call('GET', `/v1/realms/${s.realmId}/settings`);
    expect(page.response.status, page.text).toBe(200);
    expect(page.value.snapshot.presentation.rules).toEqual(s.pin);
    expect(page.value.snapshot.rules).toEqual({ state: 'none', value: null });
    expect(page.text).not.toContain(s.post.sha256);
    const lifecycle = await f.call('GET', `/v1/spaces/${s.spaceId}/lifecycle`);
    expect(lifecycle.response.status, lifecycle.text).toBe(200);
    const removal = await f.call('POST', `/v1/spaces/${s.spaceId}/removal`, {
      body: { expectedVersion: lifecycle.value.container.version, reason: 'Remove the settings host' },
      headers: { 'if-match': JSON.stringify(lifecycle.value.container.headRevisionId) },
    });
    expect(removal.response.status, removal.text).toBe(200);
    const removed = await f.call('GET', `/v1/realms/${s.realmId}/settings`);
    expect(removed.response.status, removed.text).toBe(404);
    expect(removed.text).not.toContain(s.pin.revisionId);
  },
  120_000,
);
