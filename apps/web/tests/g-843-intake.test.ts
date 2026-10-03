import { uuidToSid } from '@rezics/model/address';
import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../i18n/define.ts';
import {
  canCreate,
  creationKey,
  destinationOf,
  guessLanguage,
  mainIntake,
  sameSearch,
  searchable,
  searchBody,
  type SearchInput,
  type SearchState,
} from '../features/catalogue-intake/intake.ts';
import { candidates, found, receipt } from '../features/catalogue-intake/fixtures.ts';
import { copyOf, englishMessages, messages } from '../features/catalogue-intake/messages.ts';
import { ProvisionalNotice } from '../features/catalogue-intake/provisional-notice.tsx';

void mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
const { IntakeWizard } = await import('../features/catalogue-intake/intake-wizard.tsx');

const typed: SearchInput = { text: 'Sword Art Online', language: 'en', creator: '' };

describe('G-843 class guard: creating waits for a search that returned', () => {
  const states: [string, SearchState][] = [
    ['nothing searched', { phase: 'idle' }],
    ['a search running', { phase: 'searching', input: typed }],
    ['a failed search', { phase: 'failed', input: typed, reason: 'unavailable' }],
  ];
  for (const [name, state] of states) {
    test(`not reachable with ${name}`, () => expect(canCreate(state, typed)).toBe(false));
  }
  test('reachable once the search for exactly this input has returned', () =>
    expect(canCreate(found(typed), typed)).toBe(true));
  test('not reachable once the text, the language or the creator changed since the answer', () => {
    expect(canCreate(found(typed), { ...typed, text: 'Sword Art Online 2' })).toBe(false);
    expect(canCreate(found(typed), { ...typed, language: 'ja' })).toBe(false);
    expect(canCreate(found(typed), { ...typed, creator: 'Kawahara' })).toBe(false);
    expect(sameSearch(typed, { ...typed, text: ` ${typed.text} ` })).toBe(true);
  });
  test('the first render offers no way to create, whatever was typed', () => {
    const html = renderToStaticMarkup(
      createElement(IntakeWizard, {
        actingSubject: 'https://rezics.com/id/x',
        locale: 'en',
        initialText: 'Sword Art Online',
        port: undefined,
      }),
    );
    expect(html).toContain('Title, alias, creator or ISBN');
    expect(html).not.toContain('Add something new');
    expect(html).not.toContain('Create record');
  });
});

describe('G-843 search and routing', () => {
  test('a title is searched as the original title in the chosen language', () => {
    expect(searchBody(typed)).toEqual({
      profile: 'catalogue-candidates-v1',
      originalTitle: { value: 'Sword Art Online', language: 'en' },
      aliases: [],
      romanizations: [],
      creators: [],
      dates: [],
      identifiers: [],
    });
    expect(searchBody({ ...typed, creator: ' Reki Kawahara ' }).creators).toEqual([
      'Reki Kawahara',
    ]);
  });
  test('an ISBN-13, hyphenated or not, is also searched as an identifier; anything else is not', () => {
    expect(searchBody({ ...typed, text: '978-4-04-868760-9' }).identifiers).toEqual([
      { isbn13: '9784048687609' },
    ]);
    expect(searchBody({ ...typed, text: '12345' }).identifiers).toEqual([]);
  });
  test('one CJK character is worth searching, one Latin letter is not', () => {
    expect(searchable('剣')).toBe(true);
    expect(searchable('S')).toBe(false);
    expect(searchable(' SA ')).toBe(true);
  });
  test('kana and hangul default the language; other text keeps the choice', () => {
    expect(guessLanguage('ソードアート', 'en')).toBe('ja');
    expect(guessLanguage('소드 아트', 'en')).toBe('ko');
    expect(guessLanguage('Sword Art', 'de')).toBe('de');
  });
  test('the owner API Main names for realizations and releases is the editions page; anything else has none', () => {
    const work = candidates[1].work;
    expect(destinationOf('/v1/works/{work}/realizations/{realization}', work)).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route and its selections exact without reusing the link builder.
      `/w/${uuidToSid(work.slice(-36))}/edit/editions`,
    );
    expect(destinationOf('/v1/works/{work}/releases/{release}', work)).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent SID expectation keeps the route and its selections exact without reusing the link builder.
      `/w/${uuidToSid(work.slice(-36))}/edit/editions`,
    );
    expect(destinationOf('/v1/collections', null)).toBe('/library');
    expect(destinationOf('/v1/unknown', work)).toBeNull();
  });
  test('one idempotency key per search receipt', () =>
    expect(creationKey(receipt)).toBe(`catalogue-intake:${receipt}`));
});

describe('G-843 what Main answers becomes what the wizard says', () => {
  type Reply = {
    data?: unknown;
    error?: { status: number; value?: unknown };
    headers?: Record<string, string>;
    response?: Response;
  };
  const main = (replies: { candidates?: Reply; works?: Reply; header?: Reply }) =>
    ({
      v1: {
        catalogue: {
          candidates: { post: async () => ({ response: new Response(), ...replies.candidates }) },
        },
        works: Object.assign(async () => ({}), {
          post: async () => ({
            ...replies.works,
            response: new Response(null, { headers: replies.works?.headers }),
          }),
        }),
      },
    }) as never;
  const create = (works: Reply) =>
    mainIntake(main({ works })).create(typed, receipt, 'https://rezics.com/id/a', null);

  test('a candidate answer carries its receipt and candidates', async () => {
    const answer = await mainIntake(
      main({ candidates: { data: { candidateReceipt: receipt, candidates: [...candidates] } } }),
    ).search(typed);
    expect(answer).toMatchObject({ phase: 'found', receipt });
  });
  const problem = (status: number, code: string) => ({ error: { status, value: { code } } });
  test('only pending_creation_limit is the pending limit, and it carries Main’s Retry-After', async () => {
    expect(
      await create({ ...problem(429, 'pending_creation_limit'), headers: { 'retry-after': '60' } }),
    ).toEqual({ outcome: 'limit', retryAfter: 60 });
    expect(await create(problem(429, 'pending_creation_limit'))).toEqual({
      outcome: 'limit',
      retryAfter: null,
    });
  });
  test('the write budget (rate_limited) is not the pending limit', async () => {
    expect(
      await create({ ...problem(429, 'rate_limited'), headers: { 'retry-after': '30' } }),
    ).toEqual({ outcome: 'rate-limited', retryAfter: 30 });
    expect(await create({ error: { status: 429 } })).toEqual({
      outcome: 'rate-limited',
      retryAfter: null,
    });
  });
  test('a 429 on the search is a wait, not an unreachable catalogue', async () => {
    const answer = await mainIntake(
      main({
        candidates: {
          ...problem(429, 'rate_limited'),
          response: new Response(null, { headers: { 'retry-after': '12' } }),
        },
      }),
    ).search(typed);
    expect(answer).toMatchObject({ phase: 'failed', reason: 'rate-limited', retryAfter: 12 });
  });
  test('only a receipt that no longer matches, or a moved basis, sends the person back to search', async () => {
    expect(await create(problem(400, 'invalid_catalogue_intake'))).toEqual({
      outcome: 'search-again',
    });
    expect(await create(problem(409, 'catalogue_basis_changed'))).toEqual({
      outcome: 'search-again',
    });
  });
  test('other 400s say their own reason and never loop back to search', async () => {
    expect(await create(problem(400, 'invalid_title_language'))).toEqual({
      outcome: 'invalid',
      reason: 'title-language',
    });
    expect(await create(problem(400, 'invalid_work_semantic_types'))).toEqual({
      outcome: 'invalid',
      reason: 'types',
    });
    expect(await create({ error: { status: 400 } })).toEqual({
      outcome: 'invalid',
      reason: 'other',
    });
  });
  test('a part names the series it belongs to as its declared parent; other records name none', async () => {
    const sent: unknown[] = [];
    const client = {
      v1: {
        catalogue: {},
        works: Object.assign(async () => ({}), {
          post: async (body: unknown) => {
            sent.push(body);
            return { data: { work: 'https://rezics.com/id/w' }, response: new Response() };
          },
        }),
      },
    } as never;
    await mainIntake(client).create(
      typed,
      receipt,
      'https://rezics.com/id/a',
      null,
      candidates[0].work,
    );
    await mainIntake(client).create(typed, receipt, 'https://rezics.com/id/a', null);
    expect(sent[0]).toMatchObject({
      grain: 'new-creative-scope',
      parentComposition: candidates[0].work,
    });
    expect(sent[1]).not.toHaveProperty('parentComposition');
  });
  test('a created Work, a pending one and a refusal', async () => {
    expect(await create({ data: { work: 'https://rezics.com/id/w' } })).toEqual({
      outcome: 'created',
      work: 'https://rezics.com/id/w',
    });
    expect(await create({ data: { operationId: 'op' } })).toEqual({ outcome: 'pending' });
    expect(await create({ error: { status: 403 } })).toEqual({ outcome: 'denied' });
    expect(await create({ error: { status: 503 } })).toEqual({ outcome: 'unavailable' });
  });
  test('a grain other than a new creative scope is answered with Main’s owner API, never a Work', async () => {
    const answer = await mainIntake(
      main({
        works: {
          data: {
            outcome: 'use-owner-api',
            grain: 'translation-or-version',
            ownerApi: { method: 'PUT', path: '/v1/works/{work}/realizations/{realization}' },
          },
        },
      }),
    ).ownerApi('translation-or-version', typed, receipt, 'https://rezics.com/id/a');
    expect(answer).toEqual({
      outcome: 'owner-api',
      method: 'PUT',
      path: '/v1/works/{work}/realizations/{realization}',
    });
  });
});

describe('G-843 the unverified mark', () => {
  const provenance = {
    contributor: 'https://rezics.com/id/a',
    candidateReceipt: receipt,
    fields: ['title', 'language', 'surprise'],
  };
  test('an unverified record shows its badge and the fields its contributor entered', () => {
    const html = renderToStaticMarkup(
      createElement(ProvisionalNotice, { verification: 'unverified', provenance, locale: 'en' }),
    );
    expect(html).toContain('Unverified');
    expect(html).toContain('Where these fields came from');
    expect(html).not.toContain(receipt);
    expect(html).toContain('>Title<');
    // A field this page has no words for is left out, not shown as a raw key.
    expect(html).not.toContain('surprise');
  });
  test('a verified record, or one Main did not mark, shows nothing', () => {
    for (const verification of ['verified', null, undefined] as const) {
      expect(
        renderToStaticMarkup(
          createElement(ProvisionalNotice, { verification, provenance, locale: 'en' }),
        ),
      ).toBe('');
    }
  });
});

describe('G-843 copy speaks for the product', () => {
  test('no locale names an internal service, an API path or a fixed quota', () => {
    for (const locale of uiLocales) {
      const text = JSON.stringify(messages[locale]);
      expect(text, locale).not.toMatch(/\bMain\b|\/v1\/|\{work\}/);
    }
    for (const key of ['limitTitle', 'limitBody'] as const)
      expect(englishMessages[key]).not.toMatch(/three|\b3\b/i);
  });
});

describe('G-843 copy', () => {
  test('every locale defines only keys English defines', () => {
    for (const locale of uiLocales)
      expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(englishMessages).sort());
  });
  test('the limit message names the wait in the reader’s language', () => {
    expect(copyOf('en').limitRetry({ wait: '60 seconds' })).toContain('60 seconds');
    expect(copyOf('ja').found(3)).toContain('3');
  });
});
