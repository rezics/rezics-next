import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/list-attached-zones.json';
import { addressPath } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedManagementAgent } from '../realm/realm-membership-recorded-page.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { readZoneAttachments } from './read.ts';
import { attachmentIdentity, attachmentSelections, type AttachmentVisit } from './zone-attachments-recorded-page.ts';

const record = answers as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
function open(persona: AnswerPersona, visit: AttachmentVisit = 'inventory') {
  const replay = recordedFetch(record, persona, attachmentSelections(record, persona, visit), { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return { ...attachmentIdentity(record, persona), fetcher: replay.fetcher,
    main: browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher }) };
}

for (const [persona, visit] of [['owner', 'inventory'], ['operator', 'inventory'], ['moderator', 'delegated']] as const) {
  test(`${persona}/${visit} traverses its own recorded 24-item pages, canonical addresses and withdrawal coordinates`, async () => {
    const { main, realm, actingSubject } = open(persona, visit);
    let cursor: string | null = null;
    const seen: string[] = [];
    let index = 0;
    do {
      const result = await readZoneAttachments(main, realm, actingSubject, cursor);
      if (!result.ok) throw new Error(result.failure);
      const label = `${visit}-${index++}`;
      const sample = record.personas[persona].find(item => item.label === label)!;
      expect<unknown>(result.data).toEqual(sample.answer);
      expect(new URL(sample.path, 'https://recorded.invalid').searchParams.get('limit')).toBe('24');
      expect(result.data.items.length).toBeLessThanOrEqual(24);
      expect(result.data.complete).toBe(result.data.nextCursor === null);
      for (const item of result.data.items) {
        expect(item.withdraw).toEqual({ method: 'POST', path: `/v1/zones/${item.zone.slice(-36)}/realm-attachment-withdrawals` });
        expect(addressPath(`${item.address.prefix}${item.address.key}`)).toMatchObject({
          lookup: { scope: 'space', key: item.address.key }, surface: 'site', tail: [],
        });
        seen.push(item.zone);
      }
      cursor = result.data.nextCursor;
    } while (cursor);
    expect(index).toBe(3);
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
    expect(seen).toEqual([...seen].sort());
  });
}
for (const persona of ['stranger', 'member', 'moderator', 'operator'] as const) {
  test(`${persona} preserves the concealed status, code and title without inventory fields`, async () => {
    const { main, realm, actingSubject } = open(persona, persona === 'operator' ? 'bare' : 'inventory');
    expect(await readZoneAttachments(main, realm, actingSubject)).toEqual({ ok: false, failure: 'missing',
      problem: { status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' } });
  });
}
test('visitor missing, one and fifty attachment probes have the identical concealed answer', () => {
  expect(record.personas.visitor).toHaveLength(5);
  for (const sample of record.personas.visitor) {
    expect(sample.status).toBe(404);
    expect(sample.answer).toEqual(record.personas.visitor[0]!.answer);
  }
});
test('revocation conceals a retained production cursor rather than restarting or retaining inventory', async () => {
  const { main, realm, actingSubject } = open('moderator', 'revoked');
  const first = await readZoneAttachments(main, realm, actingSubject);
  if (!first.ok) throw new Error(first.failure);
  expect(first.data.nextCursor).not.toBeNull();
  expect(await readZoneAttachments(main, realm, actingSubject, first.data.nextCursor)).toMatchObject({ ok: false,
    failure: 'missing', problem: { status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' } });
});
for (const persona of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}'s production session reader retains that persona's visible identity`, async () => {
    const { fetcher, actingSubject } = open(persona);
    const session = await recordedManagementAgent(fetcher, 'en');
    expect(session.actingSubject).toBe(actingSubject);
    const profile = record.personas[persona].find(sample => sample.label === 'session-4')!.answer as { displayName: string };
    expect(session.agent.label).toBe(profile.displayName);
  });
}
