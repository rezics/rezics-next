import { afterEach, expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/withdraw-a-realm-attachment.json';
import { browserZoneRealmAttachment, commitCommand } from '../zone-editor/api.ts';
import { commandLane } from '../api/command.ts';
import { browserMainApi } from '../api/browser.ts';
import { readZoneManagementFrame } from '../zone-editor/authoring-reads.ts';
import { readZoneAttachments, settle } from './read.ts';
import { withdrawRealmAttachment } from './zone-attachments-api.ts';
import { withdrawalReplay } from './zone-attachment-withdrawal-recorded-page.ts';

const record = answers as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
function open(...args: Parameters<typeof withdrawalReplay>) {
  const replay = withdrawalReplay(...args);
  disposals.push(replay.dispose);
  return replay;
}
for (const persona of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona} keeps its session identity and the Realm inventory's exact answer/problem`, async () => {
    const replay = open(record, persona, 'realm');
    const { agent, actingSubject } = await replay.session();
    const profile = record.personas[persona].find(sample => sample.label === 'realm-session-profile')!.answer as { displayName: string };
    expect(agent).toMatchObject({ iri: actingSubject, label: profile.displayName });
    const sample = record.personas[persona].find(item => item.label === 'realm-attachments')!;
    const result = await readZoneAttachments(replay.main, replay.coordinate, actingSubject);
    if (sample.status === 200) {
      expect<unknown>(result).toEqual({ ok: true, data: sample.answer });
    } else {
      expect(result).toEqual({ ok: false, failure: 'missing', problem: {
        status: sample.status, code: 'realm_unavailable', title: 'Realm is unavailable',
      } });
    }
  });
  test(`${persona} uses the production Zone admission and conditional configuration reads`, async () => {
    const replay = open(record, persona, 'zone');
    const { actingSubject } = await replay.session();
    const frame = await readZoneManagementFrame(replay.main, replay.coordinate, 'en', actingSubject);
    if (persona !== 'member' && persona !== 'operator') {
      expect(frame.authoring).toEqual({ kind: 'failure', failure: 'denied' });
      return;
    }
    expect(frame.authoring.kind).toBe('ready');
    if (frame.authoring.kind !== 'ready') throw new Error('Zone authoring was refused');
    const id = frame.authoring.model.zoneId;
    const configuration = await settle(() => replay.main.v1.zones({ id }).configuration.get({ query: { actingSubject } }), { management: true });
    expect<unknown>(configuration).toEqual({ ok: true, data: record.personas[persona].find(item => item.label === 'attachment-configuration')!.answer });
    if (!configuration.ok) throw new Error(configuration.failure);
    const attached = configuration.data.configuration.defaultRealm;
    if (persona === 'operator') { expect(attached).toBeUndefined(); return; }
    expect(attached).toBeString();
    const named = await settle(() => replay.anonymous.v1.realms({ realm: attached!.slice(-36) }).get({ query: {} }));
    expect<unknown>(named).toEqual({ ok: true, data: record.personas.member.find(item => item.label === 'attachment-name')!.answer });
    const body = { expectedHead: configuration.data.revision, actingSubject, defaultRealm: null };
    expect<unknown>(body).toEqual(record.personas.member.find(item => item.label === 'attachment-remove')!.body);
    const client = browserZoneRealmAttachment(replay.main);
    const lane = commandLane<typeof body, Awaited<ReturnType<typeof client.saveConfiguration>>>({ ok: false, failure: 'unavailable' });
    const result = await lane.submit(body, (captured, round) => commitCommand(round, key => client.saveConfiguration(id, captured, key)));
    expect(result).toMatchObject({ ok: true, data: { revision: expect.any(String) } });
  });
}
for (const [persona, surface] of [['owner', 'realm'], ['moderator', 'delegated-realm'], ['operator', 'realm']] as const) {
  test(`${persona}/${surface} withdraws the exact recorded Zone using Realm authority and a retained key`, async () => {
    const replay = open(record, persona, surface);
    const { actingSubject } = await replay.session();
    const sample = record.personas[persona].find(item => item.label === `${surface}-withdraw`)!;
    const zone = sample.path.split('/')[3]!;
    const input = { zone, realm: replay.coordinate, actingSubject, key: crypto.randomUUID() };
    const keys: (string | null)[] = [];
    const main = browserMainApi('https://recorded.invalid', { fetcher: (async (input, init) => {
      keys.push(new Request(input, init).headers.get('idempotency-key'));
      return replay.fetcher(input, init);
    }) as typeof fetch });
    const result = await withdrawRealmAttachment(main, input);
    expect(result).toMatchObject({ ok: true, data: sample.answer });
    await withdrawRealmAttachment(main, input);
    expect(keys).toEqual([input.key, input.key]);
    const inventory = await readZoneAttachments(replay.main, replay.coordinate, actingSubject);
    if (!inventory.ok) throw new Error(inventory.failure);
    expect(inventory.data.items.some(item => item.zone.endsWith(zone))).toBe(true);
    expect(sample.body).toEqual({ realm: `https://rezics.com/id/${replay.coordinate}`, actingSubject });
  });
}
test('visitor authenticates before Main reads; loading holds a real inventory request', async () => {
  expect(record.personas.visitor).toEqual([]);
  const replay = open(record, 'owner', 'realm', true);
  const { actingSubject } = await replay.session();
  let finished = false;
  const held = readZoneAttachments(replay.main, replay.coordinate, actingSubject).finally(() => { finished = true; });
  await Bun.sleep(10);
  expect(finished).toBe(false);
  replay.dispose();
  await held;
});
