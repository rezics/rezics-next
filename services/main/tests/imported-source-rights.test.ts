import { expect, test } from 'bun:test';
import { importedRightsAssessments, BANGUMI_LICENSE, VNDB_LICENSE, VNDB_CONTENTS_LICENSE,
  OPEN_LIBRARY_LICENSE, GUTENBERG_LICENSE } from '../src/modules/rights/import-policy.ts';
import { rightsExportUseScope } from '../src/modules/rights/store.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('Bangumi summaries retain CC BY-SA 3.0 and source credit for display and every export use', () => {
  const source = { provider: 'bangumi' as const, url: 'https://bgm.tv/subject/975' };
  const assessments = importedRightsAssessments(source, work, true);
  expect(assessments).toHaveLength(12);
  for (const component of ['record', 'synopsis']) {
    const selected = assessments.filter(item => item.material.component === component);
    expect(selected.filter(item => item.useKind === 'wiki_display')).toHaveLength(1);
    for (const scope of ['full', 'excerpt', 'quotation', 'evaluation'] as const) {
      expect(selected.find(item => item.useScope === rightsExportUseScope(scope))?.useKind)
        .toBe(scope === 'excerpt' || scope === 'quotation' ? 'quotation' : 'export');
    }
    for (const item of selected) {
      expect(item.licenseInstrument).toBe(BANGUMI_LICENSE);
      expect(item.obligations.map(obligation => obligation.kind)).toEqual(['attribution', 'share_alike']);
      expect(item.obligations.every(obligation => obligation.appliesTo === 'all'
        && obligation.notice.includes(source.url) && obligation.notice.includes('Bangumi contributors'))).toBe(true);
      expect(item.material.workId).toBe(work);
      expect(item.material.mediaAsset).toBeNull();
    }
  }
});

test('VNDB publishes both database instruments without treating description exceptions as licensed', () => {
  const assessments = importedRightsAssessments({ provider: 'vndb', url: 'https://vndb.org/v11' }, work, true);
  expect(assessments).toHaveLength(6);
  for (const item of assessments) {
    expect(item.material.component).toBe('record');
    expect(item.licenseInstrument).toBe(VNDB_LICENSE);
    expect(item.obligations.some(obligation => obligation.instrument === VNDB_CONTENTS_LICENSE
      && obligation.notice.includes(VNDB_CONTENTS_LICENSE))).toBe(true);
  }
});

test('Open Library and public-domain recipes retain source, author and exact licence evidence', () => {
  const library = importedRightsAssessments({ provider: 'open-library',
    url: 'https://openlibrary.org/works/OL66554W' }, work);
  expect(library.every(item => item.licenseInstrument === OPEN_LIBRARY_LICENSE)).toBe(true);
  const recipes = importedRightsAssessments({ provider: 'project-gutenberg',
    url: 'https://www.gutenberg.org/ebooks/59047', credit: 'Pellegrino Artusi' }, work);
  for (const item of recipes) {
    expect(item.basis).toBe('public_domain');
    expect(item.licenseInstrument).toBeNull();
    expect(item.obligations[0]?.instrument).toBe(GUTENBERG_LICENSE);
    expect(item.obligations[0]?.notice).toContain('Pellegrino Artusi');
    expect(item.obligations[0]?.notice).toContain('Project Gutenberg');
    expect(item.obligations.some(obligation => obligation.kind === 'share_alike')).toBe(false);
  }
});
