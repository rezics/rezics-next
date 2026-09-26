import { expect, test } from 'bun:test';
import { analyzeClaimSupport, type AnalysisInput, type Support }
  from '../../../services/main/src/modules/verification/analysis.ts';

const claim = { referent: 'urn:fact:1', context: 'urn:context:1', predicate: 'urn:predicate:1',
  editionScope: null, validFrom: null, validUntil: null };
const base = (): AnalysisInput => ({ claim, evaluationContext: claim.context,
  items: [], links: [], truncated: false, recordOf: new Map(),
  referencedClaims: new Map(), reliability: [] });
const evidence = (ordinal: number, observation: string,
  stance: 'supports' | 'contradicts' = 'supports', availability: 'available' | 'inaccessible' = 'available') =>
  ({ ordinal, stance, availability, observation, contentRevision: null, graphReference: null });
const origin = (source: string, targetOrigin: string) => ({ source, relation: 'publishes-origin',
  targetObservation: null, targetOrigin, targetReference: null });

/** Authored task labels; source-domain sampling and probability calibration remain open. */
const labelled: Array<{ id: string; split: 'development' | 'held-out';
  input: AnalysisInput; expected: Support; coverage: string; dependence: string;
  knownError?: 'false-support' }> = [
  { id: 'two-independent-origins', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a'), evidence(1, 'urn:obs:b')],
      links: [origin('urn:obs:a', 'urn:origin:a'), origin('urn:obs:b', 'urn:origin:b')] },
    expected: 'supported', coverage: 'complete', dependence: 'established' },
  { id: 'two-copies-one-origin', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a'), evidence(1, 'urn:obs:b')],
      links: [origin('urn:obs:a', 'urn:origin:a'), origin('urn:obs:b', 'urn:origin:a')] },
    expected: 'insufficient', coverage: 'complete', dependence: 'established' },
  { id: 'conflicting-evidence', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a'), evidence(1, 'urn:obs:b', 'contradicts')],
      links: [origin('urn:obs:a', 'urn:origin:a')] },
    expected: 'material-conflict', coverage: 'complete', dependence: 'established' },
  { id: 'unavailable-only-support', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a', 'supports', 'inaccessible')] },
    expected: 'insufficient', coverage: 'partial', dependence: 'established' },
  { id: 'direct-counterevidence', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a', 'contradicts')] },
    expected: 'contradicted', coverage: 'complete', dependence: 'established' },
  { id: 'uncertain-evidence', split: 'development',
    input: { ...base(), items: [{ ...evidence(0, 'urn:obs:a'), stance: 'uncertain' }] },
    expected: 'insufficient', coverage: 'partial', dependence: 'established' },
  { id: 'single-reliable-primary-in-domain', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')],
      links: [origin('urn:obs:a', 'urn:origin:a')], recordOf: new Map([['urn:obs:a', 'urn:source:a']]),
      reliability: [{ assessment: 'urn:reliability:a', source: 'urn:source:a',
        domain: claim.predicate, context: claim.context, result: 'ReliableForDomain' }] },
    expected: 'supported', coverage: 'complete', dependence: 'established' },
  { id: 'reliable-in-another-domain', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')],
      links: [origin('urn:obs:a', 'urn:origin:a')], recordOf: new Map([['urn:obs:a', 'urn:source:a']]),
      reliability: [{ assessment: 'urn:reliability:a', source: 'urn:source:a',
        domain: 'urn:predicate:other', context: claim.context, result: 'ReliableForDomain' }] },
    expected: 'insufficient', coverage: 'complete', dependence: 'established' },
  { id: 'held-out-circular-copying', split: 'held-out',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')], links: [
      { source: 'urn:obs:a', relation: 'copy-of', targetObservation: 'urn:obs:b',
        targetOrigin: null, targetReference: null },
      { source: 'urn:obs:b', relation: 'copy-of', targetObservation: 'urn:obs:a',
        targetOrigin: null, targetReference: null }] },
    expected: 'abstained', coverage: 'incomplete', dependence: 'circular' },
  { id: 'held-out-unknown-lineage', split: 'held-out',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')] },
    expected: 'insufficient', coverage: 'complete', dependence: 'unknown' },
  { id: 'held-out-over-budget-closure', split: 'held-out',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')], truncated: true,
      links: [origin('urn:obs:a', 'urn:origin:a')] },
    expected: 'abstained', coverage: 'incomplete', dependence: 'over-budget' },
  { id: 'held-out-generated-copy', split: 'held-out',
    input: { ...base(), items: [evidence(0, 'urn:obs:ai')], links: [
      { source: 'urn:obs:ai', relation: 'derived-from', targetObservation: 'urn:obs:a',
        targetOrigin: null, targetReference: null }, origin('urn:obs:a', 'urn:origin:a')] },
    expected: 'insufficient', coverage: 'complete', dependence: 'established' },
  { id: 'held-out-origin-spoof', split: 'held-out',
    input: { ...base(), items: [evidence(0, 'urn:obs:a'), evidence(1, 'urn:obs:b')],
      links: [origin('urn:obs:a', 'urn:claimed-origin:a'),
        origin('urn:obs:b', 'urn:claimed-origin:b')] },
    // The reviewer knows both claimed origins are one syndication source. That
    // provenance is absent from the input, exposing a false support result.
    expected: 'insufficient', coverage: 'complete', dependence: 'established',
    knownError: 'false-support' },
];

test('FACT05: labelled method set reports held-out errors, coverage and abstention without probability claims', () => {
  const report = labelled.map(row => ({ ...row, actual: analyzeClaimSupport(row.input) }));
  expect(report.filter(row => row.split === 'held-out')).toHaveLength(5);
  expect(report.filter(row => row.actual.support !== row.expected).map(row => ({
    id: row.id, type: row.knownError }))).toEqual([
    { id: 'held-out-origin-spoof', type: 'false-support' },
  ]);
  expect(report.filter(row => row.actual.coverage !== row.coverage)).toEqual([]);
  expect(report.filter(row => row.actual.dependence !== row.dependence)).toEqual([]);
  expect(report.filter(row => row.actual.support === 'abstained')).toHaveLength(2);
  expect(report.filter(row => row.actual.coverage !== 'complete')).toHaveLength(4);
  expect(report.filter(row => row.split === 'held-out'
    && row.actual.support === row.expected)).toHaveLength(4);
  expect(report.every(row => !('probability' in row.actual))).toBe(true);
});
