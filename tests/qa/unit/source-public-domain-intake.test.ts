import { expect, test } from 'bun:test';
import { manualSourceIntakeDigest, SourceIntakeInvalid,
  type ManualSourceIntake } from '../../../services/main/src/modules/source/intake.ts';

const source = {
  url: 'https://www.gutenberg.org/ebooks/65061',
  author: { name: 'Fannie Merritt Farmer' }, text: 'Exact retained source expression.',
};
const input: ManualSourceIntake = {
  provider: 'gutenberg', namespace: 'recipe-extract', externalId: '65061/quick-puff-paste',
  sourceRevision: 'pinned-edition', mediaType: 'application/ld+json', retention: 'retained',
  rawBytesBase64: Buffer.from(JSON.stringify(source)).toString('base64'),
  coverage: { scope: 'bounded-extract', complete: true, omittedFields: [] },
  rightsEvidence: { basis: 'public-domain',
    note: `Bounded extract; ${source.url}; source-stated author ${source.author.name}. Retention is not clearance.` },
};

test('Source intake owner admits public-domain evidence without rewriting it', () => {
  const before = structuredClone(input);
  expect(manualSourceIntakeDigest(input)).toMatch(/^[0-9a-f]{64}$/);
  expect(input).toEqual(before);
  expect(manualSourceIntakeDigest(structuredClone(input))).toBe(manualSourceIntakeDigest(input));
});

test('Source intake receipt binds basis, source identity, URL, author and exact expression', () => {
  const digest = manualSourceIntakeDigest(input);
  const alternatives: ManualSourceIntake[] = [
    ...(['unknown', 'facts', 'original', 'license', 'permission', 'exception'] as const)
      .map(basis => ({ ...input, rightsEvidence: { ...input.rightsEvidence, basis } })),
    { ...input, provider: 'substitute' }, { ...input, namespace: 'book' },
    { ...input, externalId: '65061/other' }, { ...input, sourceRevision: 'other-edition' },
    { ...input, rightsEvidence: { ...input.rightsEvidence, note: 'Substituted evidence' } },
    ...[{ ...source, url: 'https://example.test/substitute' },
      { ...source, author: { name: 'Importer' } }, { ...source, text: 'Substituted expression' }]
      .map(value => ({ ...input, rawBytesBase64: Buffer.from(JSON.stringify(value)).toString('base64') })),
  ];
  for (const alternative of alternatives) expect(manualSourceIntakeDigest(alternative)).not.toBe(digest);
});

test('Source intake keeps unknown and non-retained evidence explicit', () => {
  expect(manualSourceIntakeDigest({ ...input,
    rightsEvidence: { basis: 'unknown', note: 'Rights and authorship are unknown.' } })).toMatch(/^[0-9a-f]{64}$/);
  const withheld: ManualSourceIntake = { ...input, retention: 'not-retained', rawBytesBase64: undefined };
  expect(manualSourceIntakeDigest(withheld)).toMatch(/^[0-9a-f]{64}$/);
  expect(() => manualSourceIntakeDigest({ ...withheld, rawBytesBase64: input.rawBytesBase64 }))
    .toThrow(SourceIntakeInvalid);
});

test('Source intake owner rejects unsupported bases and malformed retained evidence', () => {
  for (const basis of ['public_domain', 'original-contribution', '', 'cleared']) {
    expect(() => manualSourceIntakeDigest({ ...input,
      rightsEvidence: { ...input.rightsEvidence, basis: basis as ManualSourceIntake['rightsEvidence']['basis'] } }))
      .toThrow(SourceIntakeInvalid);
  }
  expect(() => manualSourceIntakeDigest({ ...input, rawBytesBase64: 'a===' })).toThrow(SourceIntakeInvalid);
  expect(() => manualSourceIntakeDigest({ ...input,
    rightsEvidence: { ...input.rightsEvidence, note: 'x'.repeat(1025) } })).toThrow(SourceIntakeInvalid);
});
