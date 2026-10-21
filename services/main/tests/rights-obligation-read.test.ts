import { expect, test } from 'bun:test';
import { planExport, type VerifiedExportMember } from '../src/modules/export/planner.ts';
import { exportSupportedObligationKinds, projectWikiDisplay, unassessedExportBasis } from '../src/modules/rights/store.ts';
import { wikiDisplayObligations } from '../src/modules/work/read-contract.ts';
import { Value } from 'typebox/value';

const member: VerifiedExportMember = {
  sourceOwner: 'graph', sourceNamespace: 'fixture:rights', sourceGrain: 'work',
  exactRef: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', contentRevisionId: null,
  refDigest: 'a'.repeat(64), ownerDataEpoch: '1', ownerSequence: '1', sourcePosition: null,
  targetGrain: 'work', mapping: 'exact',
};

test('a missing export head is unassessed, and change indication stays an export obligation', async () => {
  const missing = await planExport({ targetProfile: 'rezics-content-v1', useScope: 'full',
    members: [member], residuals: [] }, async () => [unassessedExportBasis('full', 1)]);
  expect(missing.bases[0]).toMatchObject({ basisKind: 'unassessed', result: 'undetermined', obligations: [],
    basisRef: null });
  expect(missing.licenseScope).toBe('uncertain');
  expect(exportSupportedObligationKinds.change_indication).toBe('change_indication');
  expect('other' in exportSupportedObligationKinds).toBe(false);
  const indicated = await planExport({ targetProfile: 'rezics-content-v1', useScope: 'full',
    members: [member], residuals: [] }, async () => [{
      basisKind: 'use_assessment', basisRef: 'assessment-1', licenseExpression: 'https://example.test/license',
      notice: null, obligations: ['attribution', 'change_indication'], useScope: 'full', result: 'conditional',
      memberOrdinals: [1],
    }]);
  expect(indicated.bases[0]?.obligations).toEqual(['attribution', 'change_indication']);
  expect(indicated.licenseScope).toBe('determined');
});

test('wiki display keeps display obligations and a hidden head reveals nothing', () => {
  expect(projectWikiDisplay(undefined, false)).toEqual({ status: 'unassessed' });
  const row = { assessmentId: 'head-1', licenseInstrument: 'https://example.test/by',
    obligations: [
      { kind: 'attribution', instrument: 'https://example.test/by', appliesTo: 'display', notice: 'Open Library' },
      { kind: 'share_alike', instrument: 'https://example.test/by', appliesTo: 'export', notice: 'export only' },
      { kind: 'change_indication', instrument: 'https://example.test/by', appliesTo: 'all', notice: null },
    ] };
  expect(projectWikiDisplay(row, false)).toEqual({ status: 'assessed', use: 'wiki_display',
    instrument: 'https://example.test/by', obligations: [
      { kind: 'attribution', instrument: 'https://example.test/by', appliesTo: 'display', notice: 'Open Library' },
      { kind: 'change_indication', instrument: 'https://example.test/by', appliesTo: 'all', notice: null },
    ] });
  const hidden = projectWikiDisplay({ ...row, obligations: [
    { kind: 'attribution', instrument: 'https://example.test/secret', appliesTo: 'display', notice: 'do not leak' },
  ] }, true);
  expect(hidden).toEqual({ status: 'unassessed' });
  expect(JSON.stringify(hidden)).not.toContain('do not leak');
  expect(JSON.stringify(hidden)).not.toContain('secret');
});

test('wiki display retains the exact assessed material and only its supplied source/evidence identity', () => {
  const row = { assessmentId: '00000000-0000-4000-8000-000000000011',
    materialId: '00000000-0000-4000-8000-000000000012', component: 'synopsis',
    sourceRecordId: '00000000-0000-4000-8000-000000000013',
    wikiEvidenceId: 'https://rezics.com/id/00000000-0000-4000-8000-000000000014',
    licenseInstrument: 'https://example.test/by', obligations: [
      { kind: 'attribution', instrument: 'https://example.test/by', appliesTo: 'display',
        notice: 'Archive, https://example.test/record' },
    ] };
  const identity = { assessmentId: row.assessmentId, materialId: row.materialId, component: row.component,
    sourceRecordId: row.sourceRecordId, wikiEvidenceId: row.wikiEvidenceId };
  const projected = projectWikiDisplay(row, false);
  expect(projected).toMatchObject({ identity });
  expect(Value.Check(wikiDisplayObligations, projected)).toBe(true);
  expect(Value.Check(wikiDisplayObligations, { ...projected, identity: { ...identity, sourceUrl: 'https://example.test/record' } })).toBe(false);
  expect(projectWikiDisplay({ ...row, sourceRecordId: null, wikiEvidenceId: null }, false))
    .toMatchObject({ identity: { ...identity, sourceRecordId: null, wikiEvidenceId: null } });
  expect(projectWikiDisplay(row, true)).toEqual({ status: 'unassessed' });
  expect(Value.Check(wikiDisplayObligations, { status: 'unassessed', identity })).toBe(false);
});
