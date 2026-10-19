import { afterAll, expect, test } from 'bun:test';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/work-hub-and-edition-choice.json';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import type { Loaded } from './types.ts';
import { work, workRef } from './fixtures.ts';
import { nextAction } from './primary-action.tsx';
import type { ReadStart } from './read.ts';
import { messages } from './messages.ts';

const answer = (label: string) => anime.personas.member.find(item => item.label === label)!.answer;
const saved = answer('hub-status-preference') as EditionPreference;
const summary = answer('hub-status-progress') as ProgressSummary;
let preference: Loaded<EditionPreference | null> = { ok: true, data: saved };
let progress: Loaded<ProgressSummary> = { ok: true, data: summary };
let start: ReadStart = null;
const languages: (string | undefined)[] = [];
const original = { ...(await import('./read.ts')) };
const restore = replaceModule(import.meta.resolve('./read.ts'), original, {
  readStart: async () => start,
  readEditionPreference: async () => preference,
  readReleases: async () => ({ ok: true, data: answer('hub-releases') }),
  readProgressSummary: async (_id: string, language?: string) => { languages.push(language); return progress; },
});
afterAll(restore);
const { PrimaryAction } = await import('./hub-sections.tsx');
const action = () => PrimaryAction({ workRef, id: workRef, work, locale: 'en', messages: messages.en });

test('an owner-confirmed saved edition suppresses a second edition-choice action despite release inventory', async () => {
  preference = { ok: true, data: saved };
  progress = { ok: true, data: summary };
  expect(await action()).toBeNull();
  expect(languages.at(-1)).toBe(saved.language);
});

test('a reader with no saved edition can choose from the admitted release inventory', async () => {
  preference = { ok: true, data: null };
  progress = { ok: false, failure: 'unavailable' };
  expect((await action())?.props.action).toEqual({ kind: 'choose', href: '#availability', part: null });
});


test('an owner-confirmed language-only preference suppresses a redundant edition choice', async () => {
  preference = { ok: true, data: { ...saved, edition: null } };
  progress = { ok: false, failure: 'unavailable' };
  expect(await action()).toBeNull();
  expect(languages.at(-1)).toBe(saved.language);
});

test('a refused contents read never becomes a Read action', () => {
  expect(nextAction({ start: { kind: 'unavailable', ok: false, failure: 'unavailable', status: 503 },
    progress: null, preference: null, releases: 0 })).toBeNull();
  expect(nextAction({ start: { kind: 'contents' }, progress: null, preference: null, releases: 0 }))
    .toEqual({ kind: 'read', start: { kind: 'contents' } });
});

test('production primary actions retain contents failure and recovery with saved and absent choice', async () => {
  start = { kind: 'unavailable', ok: false, failure: 'unavailable', status: 503 };
  progress = { ok: false, failure: 'unavailable' };
  preference = { ok: true, data: { ...saved, edition: null } };
  const retained = await action();
  expect(retained?.props.children[0].props).toMatchObject({ title: messages.en.contents, failure: 'unavailable' });
  expect(retained?.props.children[1]).toBeNull();
  preference = { ok: true, data: null };
  const choosing = await action();
  expect(choosing?.props.children[0].props.failure).toBe('unavailable');
  expect(choosing?.props.children[1].props.action).toEqual({ kind: 'choose', href: '#availability', part: null });
  start = null;
});
