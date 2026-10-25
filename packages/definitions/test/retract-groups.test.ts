import { expect, test } from 'bun:test';
import { checkBatchWrite, type Source } from '../src/bulk.ts';

const source: Source = {
  source: 'bangumi',
  external_id: '253',
  record_revision: 'unversioned',
  digest: 'd'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group: 'summary',
};
const retract = (field_group: Source['field_group'], extra: Record<string, unknown> = {}) => ({
  op: 'retract',
  key: `retract-${field_group}`,
  source: { ...source, field_group },
  subject: '019a1b2c-3d4e-7f00-8a00-5b0000000061',
  candidate: '019a1b2c-3d4e-7f00-8a00-5b0000000062',
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/253' } }] },
  ],
  ...extra,
});

test('a source retracts its own summary and cover candidates without rights', () => {
  expect(checkBatchWrite({ commands: [retract('summary'), retract('cover'), retract('facts')] })).toEqual([]);
  const rights = { license: 'CC-BY-SA-3.0', obligations: [], attribution: 'Bangumi contributors' };
  expect(checkBatchWrite({ commands: [retract('summary', { rights })] })).toEqual([
    { pointer: '/commands/0/rights', code: 'unsupported' },
  ]);
  expect(
    checkBatchWrite({
      commands: [
        {
          op: 'create',
          key: 'create',
          source: { ...source, field_group: 'cover' },
          subject: { type: 'schema:Book', labels: { ja: '猫' } },
        },
      ],
    }),
  ).toEqual([{ pointer: '/commands/0/source/field_group', code: 'unsupported' }]);
});
