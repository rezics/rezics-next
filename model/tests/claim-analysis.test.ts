import { expect, test } from 'bun:test';
import { analyzeClaimSupport, currentVerificationHead, LINEAGE_BUDGET, type AnalysisInput,
  type EvidenceItem, type LineageLink } from '../../services/main/src/modules/verification/analysis.ts';

const claim = { referent: 'https://rezics.com/id/referent',
  context: 'urn:rezics:context:one', predicate: 'https://schema.org/datePublished',
  editionScope: 'urn:rezics:edition:one', validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z' };
const item = (observation: string, stance: EvidenceItem['stance'] = 'supports',
  availability: EvidenceItem['availability'] = 'available'): EvidenceItem => ({
  ordinal: 0, stance, availability, observation, contentRevision: null, graphReference: null,
});
const link = (source: string, relation: string, targetObservation: string | null,
  targetOrigin: string | null = null): LineageLink => ({
  source, relation, targetObservation, targetOrigin, targetReference: null,
});
const input = (items: EvidenceItem[], links: LineageLink[] = [],
  extra: Partial<AnalysisInput> = {}): AnalysisInput => ({
  claim, evaluationContext: claim.context, items, links, truncated: false,
  recordOf: new Map(), observedAt: new Map(), referencedClaims: new Map(), reliability: [], ...extra,
});

test('FACT01/FACT02: copied sites and AI re-ingestion keep one established origin', () => {
  const links = [link('first', 'publishes-origin', null, 'origin-1'),
    link('copy', 'copy-of', 'first'), link('ai', 'derived-from', 'copy'),
    // The re-ingested AI page may claim publication; its derivation still wins.
    link('ai', 'publishes-origin', null, 'origin-2')];
  const result = analyzeClaimSupport(input([item('first'), item('copy'), item('ai')], links));
  expect(result).toMatchObject({ dependence: 'established', independentOrigins: 1,
    origins: ['origin:origin-1'], support: 'insufficient' });
  expect(result.work.expansions).toBeLessThanOrEqual(3);
});

test('FACT01: unknown or circular dependence and over-budget closure never count as corroboration', () => {
  expect(analyzeClaimSupport(input([item('unlinked')]))).toMatchObject({
    dependence: 'unknown', independentOrigins: null, support: 'insufficient' });
  expect(analyzeClaimSupport(input([item('a')], [link('a', 'copy-of', 'b'),
    link('b', 'copy-of', 'a')]))).toMatchObject({
    dependence: 'circular', independentOrigins: null, support: 'abstained', coverage: 'incomplete' });
  const chain = Array.from({ length: LINEAGE_BUDGET + 1 }, (_, i) =>
    link(String(i), 'copy-of', String(i + 1)));
  expect(analyzeClaimSupport(input([item('0')], chain))).toMatchObject({
    dependence: 'over-budget', independentOrigins: null, support: 'abstained', coverage: 'incomplete' });
  const opaque = { ...item('one'), observation: null, contentRevision: 'content-1' };
  expect(analyzeClaimSupport(input([opaque, { ...opaque, ordinal: 1, contentRevision: 'content-2' }]))).toMatchObject({
    dependence: 'unknown', independentOrigins: null, support: 'insufficient' });
});

test('FACT03: scoped reliability, later edition, withdrawn support and counterevidence stay distinct', () => {
  const reliable = { assessment: 'rating-1', source: 'record-1', domain: claim.predicate,
    context: claim.context, result: 'ReliableForDomain', applicableFrom: null, applicableUntil: null };
  const base = input([item('first')], [link('first', 'publishes-origin', null, 'origin-1')],
    { recordOf: new Map([['first', 'record-1']]),
      observedAt: new Map([['first', '2026-09-27T00:00:00.000Z']]), reliability: [reliable] });
  expect(analyzeClaimSupport(base).support).toBe('supported');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable, domain: 'https://schema.org/plot' }] }).support)
    .toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, items: [item('first', 'supports', 'withdrawn')] }).support)
    .toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableFrom: '2026-09-28T00:00:00.000Z' }] }).support).toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableUntil: '2026-09-27T00:00:00.000Z' }] }).support).toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableFrom: '2026-09-27T08:00:00+08:00', applicableUntil: '2026-09-28T00:00:00Z' }] }).support)
    .toBe('supported');
  expect(analyzeClaimSupport({ ...base, items: [item('first'), item('other', 'contradicts')] }).support)
    .toBe('material-conflict');
  const later = { ...claim, editionScope: 'urn:rezics:edition:two',
    validFrom: '2027-01-01T00:00:00.000Z', validUntil: null };
  const outOfScope: EvidenceItem = { ...item('unused', 'contradicts'), observation: null,
    graphReference: 'revision-2' };
  const scoped = analyzeClaimSupport({ ...base, items: [item('first'), outOfScope],
    referencedClaims: new Map([['revision-2', later]]) });
  expect(scoped.support).toBe('supported');
  expect(scoped.reasons).toContain('scope-differs');
});

test('FACT04: an older policy revision or acceptance head never reads as current', () => {
  const heads = new Map([['urn:rezics:decision-slot:one', 'https://rezics.com/id/new-decision']]);
  expect(currentVerificationHead('policy', 'https://rezics.com/definition/verification-summary-policy-v1',
    'https://rezics.com/definition/verification-summary-policy-v1', heads,
    'https://rezics.com/definition/verification-summary-policy-v2'))
    .toBe('https://rezics.com/definition/verification-summary-policy-v2');
  expect(currentVerificationHead('acceptance', 'urn:rezics:decision-slot:one',
    'https://rezics.com/id/old-decision', heads,
    'https://rezics.com/definition/verification-summary-policy-v1'))
    .toBe('https://rezics.com/id/new-decision');
});
