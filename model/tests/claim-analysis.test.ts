import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { analyzeClaimSupport, currentVerificationHead, LINEAGE_BUDGET, type AnalysisInput,
  type EvidenceItem, type LineageLink,
} from '../../services/main/src/modules/verification/analysis.ts';

const assessmentProfile = authoredProfiles.find((profile) => profile.id === 'assessment-v1')!;

// Captured from committed 4ed1c3183 before changing the authoring language.
// This includes the reviewed Claim/Statement assessment alternatives already present there.
const originalClaimAssessmentArtifacts = {
  'shapes/assessment-v1.ttl': '73dc7001858dd89a49d82af2b51a52efb82c0aada17f643abfce0bf6a03a10f5',
  'shapes/claim-v1.ttl': 'e028a8f74d433a28cd3860fec7bbaa468afe259b50e82d72fa276fe34c27e36f',
  'generated/model/contexts/claim-v1.jsonld':
    '3b549a954e24ec1c64681f0acd9e145e6cf18146667ce9b01b086eef5b669f8f',
  'generated/model/contexts/assessment-v1.jsonld':
    '446296c61f24dd86e873c7ddd88943e416fb905ec97158e362b917678de23122',
  'packages/model/src/generated/vocabulary.ts':
    '7cabd001625f3ee4470347c9b3d96d5eb40c18fb5d5078054edc0973e71f2e20',
  'packages/model/src/generated/schemas.ts':
    'e818964398a744418057e6660893dcffb180d52859feac12686344bf7d59d7bf',
};
test('Claim and Assessment Turtle retain the committed artifacts and exact canonical shape pins', () => {
  const root = resolve(import.meta.dir, '../..');
  const profiles = ['claim-v1', 'assessment-v1'].map((id) =>
    authoredProfiles.find((profile) => profile.id === id)!,
  );
  const native = commandProfiles(profiles, {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  const output = new Map([...native.shapes, ...buildModelOutputs(profiles)]);
  const digest = (source: string) => createHash('sha256').update(source).digest('hex');
  expect(Object.fromEntries([...output].map(([file, source]) => [file, digest(source)]))).toEqual(
    originalClaimAssessmentArtifacts,
  );
  for (const profile of profiles) {
    expect(isTurtleProfile(profile)).toBe(true);
    const source = readFileSync(join(root, 'model/definitions', `${profile.id}.ttl`), 'utf8');
    expect(profileSource(profile)).toBe(source);
    expect(native.shapes.get(`shapes/${profile.id}.ttl`)).toBe(source);
  }
  const rv = 'https://rezics.com/vocab/';
  expect(native.manifest.canonical).toEqual([
    {
      type: `${rv}Claim`,
      routes: [
        {
          profile: 'claim-v1',
          shape: 'https://rezics.com/definition/claim-v1/claim-shape',
          when: [],
        },
      ],
    },
    {
      type: `${rv}ClaimAssessment`,
      routes: [
        {
          profile: 'assessment-v1',
          shape: 'https://rezics.com/definition/assessment-v1/assessment-shape',
          when: [],
        },
      ],
    },
    {
      type: `${rv}ClaimRevision`,
      routes: [
        {
          profile: 'claim-v1',
          shape: 'https://rezics.com/definition/claim-v1/revision-shape',
          when: [],
        },
      ],
    },
    {
      type: `${rv}SourceReliabilityAssessment`,
      routes: [
        {
          profile: 'assessment-v1',
          shape: 'https://rezics.com/definition/assessment-v1/reliability-shape',
          when: [],
        },
      ],
    },
    {
      type: `${rv}SourceReliabilityScope`,
      routes: [
        {
          profile: 'assessment-v1',
          shape: 'https://rezics.com/definition/assessment-v1/reliability-scope-shape',
          when: [],
        },
      ],
    },
  ]);
});

const claim = { referent: 'https://rezics.com/id/referent',
  context: 'urn:rezics:context:one', predicate: 'https://schema.org/datePublished',
  editionScope: 'urn:rezics:edition:one', validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z',
};
const item = (observation: string, stance: EvidenceItem['stance'] = 'supports',
  availability: EvidenceItem['availability'] = 'available',
): EvidenceItem => ({
  ordinal: 0, stance, availability, observation, contentRevision: null, graphReference: null,
});
const link = (source: string, relation: string, targetObservation: string | null,
  targetOrigin: string | null = null,
): LineageLink => ({
  source, relation, targetObservation, targetOrigin, targetReference: null,
});
const input = (items: EvidenceItem[], links: LineageLink[] = [],
  extra: Partial<AnalysisInput> = {},
): AnalysisInput => ({
  claim, evaluationContext: claim.context, items, links, truncated: false,
  recordOf: new Map(), observedAt: new Map(), referencedClaims: new Map(), reliability: [], ...extra,
});

test('FACT01/FACT02: copied sites and AI re-ingestion keep one established origin', () => {
  const links = [link('first', 'publishes-origin', null, 'origin-1'),
    link('copy', 'copy-of', 'first'), link('ai', 'derived-from', 'copy'),
    // The re-ingested AI page may claim publication; its derivation still wins.
    link('ai', 'publishes-origin', null, 'origin-2'),
  ];
  const result = analyzeClaimSupport(input([item('first'), item('copy'), item('ai')], links));
  expect(result).toMatchObject({ dependence: 'established', independentOrigins: 1,
    origins: ['origin:origin-1'], support: 'insufficient',
  });
  expect(result.work.expansions).toBeLessThanOrEqual(3);
});

test('FACT01: unknown or circular dependence and over-budget closure never count as corroboration', () => {
  expect(analyzeClaimSupport(input([item('unlinked')]))).toMatchObject({
    dependence: 'unknown', independentOrigins: null, support: 'insufficient',
  });
  expect(analyzeClaimSupport(input([item('a')], [link('a', 'copy-of', 'b'),
    link('b', 'copy-of', 'a')])),
  ).toMatchObject({
    dependence: 'circular', independentOrigins: null, support: 'abstained', coverage: 'incomplete',
  });
  const chain = Array.from({ length: LINEAGE_BUDGET + 1 }, (_, i) =>
    link(String(i), 'copy-of', String(i + 1)),
  );
  expect(analyzeClaimSupport(input([item('0')], chain))).toMatchObject({
    dependence: 'over-budget', independentOrigins: null, support: 'abstained', coverage: 'incomplete',
  });
  const opaque = { ...item('one'), observation: null, contentRevision: 'content-1' };
  expect(analyzeClaimSupport(input([opaque, { ...opaque, ordinal: 1, contentRevision: 'content-2' }])),
  ).toMatchObject({
    dependence: 'unknown', independentOrigins: null, support: 'insufficient',
  });
});

test('FACT03: scoped reliability, later edition, withdrawn support and counterevidence stay distinct', () => {
  const reliable = { assessment: 'rating-1', source: 'record-1', domain: claim.predicate,
    context: claim.context, result: 'ReliableForDomain', applicableFrom: null, applicableUntil: null,
  };
  const base = input([item('first')], [link('first', 'publishes-origin', null, 'origin-1')],
    { recordOf: new Map([['first', 'record-1']]),
      observedAt: new Map([['first', '2026-09-27T00:00:00.000Z']]), reliability: [reliable],
  });
  expect(analyzeClaimSupport(base).support).toBe('supported');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable, domain: 'https://schema.org/plot' }],
    }).support,
  )
    .toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, items: [item('first', 'supports', 'withdrawn')] }).support,
  )
    .toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableFrom: '2026-09-28T00:00:00.000Z' }],
    }).support,
  ).toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableUntil: '2026-09-27T00:00:00.000Z' }],
    }).support,
  ).toBe('insufficient');
  expect(analyzeClaimSupport({ ...base, reliability: [{ ...reliable,
    applicableFrom: '2026-09-27T08:00:00+08:00', applicableUntil: '2026-09-28T00:00:00Z',
        },
      ],
    }).support,
  )
    .toBe('supported');
  expect(analyzeClaimSupport({ ...base, items: [item('first'), item('other', 'contradicts')] }).support,
  )
    .toBe('material-conflict');
  const later = { ...claim, editionScope: 'urn:rezics:edition:two',
    validFrom: '2027-01-01T00:00:00.000Z', validUntil: null,
  };
  const outOfScope: EvidenceItem = { ...item('unused', 'contradicts'), observation: null,
    graphReference: 'revision-2',
  };
  const scoped = analyzeClaimSupport({ ...base, items: [item('first'), outOfScope],
    referencedClaims: new Map([['revision-2', later]]),
  });
  expect(scoped.support).toBe('supported');
  expect(scoped.reasons).toContain('scope-differs');
});

test('FACT04: an older policy revision or acceptance head never reads as current', () => {
  const heads = new Map([['urn:rezics:decision-slot:one', 'https://rezics.com/id/new-decision']]);
  expect(currentVerificationHead('policy', 'https://rezics.com/definition/verification-summary-policy-v1',
    'https://rezics.com/definition/verification-summary-policy-v1', heads,
    'https://rezics.com/definition/verification-summary-policy-v2',
    ),
  )
    .toBe('https://rezics.com/definition/verification-summary-policy-v2');
  expect(currentVerificationHead('acceptance', 'urn:rezics:decision-slot:one',
    'https://rezics.com/id/old-decision', heads,
    'https://rezics.com/definition/verification-summary-policy-v1',
    ),
  )
    .toBe('https://rezics.com/id/new-decision');
});

test('a folded current Statement head never certifies the retained Claim revision as current', () => {
  const identity = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const retained = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const statement = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const current = currentVerificationHead('claim', identity, retained, new Map([[identity, statement]]),
    'https://rezics.com/definition/verification-summary-policy-v1',
  );
  expect(current).toBe(statement);
  expect(current).not.toBe(retained);
});

test('independent Statement identities remain evidence anchors rather than independent source origins', () => {
  const supporting = ['retained-claim-revision', 'statement-revision'].map((reference, ordinal) => ({
    ...item('unused'), ordinal, observation: null, graphReference: reference,
  }),
  );
  const result = analyzeClaimSupport(input(supporting, [], { referencedClaims: new Map([
    ['retained-claim-revision', { ...claim }], ['statement-revision', { ...claim }],
  ]),
    }),
  );
  expect(result).toMatchObject({ dependence: 'unknown', independentOrigins: null,
    support: 'insufficient', coverage: 'complete',
  });
  expect(result.reasons).toContain('dependence-unknown');
});

let temporary: string | undefined;
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
test('the existing assessment profile admits one exact Claim or Statement pin while keeping origin constraints', async () => {
  const root = resolve(import.meta.dir, '../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  temporary = mkdtempSync(join(root, '.temp/assessment-pins-'));
  const path = join(temporary, 'schemas.ts');
  writeFileSync(path, buildModelOutputs([assessmentProfile]).get('packages/model/src/generated/schemas.ts')!,
  );
  const schemas = (await import(path)).shapeSchemas as Record<string, TSchema>;
  const accepts = (candidate: Record<string, unknown>) =>
    Value.Check(schemas['https://rezics.com/definition/assessment-v1/assessment-shape']!, candidate,
    );
  const rv = 'https://rezics.com/vocab/';
  const ref = (name: string) => `https://example.test/${name}`;
  const base = { '@id': ref('assessment'), 'rdf:type': [`${rv}ClaimAssessment`, `${rv}RevisionAnchor`],
    'rv:component': [ref('identity')], 'rv:evidenceSetRevision': [ref('evidence')],
    'rv:policyRevision': [ref('policy')], 'rv:evaluationContext': [ref('context')],
    'rv:coverage': [`${rv}CompleteCoverage`], 'rv:supportResult': [`${rv}InsufficientSupport`],
    'rv:dependenceStatus': [`${rv}DependenceUnknown`], 'rv:method': [ref('method')],
    'rv:methodRevision': [ref('method-revision')], 'rv:limitations': ['Origin independence is unknown'],
    'rv:assessor': [ref('assessor')], 'rv:assessorKind': [`${rv}HumanAssessor`],
    'rv:assessedAt': ['2026-10-07T00:00:00.000Z'],
    'rv:modelRevision': ['https://rezics.com/definition/assessment-v1'],
    'rv:shapeRevision': ['https://rezics.com/definition/assessment-v1'], 'rv:dataEpoch': ['epoch'], 'rv:sequence': [1],
  };
  for (const pin of [{ 'rv:claimRevision': [ref('retained')] }, { 'rv:statementRevision': [ref('statement')] },
  ]) {
    expect(accepts({ ...base, ...pin })).toBe(true);
    expect(accepts({ ...base, ...pin, 'rv:dependenceStatus': [`${rv}DependenceEstablished`],
      'rv:independentOriginCount': [2],
      }),
    ).toBe(true);
    expect(accepts({ ...base, ...pin, 'rv:dependenceStatus': [`${rv}DependenceEstablished`] }),
    ).toBe(false);
    expect(accepts({ ...base, ...pin, 'rv:independentOriginCount': [2] })).toBe(false);
  }
  expect(accepts(base)).toBe(false);
  expect(accepts({ ...base, 'rv:claimRevision': [ref('retained')], 'rv:statementRevision': [ref('statement')],
    }),
  ).toBe(false);
});
