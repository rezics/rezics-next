import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readOwnRating } from '../src/features/pages/subject-ratings';
import {
  applyOptimisticRatingChange,
  RatingControlView,
  type RatingControlState,
} from '../src/features/pages/rating-control';
import { subjectOwnRatingQuery } from '../src/features/pages/subject-queries';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const returnTo = `/en/subjects/${subjectId}/kokoro`;

function view(state: RatingControlState) {
  return renderToStaticMarkup(
    createElement(RatingControlView, {
      subjectId,
      locale: 'en',
      returnTo,
      state,
      pending: false,
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

test('signed-out readers get a sign-in link returning to this subject', () => {
  const html = view({ kind: 'signed-out' });
  expect(html).toContain('Sign in');
  expect(html).toContain(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  expect(html).not.toContain('role="slider"');
});

test('a forbidden own-vote read leaves its reserved space without a control', () => {
  const html = view({ kind: 'unavailable' });
  expect(html).toContain('data-slot="rating-control-reserved"');
  expect(html).not.toContain('role="slider"');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Sign in');
});

test('a missing own vote is unrated while denied own-vote reads hide the control', async () => {
  const read = async (status: number, units?: number) => {
    const client = {
      subjects: () => ({
        ratings: () => ({
          vote: { get: async () => ({ status, ...(units === undefined ? {} : { data: { units } }) }) },
        }),
      }),
    } as never;
    return readOwnRating(
      client,
      new Request('https://site.example/en/subjects/example', { headers: { authorization: 'Bearer reader' } }),
      {},
      subjectId,
    );
  };

  await expect(read(200, 15)).resolves.toEqual({ kind: 'ready', units: 15 });
  await expect(read(404)).resolves.toEqual({ kind: 'ready', units: null });
  await expect(read(401)).resolves.toEqual({ kind: 'unavailable' });
  await expect(read(403)).resolves.toEqual({ kind: 'unavailable' });
});

test('writes update the personal query optimistically, carry idempotency keys and restore failed values', async () => {
  const client = new QueryClient();
  const queryKey = subjectOwnRatingQuery(subjectId, 'en').queryKey;
  client.setQueryData(queryKey, { kind: 'ready', units: 8 } as const);

  let finish!: (ok: boolean) => void;
  let written: { units: number | null; idempotencyKey: string } | undefined;
  let failures = 0;
  const write = (input: { units: number | null; idempotencyKey: string }) => {
    written = input;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  const operation = applyOptimisticRatingChange({
    queryClient: client,
    subjectId,
    locale: 'en',
    units: 15,
    write,
    onFailure: () => failures++,
  });

  expect(client.getQueryData(queryKey)).toEqual({ kind: 'ready', units: 15 });
  finish(false);
  await expect(operation).resolves.toBe(false);
  expect(written).toMatchObject({ units: 15 });
  expect(written?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(client.getQueryData(queryKey)).toEqual({ kind: 'ready', units: 8 });
  expect(failures).toBe(1);

  await client.cancelQueries();
});

test('setting, changing and clearing each issue one bounded write', async () => {
  const client = new QueryClient();
  const queryKey = subjectOwnRatingQuery(subjectId, 'en').queryKey;
  client.setQueryData(queryKey, { kind: 'ready', units: null } as const);
  const writes: { units: number | null; idempotencyKey: string }[] = [];
  const write = async (input: { units: number | null; idempotencyKey: string }) => {
    writes.push(input);
    return true;
  };

  for (const units of [15, 18, null])
    await applyOptimisticRatingChange({
      queryClient: client,
      subjectId,
      locale: 'en',
      units,
      write,
      onFailure: () => {},
    });

  expect(writes.map(({ units }) => units)).toEqual([15, 18, null]);
  expect(new Set(writes.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3);
  expect(writes.every(({ idempotencyKey }) => /^[0-9a-f-]{36}$/i.test(idempotencyKey))).toBe(true);
  expect(client.getQueryData(queryKey)).toEqual({ kind: 'ready', units: null });
  await client.cancelQueries();
});
