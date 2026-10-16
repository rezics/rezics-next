import { expect, test } from 'bun:test';
import type { CanonicalAddress } from '@rezics/model/address';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import creationJson from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import attachmentJson from '../../../../tests/qa/fixtures/outcomes/zone/attach-a-realm.json';
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
