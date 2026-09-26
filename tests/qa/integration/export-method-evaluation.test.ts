import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeClaimSupport, type AnalysisInput, type Support }
  from '../../../services/main/src/modules/verification/analysis.ts';

const claim = { referent: 'urn:fact:1', context: 'urn:context:1', predicate: 'urn:predicate:1',
  editionScope: null, validFrom: null, validUntil: null };
const base = (): AnalysisInput => ({ claim, evaluationContext: claim.context,
  items: [], links: [], truncated: false, recordOf: new Map(),
  observedAt: new Map(), referencedClaims: new Map(), reliability: [] });
const evidence = (ordinal: number, observation: string,
  stance: 'supports' | 'contradicts' = 'supports', availability: 'available' | 'inaccessible' = 'available') =>
  ({ ordinal, stance, availability, observation, contentRevision: null, graphReference: null });
const origin = (source: string, targetOrigin: string) => ({ source, relation: 'publishes-origin',
  targetObservation: null, targetOrigin, targetReference: null });

/** Authored task labels complement the representative FEVER subset below. */
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
      observedAt: new Map([['urn:obs:a', '2026-01-01T00:00:00Z']]),
      reliability: [{ assessment: 'urn:reliability:a', source: 'urn:source:a',
        domain: claim.predicate, context: claim.context, result: 'ReliableForDomain',
        applicableFrom: null, applicableUntil: null }] },
    expected: 'supported', coverage: 'complete', dependence: 'established' },
  { id: 'reliable-in-another-domain', split: 'development',
    input: { ...base(), items: [evidence(0, 'urn:obs:a')],
      links: [origin('urn:obs:a', 'urn:origin:a')], recordOf: new Map([['urn:obs:a', 'urn:source:a']]),
      observedAt: new Map([['urn:obs:a', '2026-01-01T00:00:00Z']]),
      reliability: [{ assessment: 'urn:reliability:a', source: 'urn:source:a',
        domain: 'urn:predicate:other', context: claim.context, result: 'ReliableForDomain',
        applicableFrom: null, applicableUntil: null }] },
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

test('FACT05: FEVER subset reports held-out class calibration baseline and its evidence-text limit', () => {
  type FeverLabel = 'SUPPORTS' | 'REFUTES' | 'NOT ENOUGH INFO';
  type FeverRow = { id: number; label: FeverLabel; domain: string; claim: string;
    evidence: [string, number][] };
  const rows = readFileSync(resolve(import.meta.dir, '../fixtures/fact-calibration/claims.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as FeverRow);
  const labels: FeverLabel[] = ['SUPPORTS', 'REFUTES', 'NOT ENOUGH INFO'];
  const counts = Object.fromEntries(labels.map(label => [label,
    rows.filter(row => row.label === label).length])) as Record<FeverLabel, number>;
  const strata = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.label}\0${row.domain}`;
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  const probabilities = Object.fromEntries(labels.map(label => [label, counts[label] / rows.length])) as
    Record<FeverLabel, number>;
  const brier = rows.reduce((total, row) => total + labels.reduce((sum, label) =>
    sum + (probabilities[label] - Number(row.label === label)) ** 2, 0), 0) / rows.length;
  const logLoss = rows.reduce((total, row) => total - Math.log(probabilities[row.label]), 0) / rows.length;
  const predicted = labels[0]!; // Stable tie break for the uniform-prior baseline.
  const accuracy = rows.filter(row => row.label === predicted).length / rows.length;
  const confidence = probabilities[predicted];
  const calibrationError = Math.abs(confidence - accuracy);
  const report = { dataset: 'fact-calibration-v1', n: rows.length, counts, accuracy,
    multiclassBrier: brier, logLoss, topLabelCalibrationError: calibrationError,
    predictor: 'uniform class-prior baseline; not the REZICS support method' };

  expect(rows).toHaveLength(384);
  expect(counts).toEqual({ SUPPORTS: 128, REFUTES: 128, 'NOT ENOUGH INFO': 128 });
  expect(new Set(rows.map(row => row.domain)).size).toBe(8);
  expect(strata.size).toBe(24);
  expect([...strata.values()].every(count => count === 16)).toBe(true);
  expect(rows.every(row => row.claim.length > 0
    && row.evidence.every(([page, sentence]) => page.length > 0 && Number.isInteger(sentence)))).toBe(true);
  expect(report.accuracy).toBeCloseTo(1 / 3, 12);
  expect(report.multiclassBrier).toBeCloseTo(2 / 3, 12);
  expect(report.logLoss).toBeCloseTo(Math.log(3), 12);
  expect(report.topLabelCalibrationError).toBeCloseTo(0, 12);
  // FEVER contributes labels, claims and Wikipedia sentence pointers, but no
  // evidence text; it cannot generate predictions for the lineage method.
  expect(rows.every(row => !('evidenceText' in row))).toBe(true);
  console.info('FACT05 FEVER balanced-prior baseline:', JSON.stringify(report));
});
