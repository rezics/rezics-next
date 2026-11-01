import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  QUESTION,
  preparedRatingReader,
  readOwnRating,
  type RatingQuestion,
  type SubjectOwnRating,
} from '../src/features/pages/subject-ratings';
import type { SubjectPersonalLease, SubjectRatingWriteOperation } from '../src/features/pages/subject-personal-reader';
import {
  applyOptimisticRatingChange,
  RatingControlView,
  type RatingControlState,
} from '../src/features/pages/rating-control';
import { subjectOwnRatingQuery } from '../src/features/pages/subject-queries';
import { m } from '../src/paraglide/messages.js';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const returnTo = `/en/subjects/${subjectId}/kokoro`;
const ratingQuestion: RatingQuestion = {
  id: QUESTION,
  revision: 1,
  label: 'Your rating',
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
};

function personalLease(subjectId = subjectIdValue, locale = 'en'): SubjectPersonalLease {
  let sequence = 0;
  let owner = 0;
  let committed: SubjectOwnRating | undefined;
  let current = true;
  const reader = 'reader-a';
  const scope = { reader, admission: 1, view: 'overview', cacheEpoch: 0 } as const;
  return {
    key: JSON.stringify([subjectId, locale, reader, 1, 'overview', 0]),
    reader,
    subjectId,
    locale,
    view: 'overview',
    scope,
    isCurrent: () => current,
    retire: () => {
      current = false;
    },
    beginRatingWrite: (before) => {
      if (!current) return null;
      if (committed === undefined) committed = before;
      const id = ++sequence;
      owner = id;
      const operation: SubjectRatingWriteOperation = {
        id,
        sequence: id,
        ownsCache: () => owner === id,
        commit: (value) => {
          committed = value;
          if (owner === id) owner = 0;
        },
        rollback: (fallback) => {
          if (owner !== id) return null;
          owner = 0;
          return committed ?? fallback;
        },
        preserveUncertainty: (value) => {
          committed = value;
          if (owner === id) owner = 0;
        },
      };
      return operation;
    },
  };
}

const subjectIdValue = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

function view(state: RatingControlState, { question = ratingQuestion, pending = false, locale = 'en' } = {}) {
  return renderToStaticMarkup(
    createElement(RatingControlView, {
      question,
      subjectId,
      locale,
      returnTo,
      state,
      pending,
      failure: null,
      onSet: () => {},
      onClear: () => {},
    }),
  );
}

test('the rating control has an accessible 0-to-10 slider in half-point steps and a no-JavaScript form', () => {
  const html = view({ kind: 'ready', units: 15 });
  expect(html).toContain('aria-label="Your rating"');
  expect(html).toContain('min="0"');
  expect(html).toContain('max="20"');
  expect(html).toContain('aria-valuenow="15"');
  expect(html).toContain('aria-valuetext="7.5 out of 10"');
  expect(html).toContain('data-slot="rating-control-value"');
  expect(html).toContain('<noscript>');
  expect(html).toContain('method="post"');
  expect(html).toContain(`action="${returnTo}"`);
  expect(html).toContain('type="range"');
  expect(html).toContain('name="units"');
  expect(html).toContain('step="1"');
});

test.each([
  { units: 15, rangeValue: 15, text: '7.5 out of 10', pending: false, locale: 'en' },
  { units: null, rangeValue: 10, text: 'Not rated', pending: false, locale: 'en' },
  { units: 0, rangeValue: 0, text: '0 out of 10', pending: false, locale: 'en' },
  { units: 20, rangeValue: 20, text: '10 out of 10', pending: true, locale: 'en' },
  { units: 15, rangeValue: 15, text: '7.5 / 10', pending: false, locale: 'zh-Hans' },
  { units: null, rangeValue: 10, text: '尚未评分', pending: true, locale: 'zh-Hans' },
])(
  'the native rating input owns its label and current value text: %j',
  ({ units, rangeValue, text, pending, locale }) => {
    const html = view({ kind: 'ready', units }, { pending, locale });
    const interactive = html.split('<noscript>')[0]!;
    const ranges = (interactive.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes('type="range"'));
    expect(ranges).toHaveLength(1);
    const input = ranges[0]!;
    for (const attribute of [
      `aria-label="${ratingQuestion.label}"`,
      `aria-valuetext="${text}"`,
      `aria-valuenow="${rangeValue}"`,
      `value="${rangeValue}"`,
      'min="0"',
      'max="20"',
      'step="1"',
    ])
      expect(input).toContain(attribute);
    expect(input.includes('disabled=""')).toBe(pending);
    expect(input).not.toContain('tabindex="-1"');
    expect(interactive).toContain(`>${text}</output>`);
    const group = interactive.match(/<div\b[^>]*data-slot="slider"[^>]*>/)?.[0];
    expect(group).toBeDefined();
    expect(group).toContain('role="group"');
    expect(group).not.toMatch(/aria-label=|aria-labelledby=|aria-valuetext=/);
    const thumb = interactive.match(/<div\b[^>]*data-slot="slider-thumb"[^>]*>/)?.[0];
    expect(thumb).toBeDefined();
    expect(thumb).not.toMatch(/role="slider"|aria-label=|aria-valuetext=/);
    expect(interactive).not.toContain(`for="rating-${subjectId}"`);
  },
);

test('the native input retains the question scale and question-specific label through its specialized Base UI thumb', () => {
  const question: RatingQuestion = {
    ...ratingQuestion,
    label: 'How much did you like this work?',
    scale: { min: 4, max: 44, displayStep: 4 },
  };
  const html = view({ kind: 'ready', units: null }, { question });
  const interactive = html.split('<noscript>')[0]!;
  const input = interactive.match(/<input\b[^>]*type="range"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  for (const attribute of [
    `aria-label="${question.label}"`,
    'aria-valuetext="Not rated"',
    'min="4"',
    'max="44"',
    'step="4"',
    'value="24"',
  ])
    expect(input).toContain(attribute);
});

test('signed-out readers get a sign-in link returning to this subject', () => {
  const html = view({ kind: 'signed-out' });
  expect(html).toContain('Sign in');
  expect(html).toContain(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  expect(html).not.toContain('role="slider"');
});

test('ready, signed-out and pending actions keep comfortable wrapping targets and native vote semantics', () => {
  const question = {
    ...ratingQuestion,
    label: 'How much did you enjoy this work across its different translations and editions?',
  };
  const expectTarget = (tag: string) => {
    for (const token of [
      'h-auto',
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'whitespace-normal',
      'wrap-anywhere',
      'focus-visible:outline-2',
      'focus-visible:outline-solid',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-ring',
    ])
      expect(tag).toContain(token);
    expect(tag).not.toMatch(/\bh-8\b|whitespace-nowrap/);
  };

  // German and French retain their current longer action copy rather than abbreviated phone labels.
  for (const locale of ['en', 'de', 'fr'] as const) {
    const options = { locale };
    for (const { units, pending } of [
      { units: null, pending: false },
      { units: 0, pending: false },
      { units: 15, pending: false },
      { units: 15, pending: true },
    ]) {
      const html = view({ kind: 'ready', units }, { question, pending, locale });
      const [interactive, fallback] = html.split('<noscript>') as [string, string];
      expect(interactive).toContain(question.label);
      expect(interactive).toContain('wrap-anywhere');
      const actions = interactive.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      expect(actions).toHaveLength(2);
      const [save, clear] = actions as [string, string];
      expectTarget(save);
      expectTarget(clear);
      expect(save).toContain(m.subject_rating_control_save({}, options));
      expect(clear).toContain(m.subject_rating_control_clear({}, options));
      expect(save).toContain('type="button"');
      expect(clear).toContain('type="button"');
      expect(save).toContain('disabled=""'); // The unchanged saved value cannot be saved again.
      expect(clear.includes('disabled=""')).toBe(pending || units === null);
      expect(interactive).toContain(`aria-busy="${pending}"`);
      expect(interactive).toContain(`aria-valuenow="${units ?? 10}"`);

      expect(fallback).toContain(`action="${returnTo}"`);
      expect(fallback).toContain('method="post"');
      const nativeActions = fallback.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      expect(nativeActions).toHaveLength(units === null ? 1 : 2);
      for (const action of nativeActions) {
        expectTarget(action);
        expect(action).toContain('type="submit"');
        expect(action).toContain('name="intent"');
        expect(action).not.toContain('disabled=');
      }
      expect(nativeActions[0]).toContain('value="save"');
      if (units !== null) expect(nativeActions[1]).toContain('value="clear"');
      const range = fallback.match(/<input\b[^>]*type="range"[^>]*>/)?.[0];
      for (const attribute of ['name="units"', 'min="0"', 'max="20"', 'step="1"', `value="${units ?? 10}"`])
        expect(range).toContain(attribute);
    }

    const signedOut = view({ kind: 'signed-out' }, { question, locale });
    const signIn = signedOut.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(signIn).toBeDefined();
    expectTarget(signIn!);
    expect(signIn).toContain(m.account_sign_in({}, options));
    expect(signIn).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(returnTo)}"`);
    expect(signedOut.split('<noscript>')[0]).not.toContain('<button');
    const fallbackSave = signedOut.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(fallbackSave).toBeDefined();
    expectTarget(fallbackSave!);
    expect(fallbackSave).toContain('value="save"');
  }
});

test('a forbidden own-vote read leaves its reserved space without a control', () => {
  const html = view({ kind: 'unavailable' });
  expect(html).toContain('data-slot="rating-control-reserved"');
  expect(html).not.toContain('role="slider"');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Sign in');
});

test('a missing own vote is unrated while denied own-vote reads hide the control', async () => {
  const request = new Request('https://site.example/en/subjects/example', {
    headers: { authorization: 'Bearer reader' },
  });
  const reader = await preparedRatingReader(request, 'Bearer reader');
  const read = async (status: number, units?: number) => {
    const client = {
      subjects: () => ({
        ratings: () => ({
          vote: { get: async () => ({ status, ...(units === undefined ? {} : { data: { units } }) }) },
        }),
      }),
    } as never;
    return readOwnRating(client, request, {}, subjectId);
  };

  await expect(read(200, 15)).resolves.toEqual({ reader, kind: 'ready', units: 15 });
  await expect(read(404)).resolves.toEqual({ reader, kind: 'ready', units: null });
  await expect(read(401)).resolves.toEqual({ reader, kind: 'unavailable' });
  await expect(read(403)).resolves.toEqual({ reader, kind: 'unavailable' });
});

test('writes update the personal query optimistically, carry idempotency keys and restore failed values', async () => {
  const client = new QueryClient();
  const binding = personalLease(subjectId, 'en');
  const queryKey = subjectOwnRatingQuery(subjectId, 'en', binding.scope).queryKey;
  client.setQueryData(queryKey, { reader: binding.reader, kind: 'ready', units: 8 } as const);

  let finish!: (ok: boolean) => void;
  let written: { units: number | null; idempotencyKey: string; expectedReader: string } | undefined;
  let failures = 0;
  const write = (input: { units: number | null; idempotencyKey: string; expectedReader: string }) => {
    written = input;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  const operation = applyOptimisticRatingChange({
    queryClient: client,
    subjectId,
    locale: 'en',
    binding,
    units: 15,
    write,
    onFailure: () => failures++,
  });

  expect(client.getQueryData(queryKey)).toEqual({ reader: binding.reader, kind: 'ready', units: 15 });
  finish(false);
  await expect(operation).resolves.toBe(false);
  expect(written).toMatchObject({ units: 15, expectedReader: binding.reader });
  expect(written?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(client.getQueryData(queryKey)).toEqual({ reader: binding.reader, kind: 'ready', units: 8 });
  expect(failures).toBe(1);

  await client.cancelQueries();
});

test('a current write with an uncertain response keeps its optimistic value and reports uncertainty', async () => {
  const client = new QueryClient();
  const binding = personalLease(subjectId, 'en');
  const queryKey = subjectOwnRatingQuery(subjectId, 'en', binding.scope).queryKey;
  client.setQueryData(queryKey, { reader: binding.reader, kind: 'ready', units: 8 } as const);
  const failures: { uncertain: boolean }[] = [];

  await expect(
    applyOptimisticRatingChange({
      queryClient: client,
      subjectId,
      locale: 'en',
      binding,
      units: 15,
      write: async () => {
        throw new Error('The response was lost after dispatch');
      },
      onFailure: (failure) => failures.push(failure),
    }),
  ).resolves.toBe(false);

  expect(client.getQueryData(queryKey)).toEqual({ reader: binding.reader, kind: 'ready', units: 15 });
  expect(failures).toEqual([{ uncertain: true }]);
  await client.cancelQueries();
});

test('setting, changing and clearing each issue one bounded write', async () => {
  const client = new QueryClient();
  const binding = personalLease(subjectId, 'en');
  const queryKey = subjectOwnRatingQuery(subjectId, 'en', binding.scope).queryKey;
  client.setQueryData(queryKey, { reader: binding.reader, kind: 'ready', units: null } as const);
  const writes: { units: number | null; idempotencyKey: string; expectedReader: string }[] = [];
  const write = async (input: { units: number | null; idempotencyKey: string; expectedReader: string }) => {
    writes.push(input);
    return true;
  };

  for (const units of [15, 18, null])
    await applyOptimisticRatingChange({
      queryClient: client,
      subjectId,
      locale: 'en',
      binding,
      units,
      write,
      onFailure: () => {},
    });

  expect(writes.map(({ units }) => units)).toEqual([15, 18, null]);
  expect(new Set(writes.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3);
  expect(writes.every(({ idempotencyKey }) => /^[0-9a-f-]{36}$/i.test(idempotencyKey))).toBe(true);
  expect(client.getQueryData(queryKey)).toEqual({ reader: binding.reader, kind: 'ready', units: null });
  await client.cancelQueries();
});
