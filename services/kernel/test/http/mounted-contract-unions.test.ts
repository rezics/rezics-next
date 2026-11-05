import { expect, expectTypeOf, test } from 'bun:test';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { appellantIdentitySchema, targetContextSchema } from '../../src/content/appeal-routes.ts';
import { copyConditionValueSchema, copyListContextSchema } from '../../src/library/personal-routes.ts';
import { COPY_CONDITION_CHOICES, type CopyConditionValue } from '../../src/library/copy-condition.ts';
import { statusSchema } from '../../src/library/library-export-routes.ts';
import { libraryExportManifest, exportSections, exportSectionsV2, exportSectionsV3, exportSectionsV4 } from '../../src/library/library-export-format.ts';
import { MatchEvidenceSchema } from '../../src/search/http/match-evidence-schema.ts';
import { releaseGroupsResponse } from '../../src/search/http/releases.ts';
import { PublicFigureSchema } from '../../src/rating/public-figure-http.ts';
import { QueryShareSchema } from '../../src/search/http/query-share-schemas.ts';

test('appeal identity and context preserve unavailable states in declarations and wire schemas', () => {
  expectTypeOf<Static<typeof appellantIdentitySchema>['state']>()
    .toEqualTypeOf<'available' | 'deleted' | 'concealed' | 'unavailable'>();
  expectTypeOf<Static<typeof targetContextSchema>['state']>()
    .toEqualTypeOf<'available' | 'concealed' | 'unavailable'>();
  for (const state of ['deleted', 'concealed', 'unavailable'])
    expect(Value.Check(appellantIdentitySchema, { state })).toBe(true);
  for (const state of ['concealed', 'unavailable'])
    expect(Value.Check(targetContextSchema, { state })).toBe(true);
});

test('Copy physical conditions and withheld contexts retain their native vocabulary', () => {
  expectTypeOf<Static<typeof copyConditionValueSchema>>().toEqualTypeOf<CopyConditionValue>();
  expectTypeOf<Static<typeof copyListContextSchema>['state']>()
    .toEqualTypeOf<'available' | 'unsupported' | 'scope' | 'withheld' | 'missing' | 'unavailable'>();
  for (const { id } of COPY_CONDITION_CHOICES) expect(Value.Check(copyConditionValueSchema, id)).toBe(true);
  expect(Value.Check(copyConditionValueSchema, 'seller_grade')).toBe(false);
  for (const state of ['scope', 'withheld', 'missing', 'unavailable'])
    expect(Value.Check(copyListContextSchema, { state })).toBe(true);
});

test('Search share reasons are a closed declared union', () => {
  const reasons = ['ready', 'private_context', 'unsupported', 'oversized', 'unavailable'] as const;
  expectTypeOf<Static<typeof QueryShareSchema>['reason']>().toEqualTypeOf<(typeof reasons)[number]>();
  for (const reason of reasons) expect(Value.Check(QueryShareSchema.properties.reason, reason)).toBe(true);
  expect(Value.Check(QueryShareSchema.properties.reason, 'exception text')).toBe(false);
});

test('each archive manifest retains the ordered native section tuple', () => {
  type Status = Static<typeof statusSchema>;
  expectTypeOf<Extract<Status, { version: 1 }>['sections']>().toEqualTypeOf<[...typeof exportSections]>();
  expectTypeOf<Extract<Status, { version: 2 }>['sections']>().toEqualTypeOf<[...typeof exportSectionsV2]>();
  expectTypeOf<Extract<Status, { version: 3 }>['sections']>().toEqualTypeOf<[...typeof exportSectionsV3]>();
  expectTypeOf<Extract<Status, { version: 4 }>['sections']>().toEqualTypeOf<[...typeof exportSectionsV4]>();
  for (const version of [1, 2, 3, 4] as const) {
    const manifest = libraryExportManifest({
      export_id: 'export', created_at: 'captured', expires_at: 'expires', format_version: version,
    });
    const status = { ...manifest, fullExport: false, state: 'ready', first: null };
    expect(Value.Check(statusSchema, status)).toBe(true);
    expect(Value.Check(statusSchema, { ...status, sections: [...manifest.sections].reverse() })).toBe(false);
  }
});

test('grouped release cards admit the native response without catalogue match evidence', () => {
  type Group = Static<typeof releaseGroupsResponse, { PublicFigure: typeof PublicFigureSchema }>['groups'][number];
  expectTypeOf<Extract<Group, { kind: 'release' }>['release']['matchEvidence']>()
    .toEqualTypeOf<Static<typeof MatchEvidenceSchema> | undefined>();
  const id = '00000000-0000-4000-8000-000000000001';
  const card = {
    id, type: 'release', kind: 'release', labels: {}, summary: null,
    base: { id, kind: 'release', kindLabel: { value: 'Release', language: 'en' }, title: null, image: null, url: { id, label: null } },
    figure: { questionId: id, populationId: id, scale: { min: 0, max: 10, displayStep: 1 }, count: 0, state: 'insufficient_data', mean: null, score: null },
  };
  const page = { status: 'ready', groups: [{ kind: 'release', id, release: card, workLink: 'missing' }], next: null, as_of: '2026-11-05T00:00:00Z' };
  const references = { PublicFigure: PublicFigureSchema };
  expect(Value.Check(references, releaseGroupsResponse, page)).toBe(true);
  expect(Value.Check(references, releaseGroupsResponse, {
    ...page, groups: [{ ...page.groups[0], release: { ...card, matchEvidence: { state: 'raw_engine_error' } } }],
  })).toBe(false);
});
