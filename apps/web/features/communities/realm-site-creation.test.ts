import { isValidElement } from 'react';
import { zoneRealmAttachmentView as routeView } from '../../app/[locale]/manage/z/[space]/realm/page.tsx';
import { RealmAttachmentEditor } from '../zone-editor/realm-attachment.tsx';
import { ZoneAuthoringFailure } from '../zone-editor/states.tsx';
import { zoneRealmAttachmentView } from './realm-site-creation-attachment.tsx';
import { expect, test } from 'bun:test';
import type { CanonicalAddress } from '@rezics/model/address';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import creationJson from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import attachmentJson from '../../../../tests/qa/fixtures/outcomes/zone/attach-a-realm.json';
import { zonePresentationReads } from '../realm/zone-presentation-read.ts';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import { addressKey, canonicalHref } from '../address/path.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { readZoneManagementFrame } from '../zone-editor/authoring-reads.ts';
import { browserZoneRealmAttachment, type ZoneRealmAttachmentWrite } from '../zone-editor/api.ts';
import { realmSiteCreationClient, type RealmSiteCreationIntent } from './realm-site-creation-api.ts';

const creation = creationJson as AnswerRecord;
const attachment = attachmentJson as AnswerRecord;
const sample = (label: string) => creation.personas.owner.find(item => item.label === label)!;
const body = sample('creation-space').body as RealmSiteCreationIntent;

test('creation preserves the Person, exact Space/Zone commands, keys and complete receipts', async () => {
  const replay = recordedFetch(creation, 'owner', ['creation-space', 'creation-home', 'creation-address'].map(label => ({ label, state: 'populated' })), { pathPrefix: BFF_PREFIX });
  const calls: { method: string; body: unknown; key: string | null }[] = [];
  const main = browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    calls.push({ method: request.method, body: text ? JSON.parse(text) : undefined, key: request.headers.get('idempotency-key') });
    return replay.fetcher(request);
  }) as typeof fetch });
  try {
    const client = realmSiteCreationClient(main);
    const created = await client.create(body, 'create-site');
    expect(created as unknown).toEqual({ ok: true, data: sample('creation-space').answer });
    if (!created.ok) throw new Error('Creation failed');
    const prepared = await client.prepare(created.data, body.actingSubject, 'prepare-site');
    expect(prepared as unknown).toEqual({ ok: true, data: sample('creation-home').answer });
    const destination = await client.destination(created.data, body.actingSubject, 'de');
    const address = sample('creation-address').answer as { canonical: CanonicalAddress };
    expect(destination).toEqual({ ok: true, data: { attachmentPath: `/manage/z/${addressKey(address.canonical)}/realm`, sitePath: canonicalHref(address.canonical, 'de') } });
    expect(calls).toEqual([
      { method: 'POST', body, key: 'create-site' },
      { method: 'PUT', body: sample('creation-home').body, key: 'prepare-site' },
      { method: 'GET', body: undefined, key: null },
    ]);
    expect(created.data.owner).toBe(body.actingSubject);
    expect(created.data.capabilities).toEqual(['zone']);
  } finally { replay.dispose(); }
});

test('the newly created canonical address opens the existing management reader', async () => {
  const selections = creation.personas.owner.filter(item => item.label.startsWith('creation-management-'));
  const replay = recordedFetch(creation, 'owner', selections.map(item => ({ label: item.label, state: 'populated' })), { pathPrefix: BFF_PREFIX });
  try {
    const address = sample('creation-address').answer as { canonical: CanonicalAddress };
    const frame = await readZoneManagementFrame(browserMainApi('https://record.invalid', { fetcher: replay.fetcher }), addressKey(address.canonical), 'en', body.actingSubject);
    expect(frame.authoring.kind).toBe('ready');
    expect(frame.draftZoneId).toBe((sample('creation-space').answer as { zone: string }).zone.slice(-36));
  } finally { replay.dispose(); }
});

for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const satisfies readonly AnswerPersona[]) {
  test(`${persona}: attachment preserves each recorded both-authority decision`, async () => {
    const writes = attachment.personas[persona].filter(item => item.method === 'PUT');
    const replay = recordedFetch(attachment, persona, writes.map(item => ({ label: item.label, state: item.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX, sequence: true });
    try {
      const client = browserZoneRealmAttachment(browserMainApi('https://record.invalid', { anonymous: persona === 'visitor', fetcher: replay.fetcher }));
      for (const write of writes) {
        const answer = await client.saveConfiguration(write.path.split('/')[3]!, write.body as ZoneRealmAttachmentWrite, `attach-${write.label}`);
        expect(answer.ok).toBe(write.status === 200);
        if (!answer.ok && write.status === 401) expect(answer.failure).toBe('sign-in');
        if (!answer.ok && write.status === 403) expect(answer.failure).toBe('denied');
      }
    } finally { replay.dispose(); }
  });
}


test('lost responses recover the same recorded Space, Zone and home with their original keys', async () => {
  const labels = ['creation-space', 'creation-space-replay', 'creation-home', 'creation-home-replay', 'creation-address'];
  const replay = recordedFetch(creation, 'owner', labels.map(label => ({ label, state: 'populated' })), { pathPrefix: BFF_PREFIX, sequence: true });
  const calls: { method: string; body: unknown; key: string | null }[] = [];
  const misses: unknown[] = [];
  const dropped = new Set<string>();
  const lost = new TypeError('Response lost after the command reached Main');
  const main = browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    calls.push({ method: request.method, body: text ? JSON.parse(text) : undefined, key: request.headers.get('idempotency-key') });
    let response: Response;
    try { response = await replay.fetcher(request); }
    catch (error) { misses.push(error); throw error; }
    if (request.method !== 'GET' && !dropped.has(request.method)) { dropped.add(request.method); throw lost; }
    return response;
  }) as typeof fetch });
  try {
    const client = realmSiteCreationClient(main);
    expect(await client.create(body, 'original-space-key')).toMatchObject({ ok: false, failure: 'unavailable', problem: lost });
    const recovered = await client.create(body, 'original-space-key');
    expect(recovered as unknown).toEqual({ ok: true, data: sample('creation-space-replay').answer });
    if (!recovered.ok) throw new Error('Original creation receipt was not recovered');
    expect(recovered.data).toMatchObject({ ...(sample('creation-space').answer as object), replayed: true });
    expect(await client.prepare(recovered.data, body.actingSubject, 'original-home-key')).toMatchObject({ ok: false, failure: 'unavailable', problem: lost });
    expect(await client.prepare(recovered.data, body.actingSubject, 'original-home-key') as unknown)
      .toEqual({ ok: true, data: sample('creation-home-replay').answer });
    expect((await client.destination(recovered.data, body.actingSubject, 'en')).ok).toBe(true);
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'PUT', 'PUT', 'GET']);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[3]).toEqual(calls[2]);
    expect(calls[0]).toEqual({ method: 'POST', body, key: 'original-space-key' });
    expect(calls[2]).toEqual({ method: 'PUT', body: sample('creation-home').body, key: 'original-home-key' });
    expect(misses).toEqual([]);
  } finally { replay.dispose(); }
});

test('an independent Zone attaches an existing Realm through the production client and keeps its canonical address', async () => {
  const labels = ['creation-space', 'creation-home', 'creation-address',
    ...creation.personas.owner.filter(item => item.label.startsWith('creation-management-')).map(item => item.label),
    'creation-attachment-configuration', 'creation-attachment-resolve', 'creation-attachment-resolve-realm',
    'creation-attachment-save', 'creation-attached-configuration', 'creation-attached-configuration-realm',
    'creation-attached-presentation', 'creation-attached-address'];
  const replay = recordedFetch(creation, 'owner', labels.map(label => ({ label, state: 'populated' })), { pathPrefix: BFF_PREFIX, sequence: true });
  const calls: { method: string; body: unknown; path: string; key: string | null }[] = [];
  const misses: unknown[] = [];
  const main = browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    const url = new URL(request.url);
    calls.push({ method: request.method, body: text ? JSON.parse(text) : undefined,
      path: url.pathname.slice(BFF_PREFIX.length) + url.search, key: request.headers.get('idempotency-key') });
    try { return await replay.fetcher(request); }
    catch (error) { misses.push(error); throw error; }
  }) as typeof fetch });
  try {
    const creator = realmSiteCreationClient(main);
    const created = await creator.create(body, 'new-independent-space');
    if (!created.ok) throw new Error('Independent Zone was not created');
    expect((await creator.prepare(created.data, body.actingSubject, 'prepare-home')).ok).toBe(true);
    const before = await creator.destination(created.data, body.actingSubject, 'en');
    if (!before.ok) throw new Error('Canonical destination was not available');
    const canonical = (sample('creation-address').answer as { canonical: CanonicalAddress }).canonical;
    expect(before.data.attachmentPath).toBe(`/manage/z/${addressKey(canonical)}/realm`);
    const frame = await readZoneManagementFrame(main, addressKey(canonical), 'en', body.actingSubject);
    expect(frame.authoring.kind).toBe('ready');
    const zoneId = created.data.zone.slice(-36);
    const attachmentClient = browserZoneRealmAttachment(main);
    const basis = await attachmentClient.readConfiguration(zoneId, body.actingSubject);
    if (!basis.ok) throw new Error('Attachment basis was not available');
    expect(basis.data.realm).toBeNull();
    const handle = new URL(sample('creation-attachment-resolve').path, 'https://record.invalid').searchParams.get('key')!;
    const existing = await attachmentClient.resolveRealmHandle(handle, body.actingSubject);
    if (!existing.ok) throw new Error('Existing Realm was not resolved');
    const write = { expectedHead: basis.data.revision, actingSubject: body.actingSubject, defaultRealm: existing.data.realm };
    expect(write as unknown).toEqual(sample('creation-attachment-save').body);
    expect((await attachmentClient.saveConfiguration(zoneId, write, 'attach-existing-realm')).ok).toBe(true);
    const after = await attachmentClient.readConfiguration(zoneId, body.actingSubject);
    if (!after.ok) throw new Error('Saved attachment was not readable');
    expect(after.data.realm).toBe(existing.data.realm);
    expect(after.data.name).toBe(existing.data.name);
    const presentation = await zonePresentationReads(main, body.actingSubject).readPresentation(zoneId);
    expect(presentation as unknown).toEqual({ ok: true, data: sample('creation-attached-presentation').answer });
    // Configuration and public presentation are separate answers; publication owns when the Realm becomes public.
    if (presentation.ok) expect(presentation.data.realm).toBeNull();
    expect(await creator.destination(created.data, body.actingSubject, 'en')).toEqual(before);
    expect(before.data.sitePath).toBe(canonicalHref(canonical, 'en'));
    expect(calls).toHaveLength(labels.length);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'POST')[0]!.body).toEqual(body);
    expect(calls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([sample('creation-home').body, write]);
    expect(calls.every(call => call.method === 'GET' ? new URL(call.path, 'https://record.invalid').searchParams.get('actingSubject') === body.actingSubject
      : (call.body as { actingSubject: string }).actingSubject === body.actingSubject)).toBe(true);
    expect(misses).toEqual([]);
  } finally { replay.dispose(); }
});


test('the production attachment route shares its exact composition with recorded controls', async () => {
  expect(routeView).toBe(zoneRealmAttachmentView);
  const labels = ['creation-management-address', 'creation-management-configuration', 'creation-management-zone',
    'creation-management-editor', 'creation-attachment-configuration'];
  const replay = recordedFetch(creation, 'owner', labels.map(label => ({ label, state: 'populated' })), { pathPrefix: BFF_PREFIX, sequence: true });
  try {
    const main = browserMainApi('https://record.invalid', { fetcher: replay.fetcher });
    const canonical = (sample('creation-address').answer as { canonical: CanonicalAddress }).canonical;
    const frame = await readZoneManagementFrame(main, addressKey(canonical), 'en', body.actingSubject);
    const view = await zoneRealmAttachmentView({ main, anonymous: browserMainApi('https://record.invalid', { anonymous: true, fetcher: replay.fetcher }),
      actingSubject: body.actingSubject, locale: 'en', signInHref: '/en/sign-in', loadAuthoring: async () => frame.authoring });
    expect(isValidElement(view)).toBe(true);
    if (!isValidElement<{ zoneId: string; attachedRealm: string | null; actingSubject: string }>(view)) throw new Error('Missing route controls');
    expect(view.type).toBe(RealmAttachmentEditor);
    expect(view.props).toMatchObject({ zoneId: (sample('creation-space').answer as { zone: string }).zone.slice(-36),
      attachedRealm: null, actingSubject: body.actingSubject });
  } finally { replay.dispose(); }
});

for (const persona of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: the actual route preserves its recorded authoring and attachment authority`, async () => {
    const frameLabels = ['management-address', 'management-configuration', 'management-zone', 'management-editor'];
    const selections = creation.personas[persona].filter(item => frameLabels.includes(item.label) || item.label === 'attachment-route-configuration' || item.label === 'attachment-route-name');
    const replay = recordedFetch(creation, persona, selections.map(item => ({ label: item.label, state: item.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX });
    try {
      const main = browserMainApi('https://record.invalid', { fetcher: replay.fetcher });
      const query = new URL(selections.find(item => item.label === 'management-address')!.path, 'https://record.invalid').searchParams;
      const actor = query.get('actingSubject')!;
      const frame = await readZoneManagementFrame(main, query.get('key')!, 'en', actor);
      const view = await zoneRealmAttachmentView({ main, anonymous: browserMainApi('https://record.invalid', { anonymous: true, fetcher: replay.fetcher }),
        actingSubject: actor, locale: 'en', signInHref: '/en/sign-in', loadAuthoring: async () => frame.authoring });
      if (!isValidElement<{ failure: string; actingSubject: string }>(view)) throw new Error('Missing route result');
      if (frame.authoring.kind === 'failure') {
        expect(view.type).toBe(ZoneAuthoringFailure);
        expect(view.props.failure).toBe(frame.authoring.failure);
      } else {
        expect(frame.authoring.kind).toBe('ready');
        expect(view.type).toBe(RealmAttachmentEditor);
        expect(view.props.actingSubject).toBe(actor);
      }
    } finally { replay.dispose(); }
  });
}
