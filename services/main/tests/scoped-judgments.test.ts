import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import {
  contextAccepts,
  contextAcceptanceFilter,
  subjectTypeTerm,
  RatingTargetNotAccepted,
} from '../src/modules/rating/acceptance.ts';
import {
  acceptedTargetRatingContextInput,
  scopedTargetRatingContextInput,
  targetRatingContextInput,
} from '../src/modules/rating/target-api.ts';
import { targetContextDigest, effectiveDisplayThreshold } from '../src/modules/rating/target.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../src/modules/rating/global.ts';
import { workReadError } from '../src/routes/work-reads.ts';
import { platformAdministratorTargetAllowed } from '../src/modules/access/platform-administrator.ts';
import type { PlatformPermission } from '../src/modules/access/platform-permissions.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../src/modules/rating/target-context-authority.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Migration 1290's resource grants are the only administrator authority. */
function seededPlatformGrants(): PlatformPermission[] {
  const sql = readFileSync(
    new URL('../migrations/access/1290_platform_grants.sql', import.meta.url),
    'utf8',
  );
  const values = sql.slice(
    sql.indexOf('SELECT * FROM (VALUES'),
    sql.indexOf(') AS permissions(action,scope)'),
  );
  return [...values.matchAll(/\('([^']+)','([^']+)'\)/g)].map((match, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action: match[1]!,
    scope_id: match[2]!,
    generation: '1',
    valid_until: null,
    witness: 'seed',
  }));
}

function seededGrantClient(grants: readonly PlatformPermission[]): PoolClient {
  return {
    query: async (sql: string) => {
      if (sql.includes('access.read_platform_permissions')) return { rows: grants };
      throw new Error(`unexpected admission query: ${sql}`);
    },
  } as unknown as PoolClient;
}
const character = 'https://rezics.com/vocab/Character',
  person = 'https://schema.org/Person';

test('subject type terms retain vocabulary and Schema.org IRIs and cannot inject SPARQL', () => {
  expect(subjectTypeTerm(character)).toBe(`<${character}>`);
  expect(subjectTypeTerm(person)).toBe(`<${person}>`);
  expect(
    contextAcceptanceFilter('?context', { types: [character, person], dimensions: ['event'] }),
  ).toContain(`<${person}>`);
  for (const invalid of [
    'https://schema.org/Person> } UNION {',
    'https://schema.org/a b',
    'bad:type',
  ]) {
    expect(() => subjectTypeTerm(invalid)).toThrow();
  }
});

test('question types are alternatives and every projection frame dimension must be accepted', () => {
  const target = { types: [character], dimensions: ['work', 'continuity'] as const };
  expect(contextAccepts({}, target)).toBe(true);
  expect(contextAccepts({ acceptedSubjectTypes: [person, character] }, target)).toBe(true);
  expect(contextAccepts({ acceptedSubjectTypes: [person] }, target)).toBe(false);
  expect(contextAccepts({ acceptedFrameDimensions: ['work', 'continuity', 'event'] }, target)).toBe(
    true,
  );
  expect(contextAccepts({ acceptedFrameDimensions: ['work'] }, target)).toBe(false);
  expect(
    contextAccepts(
      { acceptedSubjectTypes: [person], acceptedFrameDimensions: ['work', 'continuity'] },
      target,
    ),
  ).toBe(false);
  expect(
    contextAccepts(
      { acceptedSubjectTypes: [character] },
      { types: ['https://schema.org/CreativeWork'], dimensions: [] },
    ),
  ).toBe(false);
  // A projection's own class does not make it a Character: the owner supplies the subject's types.
  expect(
    contextAccepts(
      { acceptedSubjectTypes: [character] },
      { types: ['https://rezics.com/vocab/Projection'], dimensions: ['work'] },
    ),
  ).toBe(false);
});

test('v4 acceptance declarations preserve set identity and refuse empty, duplicate and non-projection dimensions', () => {
  const body = {
    profile: 'realm-target-rating-context-v4',
    realm: id(1),
    actingSubject: id(2),
    question: 'How did they do in this frame?',
    language: 'en',
    targetGrain: 'projection' as const,
    acceptedSubjectTypes: [character, person],
    acceptedFrameDimensions: ['work', 'continuity'] as const,
  };
  expect(Value.Check(acceptedTargetRatingContextInput, body)).toBe(true);
  const digest = targetContextDigest({ ...body, accepted: true });
  expect(
    targetContextDigest({
      ...body,
      accepted: true,
      acceptedSubjectTypes: [person, character],
      acceptedFrameDimensions: ['continuity', 'work'],
    }),
  ).toBe(digest);
  expect(targetContextDigest({ ...body, accepted: true, acceptedSubjectTypes: [person] })).not.toBe(
    digest,
  );
  expect(
    targetContextDigest({ ...body, accepted: true, acceptedFrameDimensions: undefined }),
  ).not.toBe(digest);
  for (const override of [
    { acceptedSubjectTypes: [] },
    { acceptedSubjectTypes: [character, character] },
    { acceptedSubjectTypes: ['bad:type'] },
    { acceptedFrameDimensions: [] },
    { acceptedFrameDimensions: ['unknown'] },
  ]) {
    expect(Value.Check(acceptedTargetRatingContextInput, { ...body, ...override })).toBe(false);
  }
  expect(() => targetContextDigest({ ...body, accepted: true, targetGrain: 'resource' })).toThrow();
  expect(
    Value.Check(scopedTargetRatingContextInput, {
      ...body,
      profile: 'realm-target-rating-context-v3',
      acceptedSubjectTypes: undefined,
      acceptedFrameDimensions: undefined,
    }),
  ).toBe(false);
  const legacy = {
    profile: 'realm-target-rating-context-v2',
    realm: id(1),
    actingSubject: id(2),
    question: 'How good is this subject?',
    language: 'en',
    targetGrain: 'projection',
  };
  expect(Value.Check(targetRatingContextInput, legacy)).toBe(false);
  expect(
    Value.Check(scopedTargetRatingContextInput, {
      ...legacy,
      profile: 'realm-target-rating-context-v3',
    }),
  ).toBe(true);
  expect(effectiveDisplayThreshold('projection', null)).toBe(10);
});

test('Global target creation has a separate administrator scope and mismatches have a typed 422 read outcome', async () => {
  const grants = seededPlatformGrants();
  const client = seededGrantClient(grants);
  const actor = id(2);
  const principal = id(3).slice('https://rezics.com/id/'.length);
  let asks = 0;
  const graph = {
    query: async () => {
      asks += 1;
      return { boolean: true };
    },
  };
  expect(
    grants
      .filter((grant) => grant.action === 'platform:resource:rating.context.create')
      .map((grant) => grant.scope_id),
  ).toEqual([GLOBAL_TARGET_CONTEXT_SCOPE]);
  expect(
    await platformAdministratorTargetAllowed(
      client,
      graph,
      principal,
      actor,
      'rating.context.create',
      GLOBAL_TARGET_CONTEXT_SCOPE,
    ),
  ).toBe(true);
  expect(
    await platformAdministratorTargetAllowed(
      client,
      graph,
      principal,
      actor,
      'rating.context.create',
      `rating:context:${GLOBAL_RATING_POPULATION_OWNER}`,
    ),
  ).toBe(false);
  expect(
    await platformAdministratorTargetAllowed(
      client,
      graph,
      principal,
      actor,
      'rating.context.create',
      `rating:context:${id(1)}`,
    ),
  ).toBe(false);
  // A missing resource grant refuses before any target lookup.
  expect(asks).toBe(0);
  const response = workReadError(new RatingTargetNotAccepted());
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'rating_target_not_accepted' });
});
