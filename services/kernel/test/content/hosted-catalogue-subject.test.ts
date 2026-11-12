import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  hostedSubjectPageLimit,
  isCurrentPublicCatalogueCandidate,
} from '../../src/content/hosted-catalogue-subject-model.ts';
import { hostedSubjectCursorBinding } from '../../src/content/hosted-catalogue-subject-cursor.ts';
import { hostedReadingPositionIsBounded, hostedReadingSelectionShape } from '../../src/content/hosted-reading-shape.ts';
import type { Actor } from '../../src/request/access.ts';

const pageSql = readFileSync(new URL('../../src/content/hosted-catalogue-subject-page.sql', import.meta.url), 'utf8');

const subjectId = '00000000-0000-7000-8000-000000000001';

test('current public candidates require a publication pointer', () => {
  expect(
    isCurrentPublicCatalogueCandidate({
      route: 1,
      catalogue_id: subjectId,
      thread_id: subjectId,
      publication_id: subjectId,
    }),
  ).toBe(true);
  expect(
    isCurrentPublicCatalogueCandidate({
      route: 1,
      catalogue_id: subjectId,
      thread_id: subjectId,
      publication_id: '',
    }),
  ).toBe(false);
});

test('subject catalogue pages stay inside the hosted twenty-item bound', () => {
  expect(hostedSubjectPageLimit(undefined)).toBe(20);
  expect(hostedSubjectPageLimit(1)).toBe(1);
  expect(hostedSubjectPageLimit(20)).toBe(20);
  expect(hostedSubjectPageLimit(0)).toBe(-1);
  expect(hostedSubjectPageLimit(21)).toBe(-1);
});

test('subject discovery SQL seeks indexed threads and same-route post subject ids', () => {
  expect(pageSql).toContain('content.subject_thread');
  expect(pageSql).toContain('hosted_catalogue');
  expect(pageSql).toContain('= ANY (r.subject_ids)');
  expect(pageSql).toContain('hosted_placement');
  expect(pageSql).toContain("p.visibility = 'published'");
});

test('continuations bind the subject, limit and viewer without catalogue bytes', () => {
  const actor: Actor = {
    kind: 'account',
    accountId: subjectId,
    clientId: 'reader',
    requestedBy: null,
    authnEpoch: 1,
    scopes: ['post:read'],
  };
  const binding = hostedSubjectCursorBinding(subjectId, { actor, deadline: Date.now() + 1000 }, 20);
  expect(binding.operation).toBe('content.hosted-catalogue.for-subject');
  expect(binding.parameters).toMatchObject({ subjectId, limit: 20 });
  expect(JSON.stringify(binding)).not.toContain('canonicalBytes');
});

test('hosted reading selections keep digest and bounded document position', () => {
  const digest = 'a'.repeat(64);
  expect(
    hostedReadingSelectionShape({
      catalogueId: subjectId,
      publicationRevisionId: subjectId,
      occurrenceId: subjectId,
      targetRevisionId: subjectId,
      targetSha256: digest,
      documentPosition: { blockId: 'block-1', offset: 12 },
    }),
  ).toBe(true);
  expect(hostedReadingPositionIsBounded(null)).toBe(true);
  expect(hostedReadingPositionIsBounded({ blockId: 'x'.repeat(129), offset: 0 })).toBe(false);
  expect(hostedReadingPositionIsBounded({ blockId: 'ok', offset: -1 })).toBe(false);
  expect(
    hostedReadingSelectionShape({
      catalogueId: subjectId,
      publicationRevisionId: subjectId,
      occurrenceId: subjectId,
      targetRevisionId: subjectId,
      targetSha256: 'not-a-digest',
      documentPosition: null,
    }),
  ).toBe(false);
});
