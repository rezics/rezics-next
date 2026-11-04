import { expect, test } from 'bun:test';
import { parseVndb } from '../../src/library/list-import-vndb-parser.ts';

test('private evidence preserves source spelling and unsupported precision without inventing native facts', () => {
  const [row] = parseVndb(`<vndb-export version="1.0"><vns><vn id="v1" private=" 1 ">
    <vote> 07.3 </vote><notes>  exact\ntext  </notes>
    <started> 2020-05-00 </started><finished>2020-05-03T12:34:56Z</finished>
    <priority>unmapped</priority><unknown>original</unknown>
  </vn></vns></vndb-export>`);
  expect(row?.fields).toMatchObject({
    score: { raw: ' 07.3 ', value: 7.3 },
    notes: { raw: '  exact\ntext  ', value: '  exact\ntext  ' },
    started: { raw: ' 2020-05-00 ', value: '2020-05', precision: 'month' },
    finished: { kind: 'invalid', raw: '2020-05-03T12:34:56Z' },
    privacy: { raw: ' 1 ' },
  });
  expect(JSON.stringify(row?.evidence)).toContain('unmapped');
  expect(JSON.stringify(row?.evidence)).toContain('original');
});
