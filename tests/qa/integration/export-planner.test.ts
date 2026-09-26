import { describe, expect, test } from 'bun:test';
import { InvalidExportPlan, canonicalExport, planExport, type ExportBasis, type VerifiedExportMember }
  from '../../../services/main/src/modules/export/planner.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';

const digest = 'a'.repeat(64);
const member = (overrides: Partial<VerifiedExportMember> = {}): VerifiedExportMember => ({
  sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'value',
  exactRef: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  contentRevisionId: null, refDigest: digest, ownerDataEpoch: 'graph-epoch-1', ownerSequence: '42',
  sourcePosition: null, targetGrain: 'value', mapping: 'exact', ...overrides,
});

const basis = (members: number[], changes: Partial<ExportBasis> = {}): ExportBasis => ({
  basisKind: 'license_offering', basisRef: 'license-revision-1', licenseExpression: 'CC-BY-4.0',
  notice: 'Creator attribution', obligations: ['attribution'], useScope: 'evaluation',
  result: 'supported', memberOrdinals: members, ...changes,
});

describe('export planner cost contract', () => {
  test('export.create reserves one Access terminal receipt family', () => {
    expect(receiptFamilyFor('export.create')).toBe('export-create-v1');
  });

  test('LIVE07: lexical time and quantity, language, unknown, absent, null, zero and false round-trip exactly', async () => {
    const values: VerifiedExportMember['value'][] = [
      { kind: 'absent' }, { kind: 'null' }, { kind: 'unknown' }, { kind: 'no-value' },
      { kind: 'boolean', value: false }, { kind: 'integer', lexical: '0' },
      { kind: 'text', lexical: '', language: 'zh-Hans' },
      { kind: 'time', lexical: '+02020-01-01T00:00:00Z', precision: 'day',
        calendar: 'http://www.wikidata.org/entity/Q1985727', timezone: '+00:00',
        before: '0', after: '1' },
      { kind: 'quantity', lexical: '0.000', unit: 'http://www.wikidata.org/entity/Q11573',
        lower: '-0.001', upper: '0.002' },
    ];
    const members = values.map((value, index) => member({ exactRef: `urn:value:${index}`, value }));
    const plan = await planExport({ targetProfile: 'portable-values-v1', useScope: 'evaluation',
      members, residuals: [] }, async () => [basis(values.map((_, index) => index + 1))]);
    expect(plan.members.map(item => item.value)).toEqual(values);
    expect(JSON.parse(canonicalExport(plan.members)).map((item: VerifiedExportMember) => item.value)).toEqual(values);
    expect(plan.work).toEqual({ members: values.length, residuals: 0, bases: 1, basisLinks: values.length,
      bytes: expect.any(Number) });
    expect(plan.completeness).toBe('complete');
  });

  test('LIVE10: accepted Main Version and external release keep their grains; an unidentified edition stays unmapped', async () => {
    const members = [
      member({ sourceGrain: 'main_version', exactRef: 'urn:main:revision:1',
        targetGrain: 'CreativeWork', ownerSequence: '12' }),
      member({ sourceOwner: 'source', sourceNamespace: 'publisher-a', sourceGrain: 'external_release',
        exactRef: 'urn:release:1', targetGrain: 'PublicationIssue', ownerDataEpoch: 'source-epoch-2',
        ownerSequence: '7' }),
      member({ sourceOwner: 'source', sourceNamespace: 'publisher-a', sourceGrain: 'edition',
        exactRef: 'urn:edition:unknown', targetGrain: null, mapping: 'unmapped',
        ownerDataEpoch: 'source-epoch-2', ownerSequence: '7' }),
    ];
    const residuals = [{ memberOrdinal: 3, kind: 'unmapped_grain' as const,
      path: '/edition', detail: { reason: 'publisher did not identify an edition' } }];
    const plan = await planExport({ targetProfile: 'work-exchange-v1', useScope: 'evaluation',
      members, residuals }, async () => [basis([1, 2, 3])]);
    expect(plan.members.map(item => item.sourceGrain)).toEqual(['main_version', 'external_release', 'edition']);
    expect(plan.members.map(item => [item.targetGrain, item.mapping])).toEqual([
      ['CreativeWork', 'exact'], ['PublicationIssue', 'exact'], [null, 'unmapped'],
    ]);
    expect(plan.residuals).toEqual([{ ...residuals[0], ordinal: 1 }]);
    expect(plan.completeness).toBe('partial');
    expect(plan.members[2]?.targetGrain).toBeNull();
    await expect(planExport({ targetProfile: 'work-exchange-v1', useScope: 'evaluation',
      members, residuals: [] }, async () => [basis([1, 2, 3])])).rejects.toBeInstanceOf(InvalidExportPlan);
  });

  test('COMP08: repeated occurrences retain each exact position and owner-local sequence', async () => {
    const members = [member({ sourceGrain: 'occurrence', exactRef: 'urn:occurrence:1',
      sourcePosition: 'chapter/01', ownerSequence: '10' }),
    member({ sourceGrain: 'occurrence', exactRef: 'urn:occurrence:2',
      sourcePosition: 'chapter/02', ownerSequence: '11' })];
    const plan = await planExport({ targetProfile: 'composition-exchange-v1', useScope: 'evaluation',
      members, residuals: [] }, async () => [basis([1, 2])]);
    expect(plan.members.map(item => [item.exactRef, item.sourcePosition, item.ownerSequence]))
      .toEqual([['urn:occurrence:1', 'chapter/01', '10'], ['urn:occurrence:2', 'chapter/02', '11']]);
  });

  test('FACT05: unknown rights and private dependency stay explicit; changed use cannot inherit a basis', async () => {
    const members = [member({ sourceGrain: 'claim', exactRef: 'urn:claim:revision:1' }),
      member({ sourceGrain: 'assessment', exactRef: 'urn:assessment:revision:1', ownerSequence: '43' })];
    const losses = [{ memberOrdinal: 2, kind: 'private_dependency' as const,
      path: '/evidence/1', detail: { disclosed: false } }];
    const plan = await planExport({ targetProfile: 'verification-exchange-v1', useScope: 'evaluation',
      members, residuals: losses }, async () => [basis([1]), basis([2], {
        basisKind: 'use_assessment', result: 'undetermined', licenseExpression: null })]);
    expect(plan.licenseScope).toBe('uncertain');
    expect(plan.completeness).toBe('partial');
    await expect(planExport({ targetProfile: 'verification-exchange-v1', useScope: 'full',
      members, residuals: losses }, async () => [basis([1, 2])])).rejects.toBeInstanceOf(InvalidExportPlan);
  });

  test('LIVE15/LIVE17 hook: prohibited use blocks, different expressions stay uncertain', async () => {
    const members = [member(), member({ exactRef: 'urn:value:2' })];
    const input = { targetProfile: 'portable-values-v1', useScope: 'full' as const,
      members, residuals: [] };
    const blocked = await planExport(input, async () => [basis([1], { useScope: 'full' }),
      basis([2], { useScope: 'full', result: 'prohibited' })]);
    expect(blocked.licenseScope).toBe('blocked');
    const uncertain = await planExport(input, async () => [basis([1], { useScope: 'full' }),
      basis([2], { useScope: 'full', licenseExpression: 'CC-BY-SA-4.0',
        obligations: ['attribution', 'share_alike'] })]);
    expect(uncertain.licenseScope).toBe('uncertain');
    expect(uncertain.licenseExpression).toBeNull();
  });

  test('LIVE07 cost: planner counts its bounded selection and rejects an oversized manifest', async () => {
    const members = Array.from({ length: 256 }, (_, index) => member({ exactRef: `urn:value:${index}` }));
    const plan = await planExport({ targetProfile: 'portable-values-v1', useScope: 'evaluation',
      members, residuals: [] }, async () => [basis(members.map((_, index) => index + 1))]);
    expect(plan.work.members).toBe(256);
    expect(plan.work.bases).toBe(1);
    expect(plan.work.bytes).toBeGreaterThan(0);
    await expect(planExport({ targetProfile: 'portable-values-v1', useScope: 'evaluation',
      members: [...members, member()], residuals: [] }, async () => [basis([1])]))
      .rejects.toBeInstanceOf(InvalidExportPlan);
  });
});
