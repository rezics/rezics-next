import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SeedApiError } from './api.ts';
import { ensureReviewedQuestionPresentation, type ScopedSubjectApi } from './scoped-subjects-questions.ts';
import type { QuestionPresentationState } from '../../../services/main/src/modules/rating/question-presentation-schema.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
function fixture() {
  const context = id(), contextRevision = id(), actor = id(), component = id();
  let current: { component: string; revision: string; state: QuestionPresentationState } | null = {
    component, revision: id(), state: { context, language: 'fr', question: 'Aimez-vous ce personnage ?',
      source: 'https://rezics.com/definition/scoped-subject-questions-v1',
      licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'draft' },
  };
  const writes: { body: object; key: string }[] = [];
  let failure: Error | null = null;
  const api: Pick<ScopedSubjectApi, 'get' | 'post'> = {
    get: async <T>() => ({ presentation: structuredClone(current) }) as T,
    post: async <T>(_path: string, body: object, key: string) => {
      writes.push({ body, key });
      if (failure) { const error = failure; failure = null; throw error; }
      const input = body as { expectedHead: string | null; target?: string; state: QuestionPresentationState };
      expect(input.expectedHead).toBe(current?.revision ?? null);
      current = { component: input.target ?? component, revision: id(), state: input.state };
      return { component: current.component, revision: current.revision, replayed: false } as T;
    },
  };
  const run = () => ensureReviewedQuestionPresentation(api, actor, 'recovery-demo', context,
    contextRevision, 'fr', 'Aimez-vous ce personnage ?');
  return { run, writes, read: () => current!, fail: (error: Error) => { failure = error; },
    setMissing: () => { current = null; },
    setReviewed: () => { current!.state.reviewStatus = 'reviewed'; } };
}

test('a reviewed language slot is read and preserved without another write', async () => {
  const f = fixture(); f.setReviewed();
  expect(await f.run()).toEqual({ component: f.read().component, revision: f.read().revision });
  expect(f.writes).toEqual([]);
});

test('a cancelled review gets a new key over the unchanged exact draft head and converges once', async () => {
  const f = fixture(), before = structuredClone(f.read());
  f.fail(new SeedApiError('review', 409, JSON.stringify({ code: 'operation_cancelled' })));
  const saved = await f.run();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.body).toEqual(f.writes[1]!.body);
  expect(f.writes[0]!.key).not.toBe(f.writes[1]!.key);
  expect(f.writes[1]!.body).toMatchObject({ target: before.component, expectedHead: before.revision,
    state: { reviewStatus: 'reviewed' } });
  expect(saved.component).toBe(before.component);
  await f.run(); expect(f.writes).toHaveLength(2);
});

test('an unanswered review keeps its exact key on the next seed run', async () => {
  const f = fixture(); f.fail(new Error('pending after retries; rerun with the same key'));
  await expect(f.run()).rejects.toThrow('pending');
  await f.run();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toEqual(f.writes[1]);
});

test('a cancelled first creation can retry without a presentation ID or poisoning the next run', async () => {
  const f = fixture(); f.setMissing();
  f.fail(new SeedApiError('create reviewed', 409, JSON.stringify({ code: 'operation_cancelled' })));
  const written = await f.run();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.body).toMatchObject({ expectedHead: null });
  expect(f.writes[1]!.body).toEqual(f.writes[0]!.body);
  expect(f.writes[1]!.key).not.toBe(f.writes[0]!.key);
  expect(written.component).toBe(f.read().component);
  await f.run(); expect(f.writes).toHaveLength(2);
});
