import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicAgentProfile } from '../features/auth/agent-profile.ts';
import { communityNames } from '../features/communities/name-fields.ts';
import { suggestedLanguages, textAttributes, UNSPECIFIED, writingLanguage } from '../features/content-language/writing-language.ts';
import { mainThreadApi, replyProgress, type ReplyInput } from '../features/feed/thread-api.ts';
import { newPostProgress, submitPost } from '../features/post-composer/api.ts';
import { profileSaveInput, saveAgentProfile } from '../features/settings/profile-api.ts';

// G-515: what a person writes is in the language they chose. The interface
// locale names languages on screen; it never becomes the language of the text.

interface Draft { language: string; direction: string; body: string | null }
type Post = Parameters<typeof submitPost>[3];

function recordingMain() {
  const drafts: Draft[] = [];
  const selections: unknown[] = [];
  const main = { v1: {
    'main-versions': () => ({ selection: { get: async (input: unknown) => {
      selections.push(input);
      return { data: { work: 'work', selectedDraft: 'draft' } };
    } } }),
    'member-reply-drafts': { post: async (body: Draft) => { drafts.push(body); return { data: { revisionId: 'revision' } }; } },
    'realm-replies': { post: async () => ({ data: { reply: 'reply' } }) },
    'member-replies': () => ({ get: async () => ({ data: { revisionDigest: 'digest' } }) }),
    'realm-reply-placements': { post: async (body: { reply: string }) => ({ data: { reply: body.reply, placement: 'p' } }) },
  } };
  return { drafts, selections, main };
}

const intent = (language: string, body = 'Hello') => ({ realm: 'realm', work: 'work', mainVersion: 'main-version',
  title: 'Title', body, spoiler: false, language, actingSubject: 'author' });

describe('the language a writing surface starts in', () => {
  test('the item’s own language wins, then the first reading language, then unspecified', () => {
    expect(writingLanguage({ chosen: 'ko', existing: 'ja', reading: ['en'] })).toBe('ko');
    expect(writingLanguage({ existing: 'ja', reading: ['en'] })).toBe('ja');
    expect(writingLanguage({ reading: ['ar', 'en'] })).toBe('ar');
    expect(writingLanguage({ reading: [] })).toBe(UNSPECIFIED);
    expect(writingLanguage({ chosen: null, existing: null, reading: [] })).toBe('und');
  });

  test('suggestions are the current language, the original and what the writer reads, once each', () => {
    expect(suggestedLanguages({ reading: ['ja', 'en'], current: 'ko', original: 'en' })).toEqual(['ko', 'en', 'ja', 'und']);
    expect(suggestedLanguages({ reading: [] })).toEqual(['und']);
    expect(suggestedLanguages({ reading: ['zh-hans'], current: 'und' })).toEqual(['zh-Hans', 'und']);
  });

  test('direction follows the chosen language’s script, never the page', () => {
    expect(textAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(textAttributes('he-IL')).toMatchObject({ dir: 'rtl' });
    expect(textAttributes('ko')).toEqual({ lang: 'ko', dir: 'ltr' });
    expect(textAttributes('fa-Arab')).toMatchObject({ dir: 'rtl' });
    expect(textAttributes(UNSPECIFIED)).toEqual({ lang: undefined, dir: 'ltr' });
    // Looking at the text sets only its direction, never a language.
    expect(textAttributes(UNSPECIFIED, 'مرحبا')).toEqual({ lang: undefined, dir: 'rtl' });
  });
});

describe('a post is sent in the language its writer chose', () => {
  test.each([['ko', 'ltr', '안녕하세요'], ['ar', 'rtl', 'مرحبا'], ['ja', 'ltr', 'こんにちは'], ['pt-BR', 'ltr', 'Olá']])(
    '%s', async (language, direction, body) => {
      const { drafts, selections, main } = recordingMain();
      const outcome = await submitPost(intent(language, body), newPostProgress(), () => undefined, main as unknown as Post);
      expect(outcome.kind).toBe('posted');
      expect(drafts[0]).toMatchObject({ language, direction });
      // The Work's default revision is the root whatever language the post is in.
      expect(selections[0]).toEqual({ query: {} });
    });

  test('an unspecified language is sent as und, with the direction of the words', async () => {
    const { drafts, selections, main } = recordingMain();
    await submitPost({ ...intent(UNSPECIFIED, 'שלום'), title: 'כותרת' }, newPostProgress(), () => undefined, main as unknown as Post);
    expect(drafts[0]).toMatchObject({ language: 'und', direction: 'rtl' });
    expect(selections[0]).toEqual({ query: {} });
  });
});

describe('a reply is sent in the language its writer chose', () => {
  const input = (language: string, body: string): ReplyInput => ({ realm: 'realm', work: 'work', rootRevision: 'root',
    parent: { reply: 'parent', revisionId: 'revision' }, body, language, actingSubject: 'author' });

  test.each([['ko', 'ltr', '네'], ['ar', 'rtl', 'نعم'], ['und', 'ltr', 'ok']])('%s', async (language, direction, body) => {
    const { drafts, main } = recordingMain();
    const api = mainThreadApi(() => main as never);
    expect((await api.reply(input(language, body), replyProgress())).kind).toBe('placed');
    expect(drafts[0]).toMatchObject({ language, direction, body });
  });
});

describe('a bio is saved in the language its writer chose', () => {
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const key = '00000000-0000-4000-8000-000000000003';
  const profile: PublicAgentProfile = { id: agent, displayName: 'Ada', revision: 'revision',
    bio: { text: 'Old bio', language: 'en' }, avatarSelection: null, avatarUrl: null };
  const saved = async (bioText: string, bioLanguage: string, given = profile) => {
    let body: { bio: { text: string; language: string } | null } | undefined;
    const result = await saveAgentProfile(profileSaveInput(given, { token: 'token', agent, displayName: 'Ada', bioText,
      bioLanguage, removeAvatar: false, key }), async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({}, { status: 201 });
    });
    return { result, bio: body?.bio };
  };

  test('Arabic stays Arabic whatever the page language', async () => {
    expect(await saved('مرحبا بكم', 'ar')).toEqual({ result: 'saved', bio: { text: 'مرحبا بكم', language: 'ar' } });
  });

  test('without a choice an unchanged bio keeps its language and a new one is unspecified', async () => {
    expect((await saved('Old bio', '')).bio?.language).toBe('en');
    expect((await saved('A new bio', '')).bio?.language).toBe('und');
    expect((await saved('A new bio', '', { ...profile, bio: null })).bio?.language).toBe('und');
  });

  test('a language Main would not accept is refused before sending', async () => {
    expect((await saved('Hello', 'not a tag')).result).toBe('invalid');
  });
});

describe('a community declares the language of its name, description and rules', () => {
  test('Japanese is the original of the name and description as written', () => {
    expect(communityNames('ja', 'ミステリー部', '謎解きの集まり', [])).toEqual({
      name: { original: 'ja', labels: { ja: 'ミステリー部' } },
      description: { original: 'ja', labels: { ja: '謎解きの集まり' } } });
    expect(communityNames('und', 'Name', 'Description', [])?.name.original).toBe('und');
  });
});

// The class guard: no writing surface may take the language of what is written
// from the interface locale. Each line below is how that mistake reads.
const root = resolve(import.meta.dir, '..');
const surfaces = ['features/post-composer/composer.tsx', 'features/post-composer/api.ts', 'features/feed/reply-composer.tsx',
  'features/feed/thread-api.ts', 'features/realm/thread-view.tsx', 'features/work-page/reviews.tsx',
  'features/library/row-parts.tsx', 'features/settings/profile-api.ts', 'features/settings/profile-edit-form.tsx',
  'features/communities/create-form.tsx', 'features/manage/rules-editor.tsx', 'features/manage/rules.ts',
  'features/manage/settings-view.tsx', 'app/[locale]/settings/profile/route.ts'];
const stamps: Array<[string, RegExp]> = [
  ['language: locale', /\blanguage\s*:\s*(?:ui)?locale\b/i],
  ['language taken from a locale fallback', /\blanguage\b[^\n]*\?\?\s*(?:ui)?locale\b/i],
  ['a language state that starts in the locale', /\b(?:language|Language)\b[^\n]*useState[^\n]*\((?:ui)?locale\)/],
  ['values.locale as the language', /values\.locale/],
  ['the locale as a fixed direction', /direction:\s*'ltr'/],
  ['the UI locales as the language choices', /uiLocales/],
];

describe('class guard: the interface locale never becomes the language of the text', () => {
  for (const file of surfaces) {
    test(file, () => {
      const source = readFileSync(resolve(root, file), 'utf8');
      for (const [name, pattern] of stamps) expect({ file, name, found: pattern.test(source) }).toEqual({ file, name, found: false });
    });
  }

  test('each writing surface offers the writer’s own choice', () => {
    for (const file of ['features/post-composer/composer.tsx', 'features/feed/reply-composer.tsx',
      'features/work-page/reviews.tsx', 'features/library/row-parts.tsx', 'features/settings/profile-edit-form.tsx',
      'features/communities/create-form.tsx', 'features/manage/rules-editor.tsx']) {
      expect(readFileSync(resolve(root, file), 'utf8')).toContain('content-language/language-select.tsx');
    }
  });
});
