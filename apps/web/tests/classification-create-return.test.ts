import { expect, mock, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { candidateContext } from '../src/subject/candidates';
import {
  beginClassificationDraftReturn,
  beginClassificationReturn,
  claimClassificationReturn,
  classificationCreatedTypeAdmitted,
  classificationCreateHref,
  classificationHandoffSearch,
  classificationMissingConceptAdmitted,
  classificationStatementInput,
  classificationTargetUnchosen,
  createClassificationCreateHandoff,
  discardClassificationCreateHandoff,
  readClassificationCreateHandoff,
  recordCreatedClassificationIdentity,
  restoreClassificationDrafts,
  snapshotClassificationDrafts,
} from '../src/features/catalogue/classification-create-return';
import { classificationFactOutcome } from '../src/features/catalogue/character-classification-review';
import { statementInput } from '../src/features/catalogue/statement-editor';
import type { FactDraft } from '../src/features/catalogue/subject-facts';

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

const sourceId = '00000000-0000-4000-8000-00000000a074';
const holder = '00000000-0000-4000-8000-00000000b001';
const createdId = '00000000-0000-4000-8000-00000000c101';
const reader = 'reader-classification';

function draft(rank: 'normal' | 'preferred' = 'normal'): FactDraft {
  return {
    holder,
    property: 'schema:keywords',
    source: null,
    included: true,
    baseline: null,
    statement: {
      property: { id: 'schema:keywords' },
      value: { type: 'value', content: '' },
      qualifiers: [],
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://cite.example/a' } }] },
      ],
      rank,
    },
  };
}

function handoffInput(overrides: Record<string, unknown> = {}) {
  const snapshots = snapshotClassificationDrafts([draft('preferred')]);
  if (!snapshots) throw new Error('Expected snapshot');
  return {
    sourceId,
    sourceLabel: 'The traveler',
    sourceType: 'wd:Q95074',
    returnPath: '/en/catalogue/character',
    reader,
    context: candidateContext,
    releaseDigest: 'catalogue:1',
    propertyId: 'schema:keywords',
    propertyLabel: 'keywords',
    holder,
    originalStatementId: null,
    targets: ['skos:Concept'],
    drafts: snapshots,
    reviewFingerprint: '',
    ...overrides,
  };
}

test('classification statement copy keeps preferred rank; generic statement input stays normal', () => {
  const selected = {
    property: { id: 'schema:keywords', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: createdId },
    qualifiers: [],
    references: [],
    rank: 'preferred' as const,
    id: '00000000-0000-4000-8000-000000008001',
  };
  expect(statementInput(selected).rank).toBe('normal');
  expect(classificationStatementInput(selected).rank).toBe('preferred');
  expect(classificationTargetUnchosen(draft().statement)).toBe(true);
  expect(classificationMissingConceptAdmitted(bundledRelease, 'schema:keywords')).toBe(true);
  expect(classificationCreatedTypeAdmitted(bundledRelease, 'schema:keywords', 'skos:Concept', ['schema:Thing'])).toBe(
    true,
  );
  expect(classificationCreatedTypeAdmitted(bundledRelease, 'schema:keywords', 'schema:Movie', [])).toBe(false);
  const preferredDraft = draft('preferred');
  preferredDraft.statement.value = { type: 'value', content: createdId };
  preferredDraft.result = { ok: true, kind: 'proposed-awaiting-review', candidate: 'c1', revision: 2 };
  preferredDraft.submission = { statement: classificationStatementInput({ ...selected, rank: 'preferred' }) };
  expect(
    classificationFactOutcome(preferredDraft, {
      ok: true,
      release: bundledRelease,
      source: null,
      public: {
        subject: {
          id: sourceId,
          type: 'wd:Q95074',
          statements: { 'schema:keywords': [selected] },
        },
        related: {},
      },
    } as never),
  ).toBe('selected');
});

test('opaque classification tokens cannot authorize a return across reader, property, expiry or reuse', () => {
  expect(classificationHandoffSearch({ classificationHandoff: sourceId })).toBe(sourceId);
  expect(classificationHandoffSearch({ classificationHandoff: 'not-a-token' })).toBeUndefined();
  expect(claimClassificationReturn(crypto.randomUUID(), sourceId, reader)).toBeUndefined();
  const created = createClassificationCreateHandoff(handoffInput());
  expect(created).toBeTruthy();
  expect(classificationCreateHref('fr', created!.token)).toBe(
    `/fr/catalogue/concept?classificationHandoff=${encodeURIComponent(created!.token)}`,
  );
  expect(beginClassificationReturn(created!.token, sourceId, reader)).toBe(false);
  expect(beginClassificationDraftReturn(created!.token, sourceId, 'other-reader')).toBe(false);
  const recorded = recordCreatedClassificationIdentity(created!.token, sourceId, reader, createdId);
  expect(recorded?.phase).toBe('creating');
  expect(recorded?.createdId).toBe(createdId);
  expect(recordCreatedClassificationIdentity(created!.token, sourceId, reader, crypto.randomUUID())).toBeUndefined();
  expect(readClassificationCreateHandoff(created!.token)).toBeUndefined();
  const next = createClassificationCreateHandoff(handoffInput());
  recordCreatedClassificationIdentity(next!.token, sourceId, reader, createdId, {
    id: createdId,
    type: 'skos:Concept',
    label: 'Night',
    bases: ['schema:Thing'],
  });
  expect(beginClassificationReturn(next!.token, sourceId, 'other-reader')).toBe(false);
  expect(beginClassificationReturn(next!.token, sourceId, reader)).toBe(true);
  const claimed = claimClassificationReturn(next!.token, sourceId, reader);
  expect(claimed?.identity?.id).toBe(createdId);
  expect(restoreClassificationDrafts(claimed!.drafts)[0]!.statement.rank).toBe('preferred');
  expect(claimClassificationReturn(next!.token, sourceId, reader)?.phase).toBe('returned');
  expect(claimClassificationReturn(next!.token, sourceId, 'other-reader')).toBeUndefined();
  const cancelled = createClassificationCreateHandoff(handoffInput());
  expect(beginClassificationDraftReturn(cancelled!.token, sourceId, reader)).toBe(true);
  const restored = claimClassificationReturn(cancelled!.token, sourceId, reader);
  expect(restored?.identity).toBeUndefined();
  expect(classificationTargetUnchosen(restoreClassificationDrafts(restored!.drafts)[0]!.statement)).toBe(true);
  discardClassificationCreateHandoff(cancelled!.token);
});
