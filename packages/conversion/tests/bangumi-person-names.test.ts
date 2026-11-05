import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { readFileSync } from 'node:fs';
import { ConversionError } from '../src/index.ts';
import { convertCrossMediaEntity, converter_revision } from '../src/cross-media-entities.ts';
import { projectBangumiPersonName } from '../src/bangumi-person-names.ts';

const evidence = JSON.parse(
  readFileSync(new URL('../../../specs/fixtures/imports/bangumi/person-names.json', import.meta.url), 'utf8'),
) as { operatorExample: { responseBody: string; responseSha256: string } };
const subject = '11111111-1111-4111-8111-111111111111';

function convert(record: unknown, id = 641) {
  return convertCrossMediaEntity(
    { external_id: `person:${id}`, record_revision: null, record },
    { source: 'bangumi_cross_media', subjectId: subject },
    { sourceKind: 'bangumi' },
  );
}

function names(result: ReturnType<typeof convert>) {
  return result.proposals.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'schema:name',
  );
}

function valueContent(command: Extract<BatchCommand, { op: 'propose' }>) {
  return command.statement.value.type === 'value' ? command.statement.value.content : undefined;
}

test('PersonDetail infobox name reaches cited Person statements with the original name', () => {
  const record = JSON.parse(evidence.operatorExample.responseBody) as Record<string, unknown>;
  expect(createHash('sha256').update(evidence.operatorExample.responseBody).digest('hex')).toBe(
    evidence.operatorExample.responseSha256,
  );
  expect(converter_revision).toBe('cross-media-entities@15');
  expect(convert(record).normalizedRecord.name_cn).toBe('岸本齐史');
  const proposals = names(convert(record));
  expect(proposals.map(valueContent)).toEqual([
    { language: 'und', text: '岸本斉史' },
    { language: 'zh', text: '岸本齐史' },
  ]);
  for (const proposal of proposals) {
    expect(proposal.source).toMatchObject({
      source: 'bangumi_cross_media',
      external_id: 'person:641',
      record_revision: 'unversioned',
      converter_revision,
      field_group: 'facts',
    });
    expect(proposal.statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/person/641' },
    });
    expect(checkStatementInput(proposal.statement, bundledRelease).violations).toEqual([]);
  }
  expect(proposals[0]?.source.digest).not.toBe(
    convert({ ...record, infobox: [{ key: '简体中文名', value: '岸本斉史' }] }).digest,
  );
  expect(convert(record).proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:alternateName')).toBe(false);
  const organization = convertCrossMediaEntity(
    { external_id: 'person:641', record_revision: null, record: { ...record, type: 2 } },
    { source: 'bangumi_cross_media' },
    { sourceKind: 'bangumi' },
  );
  expect(organization.proposals.find((command) => command.op === 'create')?.subject.type).toBe('schema:Organization');
  expect(() => convert({ ...record, id: 642 })).toThrow(ConversionError);
});

test('ambiguous or invalid Chinese values are withheld without dropping an independent original name', () => {
  const base = { id: 641, type: 1, name: '原名' };
  const badValues: unknown[] = [
    { key: '简体中文名', value: { nested: ['不得读取'] } },
    { key: '简体中文名', value: ['不得读取'] },
    { key: '简体中文名', value: '  ' },
    { key: '简体中文名', value: '带\u0000控制符' },
    { key: '简体中文名', value: 'x'.repeat(4097) },
    { key: '简体中文名', value: '\ud800' },
  ];
  for (const entry of badValues) {
    const result = convert({ ...base, infobox: [entry] });
    expect(names(result).map(valueContent)).toEqual([{ language: 'und', text: '原名' }]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }

  for (const infobox of [
    [{ key: '简体中文名', value: '甲' }, { key: '简体中文名', value: '乙' }],
    Array.from({ length: 65 }, (_, index) => ({ key: index === 64 ? '简体中文名' : 'unknown', value: '越界' })),
  ])
    expect(names(convert({ ...base, infobox })).map(valueContent)).toEqual([
      { language: 'und', text: '原名' },
    ]);

  expect(
    names(convert({ ...base, name_cn: '甲', infobox: [{ key: '简体中文名', value: '乙' }] })).map(valueContent),
  ).toEqual([{ language: 'und', text: '原名' }]);
  expect(
    names(convert({ ...base, name_cn: '甲', infobox: [{ key: '简体中文名', value: '甲' }] })).map(valueContent),
  ).toEqual([
    { language: 'und', text: '原名' },
    { language: 'zh', text: '甲' },
  ]);
  expect(names(convert({ ...base })).map(valueContent)).toEqual([
    { language: 'und', text: '原名' },
  ]);
  const duplicate = projectBangumiPersonName(undefined, false, [
    { key: '简体中文名', value: '甲' },
    { key: '简体中文名', value: '甲' },
  ]);
  expect(duplicate.chineseName).toBe('甲');
  expect(duplicate.diagnostics).toContainEqual({ pointer: '/infobox', code: 'duplicate_source_name_reconciled' });
  expect(projectBangumiPersonName('甲', true, [], true, 65_537).chineseName).toBeUndefined();
  expect(projectBangumiPersonName(undefined, false, Array(64).fill(null)).diagnostics).toHaveLength(16);
  expect(projectBangumiPersonName('甲', true, [{ key: '简体中文名', value: '乙' }]).chineseName).toBeUndefined();
});
