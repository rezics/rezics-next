import { expect, test } from 'bun:test';
import { convertBangumi } from '../src/bangumi.ts';

const subjectId = '00000000-0000-8000-8000-0000000000aa';

test('Novel-template light novel series and volumes keep their exact und archive aliases', () => {
  for (const [id, series, alias] of [
    [2815, true, 'THE GARDEN OF SINNERS'],
    [5329, false, 'THE GARDEN OF SINNERS (1)'],
  ] as const) {
    const record = {
      id,
      type: 1,
      name: '空の境界',
      name_cn: '空之境界',
      platform: 1002,
      series,
      infobox: `{{Infobox animanga/Novel\r\n|中文名= 空之境界\r\n|别名={\r\n[${alias}]\r\n}\r\n|作者= 奈須きのこ\r\n}}`,
    };
    const converted = convertBangumi({ external_id: String(id), record_revision: null, record } as never, {
      source: 'bangumi',
      subjectId,
    });
    expect(converted.outcome).toBe('converted');
    const names = (converted.proposals ?? []).flatMap((command) =>
      command.op === 'propose' && command.statement.property.id === 'schema:name'
        ? [command.statement.value.content]
        : [],
    );
    expect(names).toContainEqual({ language: 'und', text: alias });
    expect(names).toContainEqual({ language: 'zh', text: '空之境界' });
  }
});
