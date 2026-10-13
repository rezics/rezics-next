import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import rulesRecord from '../../../../tests/qa/fixtures/outcomes/realm/rules.json';
import { BFF_PREFIX } from '../api/browser.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { publishedRealmRules, readRealmRulesRecorded, type RealmRulesMapped } from './realm-rules-recorded-page.ts';
import type { RealmHeader, SettingsView } from './types.ts';

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

function commandOf(persona: AnswerPersona, label: string) {
  const body = sampleOf(persona, label).body;
  if (!body || typeof body !== 'object') throw new Error(`${label} has no command`);
  const command = body as {
    expectedGeneration?: unknown; expectedRulesRevision?: unknown;
    settings?: { rules?: { body?: { labels?: Record<string, string> } }[] };
  };
  const text = command.settings?.rules?.[0]?.body?.labels?.en;
  if (typeof command.expectedGeneration !== 'string' || typeof command.expectedRulesRevision !== 'string' || typeof text !== 'string') {
    throw new Error(`${label} command does not compare a rules revision`);
  }
  return { expectedGeneration: command.expectedGeneration, expectedRulesRevision: command.expectedRulesRevision, text };
}

function realmId(path: string): string {
  const id = path.split('?')[0]?.split('/')[3];
  if (!id) throw new Error(`No realm in ${path}`);
  return decodeURIComponent(id);
}

async function replay(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  return readRealmRulesRecorded(transport.fetcher, record, persona, selections);
}

function shown<Kind extends RealmRulesMapped['kind']>(mapped: RealmRulesMapped, kind: Kind) {
  if (mapped.kind === 'discrepancy') throw new Error(mapped.detail);
  if (mapped.kind !== kind) throw new Error(`expected ${kind}, received ${mapped.kind}`);
  return mapped as Extract<RealmRulesMapped, { kind: Kind }>;
}

function publishedOf(rules: RealmHeader['rules']) {
  const mapped = publishedRealmRules(rules);
  if (!mapped) throw new Error('recorded rules did not map');
  return mapped;
}

function firstRule(header: RealmHeader) {
  const rule = header.rules?.[0];
  if (!rule) throw new Error('recorded header has no rule');
  return rule;
}

function englishBody(text: string | null | undefined, label: string): string {
  if (typeof text !== 'string') throw new Error(`${label} has no English body`);
  return text;
}

function revisionOf(revision: string | null, label: string): string {
  if (revision === null) throw new Error(`${label} has no revision`);
  return revision;
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

test('visitor published rules replay the recorded English answer', async () => {
  const { sample, header } = headerOf('visitor', 'public-rules-en');
  const loaded = await replay('visitor', [{ label: 'public-rules-en', state: 'populated' }]);
  const mapped = shown(loaded.mapped, 'published');
  const rule = firstRule(header);
  expect(mapped.name).toEqual({ value: header.name.value, lang: header.name.language, dir: header.name.direction });
  expect(mapped.rules).toEqual(publishedOf(header.rules));
  expect(mapped.rules[0]?.title).toBe(rule.title.value);
  expect(mapped.rules[0]?.body).toBe(rule.body.value);
  expect(mapped.rules[0]?.lang).toBe(rule.title.language);
  expect(sample.status).toBe(200);
});

test('visitor Chinese and French answers keep their recorded language', async () => {
  const chinese = firstRule(headerOf('visitor', 'public-rules-zh').header);
  const french = firstRule(headerOf('visitor', 'public-rules-fr').header);
  const zh = shown((await replay('visitor', [{ label: 'public-rules-zh', state: 'populated' }])).mapped, 'published');
  const fr = shown((await replay('visitor', [{ label: 'public-rules-fr', state: 'populated' }])).mapped, 'published');
  expect(zh.rules[0]).toMatchObject({ title: chinese.title.value, body: chinese.body.value, lang: chinese.title.language });
  expect(chinese.title.language).toBe('zh-Hans');
  expect(fr.rules[0]).toMatchObject({ title: french.title.value, body: french.body.value, lang: french.title.language });
  expect(french.title.basis).toBe('fallback');
  expect(french.title.language).toBe('en');
});

test('member private rules stay the recorded Chinese rule', async () => {
  const { header } = headerOf('member', 'private-rules-zh');
  const mapped = shown((await replay('member', [{ label: 'private-rules-zh', state: 'populated' }])).mapped, 'published');
  expect(mapped.name.value).toBe(header.name.value);
  expect(mapped.rules).toEqual(publishedOf(header.rules));
});

test('owner rules with an empty list stay empty', async () => {
  const { header } = headerOf('owner', 'rules-empty');
  const mapped = shown((await replay('owner', [{ label: 'rules-empty', state: 'empty' }])).mapped, 'empty');
  expect(header.rules).toEqual([]);
  expect(mapped.name).toEqual({ value: header.name.value, lang: header.name.language, dir: header.name.direction });
});

test('owner settings with no rules keep the recorded revision', async () => {
  const { settings } = settingsOf('owner', 'rule-settings-empty');
  const mapped = shown((await replay('owner', [{ label: 'rule-settings-empty', state: 'empty' }])).mapped, 'settings');
  expect(mapped.settings).toEqual(settings);
  expect(mapped.settings.settings.rules).toEqual([]);
  expect(mapped.settings.ruleBasis.revision).toBe(settings.ruleBasis.revision);
});

test('visitor private realm shows the recorded landing, not the refusal', async () => {
  const refused = problemOf('visitor', 'private-rules-zh');
  const landing = objectAnswer('visitor', 'private-request-landing');
  const mapped = shown((await replay('visitor', [
    { label: 'private-rules-zh', state: 'error' },
    { label: 'private-request-landing', state: 'populated' },
  ])).mapped, 'landing');
  expect(mapped.page).toEqual(landing as typeof mapped.page);
  expect(mapped.page.name.value).not.toBe(refused.title);
  expect(refused.sample.status).toBe(404);
});

test('a private header refusal with no landing keeps the recorded problem', async () => {
  const refused = problemOf('visitor', 'private-rules-zh');
  const mapped = shown((await replay('visitor', [{ label: 'private-rules-zh', state: 'error' }])).mapped, 'refused');
  expect(mapped).toEqual({
    kind: 'refused',
    problem: { status: refused.sample.status, title: refused.title, code: refused.code },
    accepted: null,
    realm: realmId(refused.sample.path),
    header: null,
    agent: null,
  });
});

test('visitor settings denial keeps the recorded problem and no rules', async () => {
  const refused = problemOf('visitor', 'rule-settings-denied');
  const mapped = shown((await replay('visitor', [{ label: 'rule-settings-denied', state: 'error' }])).mapped, 'refused');
  expect(mapped.problem).toEqual({ status: refused.sample.status, title: refused.title, code: refused.code });
  expect(mapped.accepted).toBeNull();
  expect(mapped.realm).toBe(realmId(refused.sample.path));
  expect(refused.sample.status).toBe(401);
});

test('owner settings keep the recorded rules, revision and acting person', async () => {
  const { settings, sample } = settingsOf('owner', 'rule-settings');
  const { header } = headerOf('owner', 'public-rules-en');
  const profile = objectAnswer('owner', 'acting-agent-profile');
  if (typeof profile.id !== 'string' || typeof profile.displayName !== 'string' || profile.kind !== 'person'
    || (profile.handle !== null && typeof profile.handle !== 'string')) {
    throw new Error('owner profile is not the recorded person');
  }
  const actor = new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (actor === null) throw new Error('settings read has no acting subject');
  const mapped = shown((await replay('owner', [
    { label: 'public-rules-en', state: 'populated' },
    { label: 'acting-agent-profile', state: 'populated' },
    { label: 'rule-settings', state: 'populated' },
  ])).mapped, 'settings');
  expect(mapped.settings).toEqual(settings);
  expect(mapped.agent).toEqual({
    iri: profile.id, label: profile.displayName, handle: profile.handle, kind: profile.kind, path: null,
  });
  expect(mapped.agent?.iri).toBe(actor);
  expect(mapped.header?.name).toEqual(header.name);
  expect(sample.status).toBe(200);
});

test('a refused amendment keeps the last accepted rules', async () => {
  const accepted = settingsOf('owner', 'rule-settings');
  const conflict = problemOf('owner', 'rule-intent-conflict');
  const command = commandOf('owner', 'rule-intent-conflict');
  const mapped = shown((await replay('owner', [
    { label: 'rule-settings', state: 'populated' },
    { label: 'rule-intent-conflict', state: 'error' },
  ])).mapped, 'refused');
  expect(mapped.problem).toEqual({ status: conflict.sample.status, title: conflict.title, code: conflict.code });
  expect(mapped.accepted).toEqual(accepted.settings);
  const kept = englishBody(mapped.accepted?.settings.rules[0]?.body.labels.en, 'accepted rule');
  expect(kept).toBe(englishBody(accepted.settings.settings.rules[0]?.body.labels.en, 'recorded rule'));
  expect(kept).not.toBe(command.text);
  expect(command.expectedGeneration).toBe(accepted.settings.generation);
  expect(command.expectedRulesRevision).toBe(revisionOf(accepted.settings.ruleBasis.revision, 'accepted rules'));
  expect(conflict.sample.status).toBe(409);
});

test('an accepted amendment shows the recorded receipt', async () => {
  const before = settingsOf('owner', 'rule-settings');
  const receipt = settingsOf('owner', 'rules-published');
  const command = commandOf('owner', 'rules-published');
  const sample = sampleOf('owner', 'rules-published');
  const mapped = shown((await replay('owner', [
    { label: 'rule-settings', state: 'populated' },
    { label: 'rules-published', state: 'populated' },
  ])).mapped, 'settings');
  expect(mapped.settings).toEqual({
    generation: receipt.settings.generation,
    settings: receipt.settings.settings,
    ruleBasis: receipt.settings.ruleBasis,
  });
  const shownBody = englishBody(mapped.settings.settings.rules[0]?.body.labels.en, 'receipt rule');
  expect(shownBody).toBe(command.text);
  expect(shownBody).not.toBe(englishBody(before.settings.settings.rules[0]?.body.labels.en, 'previous rule'));
  expect(command.expectedGeneration).toBe(before.settings.generation);
  expect(command.expectedRulesRevision).toBe(revisionOf(before.settings.ruleBasis.revision, 'previous rules'));
  expect(sample.status).toBe(201);
  expect((sample.answer as { replayed?: unknown }).replayed).toBe(false);
});
