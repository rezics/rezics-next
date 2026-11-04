import { expect, test } from 'bun:test';
import type { IndexedSubject } from '../../src/search/source.ts';
import {
  compileMatchEvidence,
  projectMatchEvidence,
  readEngineMatchEvidence,
} from '../../src/search/match-evidence.ts';
import { compileText, parseText } from '../../src/search/text.ts';

const subject = (patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: '018f0000-0000-7000-8000-00a000000001',
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 7,
  labels: [{ language: 'en', value: 'The Quiet Harbor' }],
  aliases: [{ language: 'zh-Hant', value: 'Harbor of Silence' }],
  descriptions: [{ language: 'ja', value: 'A story beneath a blue hour sky' }],
  statements: [],
  ...patch,
});

test('evidence adds zero-score field probes without changing positive phrase and Boolean query semantics', () => {
  const compiled = compileText(parseText('harbor -rubble | "blue hour"'), { field: 'search_text', prefix: 't' });
  const evidence = compileMatchEvidence(compiled);
  const query = evidence.query.bool as {
    must: unknown[];
    should: { match?: Record<string, unknown>; match_phrase?: Record<string, unknown> }[];
  };
  expect(query.must).toEqual([compiled.query]);
  expect(query.should).toHaveLength(4);
  expect(JSON.stringify(query.should)).not.toContain('rubble');
  expect(query.should.every((probe) => JSON.stringify(probe).includes('"boost":0'))).toBe(true);
  expect(JSON.stringify(evidence.highlight)).toContain('"minimum_should_match":1');
});

test('projects only uniquely mapped current engine excerpts with their actual language and revision', () => {
  const plan = compileMatchEvidence(compileText(parseText('harbor'), { field: 'search_text', prefix: 't' }));
  const engineEvidence = readEngineMatchEvidence(
    ['e_n_t0', 't0', 'f0'],
    { names: ['<em>Harbor</em> of Silence'] },
    plan,
  );
  expect(engineEvidence.matched).toEqual(['e_n_t0']);
  const alias = projectMatchEvidence(subject(), engineEvidence, plan);
  expect(alias).toEqual({
    state: 'current',
    source: { id: subject().id, revision: 7 },
    query: plan.queryBinding,
    reasons: [{ field: 'alias', language: 'zh-Hant', text: 'Harbor of Silence', spans: [{ start: 0, end: 6 }] }],
  });

  const description = projectMatchEvidence(
    subject(),
    { matched: ['e_d_t0'], highlight: { descriptions: ['A story beneath a <em>blue</em> hour sky'] } },
    compileMatchEvidence(compileText(parseText('blue'), { field: 'search_text', prefix: 't' })),
  );
  expect(description).toMatchObject({ state: 'current', reasons: [{ field: 'description', language: 'ja' }] });
});

test('negative matches, ambiguous sources, missing engine excerpts and missing plans never invent evidence', () => {
  const plan = compileMatchEvidence(compileText(parseText('harbor -rubble'), { field: 'search_text', prefix: 't' }));
  expect(
    projectMatchEvidence(subject(), { matched: ['e_n_t1'], highlight: { names: ['<em>Harbor</em>'] } }, plan),
  ).toEqual({ state: 'unavailable' });
  expect(
    projectMatchEvidence(
      subject({ labels: [{ language: 'en', value: 'Harbor of Silence' }] }),
      { matched: ['e_n_t0'], highlight: { names: ['<em>Harbor</em> of Silence'] } },
      plan,
    ),
  ).toEqual({ state: 'unavailable' });
  expect(projectMatchEvidence(subject(), { matched: ['e_names_t0'] }, plan)).toEqual({ state: 'unavailable' });
  expect(projectMatchEvidence(subject(), undefined, undefined)).toEqual({ state: 'absent' });
});
