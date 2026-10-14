import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { readZoneAttachments } from './read.ts';
import { withdrawRealmAttachment } from './zone-attachments-api.ts';
import { browserZoneRealmAttachment } from '../zone-editor/api.ts';
import { attachmentActor, attachmentFixture, attachmentRealm, attachmentZones } from './zone-attachments-fixtures.ts';
import { isolatedAttemptStorage } from './recovery-fixtures.ts';
import { performCommand, readCommand, retainCommand } from './safety-pending.ts';

test('the production inventory reader traverses 51 attachments without repeating or truncating them', async () => {
  const fixture = attachmentFixture('populated');
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const answer = await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor, cursor);
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error(answer.failure);
    expect(answer.data.complete).toBe(answer.data.nextCursor === null);
    seen.push(...answer.data.items.map(item => item.zone)); cursor = answer.data.nextCursor;
  } while (cursor);
  expect(seen).toEqual(attachmentZones);
  expect(fixture.requests).toHaveLength(3);
});

for (const persona of ['visitor', 'stranger', 'member', 'moderator', 'operator'] as const) {
  test(`${persona} has no inventory without Realm stewardship, including identities or a cursor`, async () => {
    const fixture = attachmentFixture('populated', persona);
    expect(await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor)).toEqual({
      ok: false, failure: 'missing', problem: { status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' },
    });
  });
}
test('delegated stewardship can traverse, and a revoked retained cursor conceals the inventory', async () => {
  const fixture = attachmentFixture('revoked', 'moderator', true);
  expect((await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor)).ok).toBe(true);
  expect(await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor, '24')).toMatchObject({ ok: false, failure: 'missing' });
});
test('a stale attachment cursor remains a refusal until the reader explicitly restarts at the first page', async () => {
  const fixture = attachmentFixture('moved');
  expect(await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor, '24'))
    .toMatchObject({ ok: false, failure: 'moved', problem: { code: 'stale_zone_attachment_cursor' } });
  expect(fixture.requests).toHaveLength(1);
  const restarted = await readZoneAttachments(fixture.client(), attachmentRealm, attachmentActor);
  expect(restarted).toMatchObject({ ok: true, data: { nextCursor: '24' } });
  expect(fixture.requests[1]?.path).not.toContain('cursor=');
});

test('Realm withdrawal binds the exact subjects and preserves a pending key until the receipt', async () => {
  const fixture = attachmentFixture('pending');
  const input = { zone: attachmentZones[0]!, realm: attachmentRealm, actingSubject: attachmentActor, key: 'stable-withdrawal' };
  expect(await withdrawRealmAttachment(fixture.client(), input)).toEqual({ ok: false, failure: 'pending' });
  expect(fixture.requests[0]).toMatchObject({ method: 'POST', key: input.key,
    body: { realm: `https://rezics.com/id/${attachmentRealm}`, actingSubject: attachmentActor } });
  const completed = attachmentFixture('populated');
  const answer = await withdrawRealmAttachment(completed.client(), input);
  expect(answer).toMatchObject({ ok: true, data: { receipt: 'attachment-withdrawn', replayed: false } });
  expect(completed.requests[0]?.key).toBe(input.key);
});

test('a refusal keeps its complete problem and cannot become a successful withdrawal', async () => {
  const fixture = attachmentFixture('refused');
  expect(await withdrawRealmAttachment(fixture.client(), { zone: attachmentZones[0]!, realm: attachmentRealm,
    actingSubject: attachmentActor, key: 'refused' })).toEqual({ ok: false, failure: 'denied', status: 403,
    code: 'realm_attachment_denied', title: 'Realm stewardship has ended' });
});

test('a reloaded withdrawal replays the retained actor, target and key instead of sending a new intent', async () => {
  const store = isolatedAttemptStorage('attachment-controller');
  const input = { zone: attachmentZones[0]!, realm: attachmentRealm, actingSubject: attachmentActor };
  const operation = `zone-attachment:${input.zone}`;
  const proposed = { realm: attachmentRealm, actingSubject: attachmentActor, input, key: 'original-key', status: 'recorded' as const };
  const pending = attachmentFixture('pending');
  const sendPending = () => performCommand(operation, proposed,
    attempt => withdrawRealmAttachment(pending.client(), { ...attempt.input, key: attempt.key }), store);
  expect(await sendPending()).toEqual({ ok: false, failure: 'pending' });
  expect(readCommand(attachmentRealm, attachmentActor, operation, store)?.key).toBe('original-key');
  const confirmed = attachmentFixture('populated');
  const replayed = await performCommand(operation, { ...proposed, key: 'new-render-key' },
    attempt => withdrawRealmAttachment(confirmed.client(), { ...attempt.input, key: attempt.key }), store);
  expect(replayed.ok).toBe(true);
  expect(confirmed.requests[0]?.key).toBe('original-key');
  expect(confirmed.requests[0]?.body).toEqual(pending.requests[0]?.body);
  expect(readCommand(attachmentRealm, attachmentActor, operation, store)).toBeNull();
  expect(await retainCommand(operation, { ...proposed, realm: 'another-realm' }, store)).toBeNull();
  expect(await retainCommand(operation, { ...proposed, actingSubject: 'another-subject' }, store)).toBeNull();
});

for (const wrong of [{ zone: attachmentZones[1]! }, { realm: attachmentZones[1]! }, { receipt: '' }]) {
  test(`a withdrawal receipt cannot confirm a different target or an absent receipt: ${Object.keys(wrong)[0]}`, async () => {
    const main = browserMainApi('https://contract.invalid', { fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      zone: attachmentZones[0], realm: `https://rezics.com/id/${attachmentRealm}`, receipt: 'confirmed', replayed: false,
      sourcePosition: { datasetId: 'product', dataEpoch: 'contract-fixture', sequence: '2' }, ...wrong,
    })) as typeof fetch });
    expect(await withdrawRealmAttachment(main, { zone: attachmentZones[0]!, realm: attachmentRealm,
      actingSubject: attachmentActor, key: 'target-bound' })).toEqual({ ok: false, failure: 'unavailable' });
  });
}

test('Zone withdrawal uses only the Zone configuration head and does not clear other saved configuration', async () => {
  let captured: Request | null = null;
  const client = browserMainApi('https://contract.invalid', { fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = input instanceof Request ? input : new Request(input, init);
    return Response.json({ zone: attachmentZones[0], revision: attachmentZones[1], receipt: 'zone-receipt', replayed: false,
      sourcePosition: { datasetId: 'product', dataEpoch: 'contract-fixture', sequence: '3' } });
  }) as typeof fetch });
  const input = { zone: attachmentZones[0]!, expectedHead: attachmentZones[1]!, actingSubject: attachmentActor, key: 'zone-only' };
  expect((await browserZoneRealmAttachment(client).saveConfiguration(input.zone.slice(-36),
    { expectedHead: input.expectedHead, actingSubject: input.actingSubject, defaultRealm: null }, input.key)).ok).toBe(true);
  expect(captured).not.toBeNull();
  const request = captured as unknown as Request;
  expect(request.url).toEndWith(`/v1/zones/${input.zone.slice(-36)}/configuration`);
  expect(request.method).toBe('PUT');
  expect(request.headers.get('idempotency-key')).toBe(input.key);
  expect(await request.json()).toEqual({ expectedHead: input.expectedHead, actingSubject: input.actingSubject, defaultRealm: null });
});
