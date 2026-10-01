import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Value } from 'typebox/value';
import { Elysia, t } from 'elysia';
import { parseLanguage } from '../src/modules/display-language/tag.ts';
import { languageTag, languageTagSchema } from '../src/modules/display-language/schema.ts';
import { validContentLanguage } from '../src/modules/public-report/contract.ts';
import { targetRatingContextInput } from '../src/modules/rating/target-api.ts';
import { targetContextDigest, readTargetRatingContext, TARGET_CONTEXT_PROFILE,
  LEGACY_TARGET_CONTEXT_PROFILE } from '../src/modules/rating/target.ts';
import { prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RATING_STANDING_CADENCE, RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY } from '../src/modules/rating/context.ts';
import { RatingObservationUnavailable } from '../src/modules/rating/observation.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('G-935: bounded optional route languages preserve the submitted string', async () => {
  const app = new Elysia().post('/language', { body: t.Object({
    language: t.Optional(languageTagSchema(35)),
  }) }, ({ body }) => body);
  const response = await app.handle(new Request('http://main.local/language', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'ja' }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ language: 'ja' });
  for (const language of ['en--US', `x-${'private-'.repeat(6)}tag`]) {
    expect((await app.handle(new Request('http://main.local/language', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language }) }))).status).toBe(422);
  }
});

test('G-935: shared language validation preserves reporting private-use, grandfathered and extlang forms', () => {
  // RFC 5646 §2.1 and §2.2.8: https://www.rfc-editor.org/rfc/rfc5646.html
  for (const language of ['ja', 'AR', 'zh-Hant-TW', 'x-Rezics', 'i-klingon', 'en-GB-oed',
    'sgn-BE-FR', 'zh-cmn-Hans-CN', 'ar-aao', 'sl-rozaj-biske']) {
    expect(parseLanguage(language)?.originalTag).toBe(language);
    expect(Value.Check(languageTag, language)).toBe(true);
    expect(validContentLanguage(language)).toBe(true);
  }
  for (const language of ['', ' ja', 'en_US', 'en--US', 'x', 'en-x', 'zh-cmn-Hans-CN-@',
    'sl-rozaj-rozaj', 'en-a-test-a-again', 'en-a-test-A-again', 'en\n']) {
    expect(parseLanguage(language)).toBeNull();
    expect(Value.Check(languageTag, language)).toBe(false);
    expect(validContentLanguage(language)).toBe(false);
  }
  expect(validContentLanguage(`x-${Array.from({ length: 100 }, () => 'private').join('-')}`)).toBe(false);
});

test('G-935: target question language is required and bound to retry intent', () => {
  const input = { profile: 'realm-target-rating-context-v2', realm: id(1), question: '翻訳の評価は？',
    language: 'ja', targetGrain: 'realization' as const, actingSubject: id(2) };
  expect(Value.Check(targetRatingContextInput, input)).toBe(true);
  const { language: _language, ...missing } = input;
  expect(Value.Check(targetRatingContextInput, missing)).toBe(false);
  expect(Value.Check(targetRatingContextInput, { ...input, language: 'en_US' })).toBe(false);
  expect(Value.Check(targetRatingContextInput, { ...input, profile: 'realm-target-rating-context-v1' })).toBe(false);
  expect(targetContextDigest(input)).not.toBe(targetContextDigest({ ...input, language: 'zh' }));
  expect(() => targetContextDigest({ ...input, language: 'ja ; DROP' })).toThrow();
  const oversized = { ...input, language: `x-${'private-'.repeat(36)}tag` };
  expect(Value.Check(targetRatingContextInput, oversized)).toBe(false);
  expect(() => targetContextDigest(oversized)).toThrow();
});

test('G-935: immutable Context reads preserve declared spelling, recover v1 tags and fail closed on divergence', async () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/g-935-context-');
  const context = id(3), realm = id(1), revision = id(4), question = '翻訳の評価は？';
  const base = { context, realm, question, targetGrain: 'realization', state: 'active', scaleMin: 1, scaleMax: 10,
    cadence: RATING_STANDING_CADENCE, populationPolicy: RATING_ACCOUNT_POPULATION, aggregationPolicy: RATING_LATEST_MEAN_POLICY };
  const binding = (value: string) => ({ type: 'uri', value });
  let profile = TARGET_CONTEXT_PROFILE, language: string | undefined = 'ja';
  let manifest = prepareComponent(directory, context, { ...base, language: 'JA' }, profile);
  const env = { objectDirectory: directory, fuseki: { query: async (query: string) => {
    // The compatibility query must admit both model revisions without requiring
    // the new marker type on historical records.
    expect(query).toContain(LEGACY_TARGET_CONTEXT_PROFILE);
    expect(query).not.toContain('a rv:TargetRatingContext,');
    return { results: { bindings: [{ realm: binding(realm), question: { type: 'literal', value: question,
      ...(language ? { 'xml:lang': language } : {}) }, grain: binding(`${RV}Realization`),
    contextRevision: binding(revision), manifest: binding(`urn:rezics:sha256:${manifest}`), profile: binding(profile) }] } };
  } } } as unknown as WorkActivationEnvironment;
  try {
    expect(await readTargetRatingContext(env, context)).toMatchObject({ language: 'JA', question });
    language = 'zh';
    await expect(readTargetRatingContext(env, context)).rejects.toBeInstanceOf(RatingObservationUnavailable);
    language = undefined;
    await expect(readTargetRatingContext(env, context)).rejects.toBeInstanceOf(RatingObservationUnavailable);
    profile = LEGACY_TARGET_CONTEXT_PROFILE;
    manifest = prepareComponent(directory, context, base, profile);
    language = 'en';
    expect(await readTargetRatingContext(env, context)).toMatchObject({ profile: 'realm-target-rating-context-v1', language });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
