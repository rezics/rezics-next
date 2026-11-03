import { expect, mock, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../../src/subject/candidates';
import {
  beginClassificationReturn,
  claimClassificationReturn,
  classificationCreatedTypeAdmitted,
  classificationStatementInput,
  createClassificationCreateHandoff,
  recordCreatedClassificationIdentity,
  snapshotClassificationDrafts,
} from '../../src/features/catalogue/classification-create-return';
import { classificationFactOutcome } from '../../src/features/catalogue/character-classification-review';
import type { FactDraft } from '../../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    sessionStorage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    },
  },
});

test('native classification return keeps preferred rank and requires a deliberate choice of the created Concept', () => {
  const holder = '00000000-0000-4000-8000-00000000b010';
  const sourceId = '00000000-0000-4000-8000-00000000a074';
  const createdId = '00000000-0000-4000-8000-00000000c101';
  const selected = {
    property: { id: 'schema:keywords', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: createdId },
    qualifiers: [],
    references: [],
    rank: 'preferred' as const,
    id: '00000000-0000-4000-8000-000000008001',
  };
  const draft: FactDraft = {
    holder,
    property: 'schema:keywords',
    source: selected.id,
    included: true,
    baseline: classificationStatementInput(selected),
    statement: { ...classificationStatementInput(selected), value: { type: 'value', content: '' } },
  };
  const snapshots = snapshotClassificationDrafts([draft]);
  const created = createClassificationCreateHandoff({
    sourceId,
    sourceLabel: 'The traveler',
    sourceType: 'wd:Q95074',
    returnPath: '/en/catalogue/character',
    reader: 'reader-classification',
    context: candidateContext,
    releaseDigest: 'catalogue:1',
    propertyId: 'schema:keywords',
    propertyLabel: 'keywords',
    holder,
    originalStatementId: selected.id,
    targets: ['skos:Concept'],
    drafts: snapshots!,
    reviewFingerprint: '',
  });
  expect(created).toBeTruthy();
  expect(
    recordCreatedClassificationIdentity(created!.token, sourceId, 'reader-classification', createdId, {
      id: createdId,
      type: 'skos:Concept',
      label: 'Night',
      bases: ['schema:Thing'],
    })?.phase,
  ).toBe('ready');
  expect(beginClassificationReturn(created!.token, sourceId, 'reader-classification')).toBe(true);
  const claimed = claimClassificationReturn(created!.token, sourceId, 'reader-classification');
  expect(claimed?.identity?.id).toBe(createdId);
  expect(claimed?.drafts[0]?.statement.rank).toBe('preferred');
  expect(classificationCreatedTypeAdmitted(bundledRelease, 'schema:keywords', 'skos:Concept', ['schema:Thing'])).toBe(
    true,
  );
  const chosen: FactDraft = {
    ...draft,
    statement: { ...draft.statement, value: { type: 'value', content: createdId } },
    result: { ok: true, kind: 'proposed-awaiting-review', candidate: 'c1', revision: 2 },
    submission: { statement: classificationStatementInput(selected) },
  };
  expect(
    classificationFactOutcome(chosen, {
      ok: true,
      release: bundledRelease,
      source: null,
      public: {
        subject: { id: sourceId, type: 'wd:Q95074', statements: { 'schema:keywords': [selected] } },
        related: {},
      },
    } as never),
  ).toBe('selected');
});
