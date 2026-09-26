import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeClaimSupport } from '../../../services/main/src/modules/verification/analysis.ts';

export const FEVER_EVALUATION_REFERENCE =
  'urn:rezics:evaluation:verification-lineage-support-v1:fever-held-out-v1';

export function evaluateFeverHeldOut() {
  type FeverLabel = 'SUPPORTS' | 'REFUTES' | 'NOT ENOUGH INFO';
  type FeverRow = {
    id: number;
    label: FeverLabel;
    domain: string;
    claim: string;
    evidence: [string, number][];
  };
  const fixture = readFileSync(
    resolve(import.meta.dir, '../fixtures/fact-calibration/claims.jsonl'),
    'utf8',
  );
  const rows = fixture
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FeverRow);
  const predictions = rows.map((row) => {
    const claim = {
      referent: `urn:fever:claim:${row.id}`,
      context: `urn:fever:context:${row.domain}`,
      predicate: 'urn:fever:claim-support',
      editionScope: null,
      validFrom: null,
      validUntil: null,
    };
    const result = analyzeClaimSupport({
      claim,
      evaluationContext: claim.context,
      items: row.evidence.map(([page, sentence], ordinal) => ({
        ordinal,
        // FEVER has sentence pointers but this fixture contains no sentence text.
        stance: 'uncertain' as const,
        availability: 'inaccessible' as const,
        observation: `urn:fever:pointer:${row.id}:${encodeURIComponent(page)}:${sentence}`,
        contentRevision: null,
        graphReference: null,
      })),
      links: [],
      truncated: false,
      recordOf: new Map(),
      observedAt: new Map(),
      referencedClaims: new Map(),
      reliability: [],
    });
    const predicted: FeverLabel | 'material-conflict' | 'abstained' =
      result.support === 'supported'
        ? 'SUPPORTS'
        : result.support === 'contradicted'
          ? 'REFUTES'
          : result.support === 'insufficient'
            ? 'NOT ENOUGH INFO'
            : result.support;
    return { row, result, predicted };
  });
  const count = <T extends string>(values: readonly T[], value: T) =>
    values.filter((item) => item === value).length;
  const errorTypes = Object.fromEntries(
    [
      ...new Set(
        predictions
          .filter((item) => item.predicted !== item.row.label)
          .map((item) => `${item.row.label}→${item.predicted}`),
      ),
    ]
      .sort()
      .map((type) => [
        type,
        predictions.filter((item) => `${item.row.label}→${item.predicted}` === type).length,
      ]),
  );
  return {
    reference: FEVER_EVALUATION_REFERENCE,
    dataset: 'fact-calibration-v1',
    sha256: createHash('sha256').update(fixture).digest('hex'),
    n: rows.length,
    coverage: {
      complete: count(
        predictions.map((item) => item.result.coverage),
        'complete',
      ),
      partial: count(
        predictions.map((item) => item.result.coverage),
        'partial',
      ),
      incomplete: count(
        predictions.map((item) => item.result.coverage),
        'incomplete',
      ),
    },
    abstention: count(
      predictions.map((item) => item.result.support),
      'abstained',
    ),
    predictions: {
      SUPPORTS: count(
        predictions.map((item) => item.predicted),
        'SUPPORTS',
      ),
      REFUTES: count(
        predictions.map((item) => item.predicted),
        'REFUTES',
      ),
      'NOT ENOUGH INFO': count(
        predictions.map((item) => item.predicted),
        'NOT ENOUGH INFO',
      ),
      'material-conflict': count(
        predictions.map((item) => item.predicted),
        'material-conflict',
      ),
      abstained: count(
        predictions.map((item) => item.predicted),
        'abstained',
      ),
    },
    errorTypes,
    calibration: {
      status: 'unmeasured',
      reason: 'method output is categorical; no probability forecast was evaluated',
    },
    scope:
      'The FEVER fixture includes claims, labels and sentence pointers but no evidence sentence text. The method takes an evidence manifest, so cited pointers are marked inaccessible; this measures coverage and categorical behavior with unavailable evidence, not semantic accuracy on the source sentences.',
  };
}
