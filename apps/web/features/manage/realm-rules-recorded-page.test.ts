import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rulesRecord from '../../../../tests/qa/fixtures/outcomes/realm/rules.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readPublishedRealmHeader } from '../realm/read.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { saveSettings } from './commands.ts';
import { publishedRealmRules } from './realm-rules-recorded-page.ts';
import { readAgents, readRealmHeader, readSettings } from './read.ts';
import { readPrivateSpaceJoinPage } from './settings-api.ts';
import type { MainClient, RealmHeader, SettingsView } from './types.ts';
import { uuidOf } from './types.ts';

const record = rulesRecord as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sampleOf(persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing ${persona} sample ${label}`);
  return sample;
}

function objectAnswer(persona: AnswerPersona, label: string): Record<string, unknown> {
  const answer = sampleOf(persona, label).answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error(`${persona}/${label} answer is not a record`);
  return answer as Record<string, unknown>;
}

function headerOf(persona: AnswerPersona, label: string) {
  const answer = objectAnswer(persona, label);
  const name = answer.name;
  const rules = answer.rules;
  if (!name || typeof name !== 'object' || typeof (name as { value?: unknown }).value !== 'string') {
    throw new Error(`${label} has no name`);
  }
  if (!Array.isArray(rules)) throw new Error(`${label} rules are not a list`);
  return { sample: sampleOf(persona, label), header: answer as unknown as RealmHeader };
}

function settingsOf(persona: AnswerPersona, label: string) {
  const answer = objectAnswer(persona, label);
  const settings = answer.settings;
  const basis = answer.ruleBasis;
  if (typeof answer.generation !== 'string' || !settings || typeof settings !== 'object' || !basis || typeof basis !== 'object') {
    throw new Error(`${label} is not a settings answer`);
  }
  return { sample: sampleOf(persona, label), settings: answer as unknown as SettingsView };
}

function problemOf(persona: AnswerPersona, label: string) {
  const sample = sampleOf(persona, label);
  const answer = objectAnswer(persona, label);
  if (typeof answer.title !== 'string' || typeof answer.code !== 'string') throw new Error(`${label} has no problem title`);
  return { sample, title: answer.title, code: answer.code };
}

function realmId(path: string): string {
  const id = path.split('?')[0]?.split('/')[3];
  if (!id) throw new Error(`No realm in ${path}`);
  return decodeURIComponent(id);
}

function actingSubject(path: string): string {
  const value = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!value) throw new Error(`No acting subject in ${path}`);
  return value;
}

function settingsCommand(persona: AnswerPersona, label: string) {
  const body = sampleOf(persona, label).body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${label} has no command`);
  const command = body as Record<string, unknown>;
  const settings = command.settings;
  if (typeof command.actingSubject !== 'string' || typeof command.expectedGeneration !== 'string'
    || typeof command.reason !== 'string'
    || (command.expectedRulesRevision !== null && typeof command.expectedRulesRevision !== 'string')
    || !settings || typeof settings !== 'object' || Array.isArray(settings)
    || !Array.isArray((settings as { rules?: unknown }).rules)) {
    throw new Error(`${label} command is not a settings command`);
  }
  return command as Parameters<typeof saveSettings>[2];
}

function englishBody(text: string | null | undefined, label: string): string {
  if (typeof text !== 'string') throw new Error(`${label} has no English body`);
  return text;
}

function revisionOf(revision: string | null, label: string): string {
  if (revision === null) throw new Error(`${label} has no revision`);
  return revision;
}

function clientFor(persona: AnswerPersona, selections: readonly RecordedSelection[], anonymous: boolean): MainClient {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  return browserMainApi('https://recorded.invalid', { anonymous, fetcher: transport.fetcher });
}

async function unmatched(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('The production request matched a recorded answer');
}

test('published rules keep the recorded title, body and language', () => {
  const { header } = headerOf('visitor', 'public-rules-en');
  const rules = header.rules;
  if (!rules?.length) throw new Error('visitor public rules are empty');
  expect(publishedRealmRules(rules)).toEqual(rules.map(rule => ({
    id: rule.id,
    title: rule.title.value,
    body: rule.body.value,
    governed: rule.governanceRule !== null,
    lang: rule.title.language,
  })));
});

test('visitor published rules replay the recorded English and French answers', async () => {
  const english = headerOf('visitor', 'public-rules-en');
  const french = headerOf('visitor', 'public-rules-fr');
  const enClient = clientFor('visitor', [{ label: 'public-rules-en', state: 'populated' }], true);
  const frClient = clientFor('visitor', [{ label: 'public-rules-fr', state: 'populated' }], true);
  const en = await readRealmHeader(enClient, realmId(english.sample.path), 'en');
  const fr = await readRealmHeader(frClient, realmId(french.sample.path), 'fr');
  if (!en.ok || !fr.ok) throw new Error('recorded public rules did not load');
  const enRule = english.header.rules?.[0];
  const frRule = french.header.rules?.[0];
  if (!enRule || !frRule) throw new Error('recorded header has no rule');
  expect(publishedRealmRules(en.data.rules)).toEqual(publishedRealmRules(english.header.rules));
  expect(publishedRealmRules(en.data.rules)?.[0]).toMatchObject({
    title: enRule.title.value, body: enRule.body.value, lang: enRule.title.language,
  });
  expect(en.data.name).toEqual(english.header.name);
  expect(publishedRealmRules(fr.data.rules)?.[0]).toMatchObject({
    title: frRule.title.value, body: frRule.body.value, lang: frRule.title.language,
  });
  expect(frRule.title.basis).toBe('fallback');
  expect(frRule.title.language).toBe('en');
  expect(english.sample.status).toBe(200);
  expect(french.sample.status).toBe(200);
});

test('the recorded Chinese header is not the production language', async () => {
  const sample = sampleOf('visitor', 'public-rules-zh');
  expect(sample.path).toContain('language=zh-CN');
  const client = clientFor('visitor', [{ label: 'public-rules-zh', state: 'populated' }], true);
  const message = await unmatched(() => readRealmHeader(client, realmId(sample.path), 'zh-Hans'));
  expect(message).toContain('language=zh-Hans');
  expect(message).not.toContain('language=zh-CN');
});

test('the public rules header does not add language to match a recorded answer', async () => {
  const sample = sampleOf('visitor', 'public-rules-en');
  expect(sample.path).toContain('language=en');
  const client = clientFor('visitor', [{ label: 'public-rules-en', state: 'populated' }], true);
  const message = await unmatched(() => readPublishedRealmHeader(client, realmId(sample.path)));
  expect(message).toContain(`/v1/realms/${realmId(sample.path)}`);
  expect(message).not.toContain('language=');
});

test('owner rules with an empty list do not match a header that sends language', async () => {
  const { sample, header } = headerOf('owner', 'rules-empty');
  expect(header.rules).toEqual([]);
  expect(sample.path).not.toContain('language=');
  const client = clientFor('owner', [{ label: 'rules-empty', state: 'empty' }], false);
  const message = await unmatched(() => readRealmHeader(client, realmId(sample.path), 'en', actingSubject(sample.path)));
  expect(message).toContain('language=en');
  expect(message).toContain(encodeURIComponent(actingSubject(sample.path)));
});

test('owner settings with no rules keep the recorded revision', async () => {
  const { settings, sample } = settingsOf('owner', 'rule-settings-empty');
  const client = clientFor('owner', [{ label: 'rule-settings-empty', state: 'empty' }], false);
  const loaded = await readSettings(client, realmId(sample.path), actingSubject(sample.path));
  if (!loaded.ok) throw new Error('empty settings did not load');
  expect(loaded.data).toEqual(settings);
  expect(loaded.data.settings.rules).toEqual([]);
  expect(loaded.data.ruleBasis.revision).toBe(settings.ruleBasis.revision);
});

test('a private join page does not add language to match the recorded landing', async () => {
  const sample = sampleOf('visitor', 'private-request-landing');
  expect(sample.path).toContain('language=zh-CN');
  const client = clientFor('visitor', [{ label: 'private-request-landing', state: 'populated' }], true);
  const message = await unmatched(() => readPrivateSpaceJoinPage(client, realmId(sample.path)));
  expect(message).toContain('/join-page');
  expect(message).not.toContain('language=');
});

test('a private header refusal is not the public header query', async () => {
  const refused = problemOf('visitor', 'private-rules-zh');
  expect(refused.sample.path).toContain('language=zh-CN');
  expect(refused.sample.status).toBe(404);
  const client = clientFor('visitor', [{ label: 'private-rules-zh', state: 'error' }], true);
  const message = await unmatched(() => readPublishedRealmHeader(client, realmId(refused.sample.path)));
  expect(message).toContain(`/v1/realms/${realmId(refused.sample.path)}`);
  expect(message).not.toContain('language=');
  expect(message).not.toContain(refused.title);
});

test('visitor settings denial keeps the recorded problem and no rules', async () => {
  const refused = problemOf('visitor', 'rule-settings-denied');
  const client = clientFor('visitor', [{ label: 'rule-settings-denied', state: 'error' }], false);
  const loaded = await readSettings(client, realmId(refused.sample.path), actingSubject(refused.sample.path));
  expect(loaded).toEqual({
    ok: false,
    failure: 'sign-in',
    problem: { status: refused.sample.status, title: refused.title, code: refused.code },
  });
  expect(refused.sample.status).toBe(401);
});

test('owner settings keep the recorded rules, revision and acting person', async () => {
  const { settings, sample } = settingsOf('owner', 'rule-settings');
  const { header } = headerOf('owner', 'public-rules-en');
  const profile = objectAnswer('owner', 'acting-agent-profile');
  if (typeof profile.id !== 'string' || typeof profile.displayName !== 'string'
    || (profile.handle !== null && typeof profile.handle !== 'string')) {
    throw new Error('owner profile is not the recorded person');
  }
  const actor = actingSubject(sample.path);
  const client = clientFor('owner', [
    { label: 'public-rules-en', state: 'populated' },
    { label: 'acting-agent-profile', state: 'populated' },
    { label: 'rule-settings', state: 'populated' },
  ], false);
  const [loaded, headerRead, names] = await Promise.all([
    readSettings(client, realmId(sample.path), actor),
    readRealmHeader(client, realmId(sample.path), 'en', actor),
    readAgents(client, [actor], actor),
  ]);
  if (!loaded.ok || !headerRead.ok) throw new Error('owner rules did not load');
  expect(loaded.data).toEqual(settings);
  expect(names[actor]).toEqual({ iri: actor, label: profile.displayName, handle: profile.handle });
  expect(profile.id).toBe(actor);
  expect(uuidOf(actor)).toBe(profile.id.slice(-36));
  expect(headerRead.data.name).toEqual(header.name);
  expect(publishedRealmRules(headerRead.data.rules)?.[0]?.title).toBe(header.rules?.[0]?.title.value);
  expect(sample.status).toBe(200);
});

test('a refused amendment keeps the last accepted rules and the recorded problem', async () => {
  const accepted = settingsOf('owner', 'rule-settings');
  const conflict = problemOf('owner', 'rule-intent-conflict');
  const command = settingsCommand('owner', 'rule-intent-conflict');
  const client = clientFor('owner', [
    { label: 'rule-settings', state: 'populated' },
    { label: 'rule-intent-conflict', state: 'error' },
  ], false);
  const realm = realmId(accepted.sample.path);
  const actor = actingSubject(accepted.sample.path);
  const before = await readSettings(client, realm, actor);
  const refused = await saveSettings(client, realm, command, '00000000-0000-4000-8000-000000000234');
  const after = await readSettings(client, realm, actor);
  if (!before.ok || !after.ok) throw new Error('accepted settings did not load');
  expect(refused).toEqual({
    ok: false,
    failure: 'conflict',
    code: conflict.code,
    status: conflict.sample.status,
    title: conflict.title,
  });
  expect(after.data).toEqual(accepted.settings);
  expect(before.data).toEqual(after.data);
  const kept = englishBody(after.data.settings.rules[0]?.body.labels.en, 'accepted rule');
  expect(kept).toBe(englishBody(accepted.settings.settings.rules[0]?.body.labels.en, 'recorded rule'));
  expect(kept).not.toBe(englishBody(command.settings.rules[0]?.body.labels.en, 'refused command'));
  expect(command.expectedGeneration).toBe(accepted.settings.generation);
  expect(command.expectedRulesRevision).toBe(revisionOf(accepted.settings.ruleBasis.revision, 'accepted rules'));
  expect(conflict.sample.status).toBe(409);
});

test('an accepted amendment shows the recorded receipt', async () => {
  const before = settingsOf('owner', 'rule-settings');
  const receipt = settingsOf('owner', 'rules-published');
  const command = settingsCommand('owner', 'rules-published');
  const sample = sampleOf('owner', 'rules-published');
  const client = clientFor('owner', [{ label: 'rules-published', state: 'populated' }], false);
  const saved = await saveSettings(client, realmId(sample.path), command, '00000000-0000-4000-8000-000000000235');
  if (!saved.ok) throw new Error(`${saved.failure} ${saved.title ?? ''}`);
  expect(saved.data.generation).toBe(receipt.settings.generation);
  expect(saved.data.settings).toEqual(receipt.settings.settings);
  expect(saved.data.ruleBasis).toEqual(receipt.settings.ruleBasis);
  const shownBody = englishBody(saved.data.settings.rules[0]?.body.labels.en, 'receipt rule');
  expect(shownBody).toBe(englishBody(command.settings.rules[0]?.body.labels.en, 'command rule'));
  expect(shownBody).not.toBe(englishBody(before.settings.settings.rules[0]?.body.labels.en, 'previous rule'));
  expect(command.expectedGeneration).toBe(before.settings.generation);
  expect(command.expectedRulesRevision).toBe(revisionOf(before.settings.ruleBasis.revision, 'previous rules'));
  expect(sample.status).toBe(201);
  expect(saved.data.replayed).toBe(false);
});
