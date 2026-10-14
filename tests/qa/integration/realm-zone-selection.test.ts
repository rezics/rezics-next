import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fromPlainText } from '@rezics/document';
import { personaNames, personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../support/personas.ts';

let sessions: PersonaSessions;
let inventory: string[];
const spaces = new Map<string, string>();
const missing = randomUUID();
const evidence = `.temp/goal/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}-realm-zone-selection.jsonl`;
let state = 'prepare';
const record = (value: object) => appendFileSync(evidence, `${JSON.stringify({ state, ...value })}\n`);
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `?${new URLSearchParams({ actingSubject: person.actingSubject })}` : '';
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function publish(zone: string) {
  const owner = sessions.owner, path = `/v1/zones/${short(zone)}`;
  const head = await answer<{ revision: string }>(owner.main('GET', `${path}/configuration${acting(owner)}`));
  const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: head.revision, prepareHomeDocument: true, defaultRealm: sessions.realm, actingSubject: owner.actingSubject,
  }));
  const editor = await answer<{ configuration: { homeDocument: string }; preview: { navigation: { revision: string } } }>(
    owner.main('GET', `${path}/showcase-editor${acting(owner)}`));
  const page = editor.configuration.homeDocument, variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: page, variantId, expectedHead: null,
      document: fromPlainText('Published Realm entry', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: owner.actingSubject,
    }), 201);
  await answer(owner.main('POST', `${path}/site-publications`, {
    expectedHead: prepared.revision, actingSubject: owner.actingSubject,
    routesRevision: editor.preview.navigation.revision, navigationRevision: editor.preview.navigation.revision,
    pages: [{ page, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
}

async function select(name: PersonaName, expected: string | null) {
  const person = sessions[name], path = `/v1/realms/${short(sessions.realm)}/zone${acting(person)}`;
  const response = await person.main('GET', path), body = await response.text();
  const value = JSON.parse(body) as { zone?: string; realm?: string; code?: string };
  record({ persona: name, request: { method: 'GET', path }, expected: { status: expected ? 200 : 404, zone: expected },
    actual: { status: response.status, zone: value.zone ?? null }, response: { status: response.status, body } });
  expect(response.status, `${name}: ${body}`).toBe(expected ? 200 : 404);
  if (expected) expect(value).toMatchObject({ zone: expected, realm: sessions.realm });
  else {
    const absent = await person.main('GET', `/v1/realms/${missing}/zone${acting(person)}`);
    expect(absent.status).toBe(404);
    expect(body).toBe(await absent.text());
  }
}

async function visibility(zone: string, value: 'public' | 'private') {
  const owner = sessions.owner, path = `/v1/spaces/${short(spaces.get(zone)!)}/settings`;
  const head = await answer<{ generation: string }>(owner.main('GET', `${path}${acting(owner)}`));
  await answer(owner.main('PUT', path, { actingSubject: owner.actingSubject,
    expectedGeneration: head.generation, reason: 'Exercise reader-specific Realm entry',
    settings: { visibility: value, listing: 'listed' } }), 201);
}

beforeAll(async () => {
  mkdirSync('.temp/goal', { recursive: true });
  const started = Date.now();
  sessions = await personaSessions('public', { observeMain: async result => {
    record({ caller: result.caller.actingSubject, request: result.request, response: result.response,
      durationMs: result.answeredAt - result.requestStartedAt });
  } });
  const original = await answer<{ configuration: { space: string } }>(
    sessions.owner.main('GET', `/v1/zones/${short(sessions.zone)}/configuration${acting(sessions.owner)}`));
  spaces.set(sessions.zone, original.configuration.space);
  state = 'saved attachment without published Realm';
  for (const name of personaNames) await select(name, null);
  await publish(sessions.zone);
  state = 'single published Zone';
  for (const name of personaNames) await select(name, sessions.zone);
  const created = await answer<{ zone: string; space: string }>(sessions.owner.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Second Realm entry', language: 'en', visibility: 'public',
    listing: 'listed', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject,
  }), 201);
  spaces.set(created.zone, created.space);
  await publish(created.zone);
  const query = new URLSearchParams({ actingSubject: sessions.owner.actingSubject!, limit: '50' });
  const list = await answer<{ items: { zone: string }[]; complete: boolean }>(sessions.owner.main('GET',
    `/v1/realms/${short(sessions.realm)}/zone-attachments?${query}`));
  inventory = list.items.map(item => item.zone);
  expect(list.complete).toBe(true);
  expect(inventory).toEqual([sessions.zone, created.zone].sort());
  record({ preparationMs: Date.now() - started, inventory });
  expect(Date.now() - started).toBeLessThan(600_000);
  state = 'two public published attachments';
}, 600_000);

afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) test(`${name}: legal multiple attachments select the first eligible Zone in the observed inventory`, async () => {
  await select(name, inventory[0]!);
}, 90_000);

test('private candidates vary by reader, withdrawals remove entries, and a remaining single Zone still resolves', async () => {
  const [first, second] = inventory as [string, string];
  await visibility(first, 'private');
  state = 'first attachment private';
  for (const name of personaNames) await select(name, name === 'owner' ? first : second);
  await visibility(second, 'private');
  state = 'no candidate visible to other readers';
  for (const name of personaNames) await select(name, name === 'owner' ? first : null);
  await visibility(second, 'public');
  await answer(sessions.owner.main('POST', `/v1/zones/${short(first)}/realm-attachment-withdrawals`, {
    realm: sessions.realm, actingSubject: sessions.owner.actingSubject,
  }));
  state = 'first withdrawn; single public Zone';
  for (const name of personaNames) await select(name, second);
  await answer(sessions.owner.main('POST', `/v1/zones/${short(second)}/realm-attachment-withdrawals`, {
    realm: sessions.realm, actingSubject: sessions.owner.actingSubject,
  }));
  state = 'both attachments withdrawn';
  for (const name of personaNames) await select(name, null);
}, 180_000);
