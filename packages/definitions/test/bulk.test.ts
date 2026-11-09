import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import {
  BATCH_LIMIT,
  FIELD_GROUPS,
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchReference,
  type BatchStatement,
  type BatchWriteRequest,
  type BatchWriteResult,
  type FieldGroup,
  type Source,
} from '../src/bulk.ts';

const source = (field_group: FieldGroup = 'facts'): Source => ({
  source: 'bangumi',
  external_id: '12',
  record_revision: '2026-10-01T00:00:00Z',
  digest: 'a'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group,
});
const reference: BatchReference = {
  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/12' } }],
};
const statement: BatchStatement = {
  property: { id: 'schema:name' },
  value: { type: 'value', content: { language: 'en', text: 'Example' } },
  qualifiers: [],
  references: [reference],
};
const without = (value: object, field: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== field));
const subject = crypto.randomUUID();
const valid: BatchWriteRequest = {
  commands: [
    {
      op: 'create',
      key: 'bangumi:12:1',
      source: source(),
      subject: {
        type: 'schema:Book',
        labels: { ja: 'Example' },
      },
    },
    {
      op: 'propose',
      key: 'bangumi:12:2',
      source: source(),
      subject,
      statement: { ...statement, rank: 'preferred' },
    },
    {
      op: 'retract',
      key: 'bangumi:12:3',
      source: source(),
      subject,
      candidate: crypto.randomUUID(),
      references: [reference],
    },
  ],
};

test('a batch of create, propose and retract commands is structurally valid', () => {
  expect(BATCH_LIMIT).toBe(100);
  expect([...FIELD_GROUPS]).toEqual(['facts', 'summary', 'cover']);
  expect(checkBatchWrite(valid)).toEqual([]);
  expect(checkBatchWrite(JSON.parse(JSON.stringify(valid)))).toEqual([]);
  expect(checkBatchWrite(valid, bundledRelease)).toEqual([]);
});

test('malformed batches are refused with pointers into the batch', () => {
  type Loose = Record<string, unknown>;
  const [create, propose, retract] = valid.commands as unknown as [Loose, Loose, Loose];
  const cases: [unknown, string, string][] = [
    [{}, '/commands', 'required'],
    [{ commands: [] }, '/commands', 'out_of_range'],
    [
      { commands: Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => ({ ...propose, key: `k${i}` })) },
      '/commands',
      'out_of_range',
    ],
    [{ commands: [{ ...propose, op: 'delete' }] }, '/commands/0/op', 'unsupported'],
    [{ commands: [propose, { ...retract, key: propose.key }] }, '/commands/1/key', 'invalid_format'],
    [{ commands: [{ ...propose, key: '' }] }, '/commands/0/key', 'out_of_range'],
    [{ commands: [{ ...propose, extra: true }] }, '/commands/0/extra', 'unknown_field'],
    [
      { commands: [{ ...propose, source: { ...source(), field_group: 'posts' } }] },
      '/commands/0/source/field_group',
      'unsupported',
    ],
    [
      { commands: [{ ...propose, source: { ...source(), digest: 'xyz' } }] },
      '/commands/0/source/digest',
      'invalid_format',
    ],
    [
      { commands: [{ ...propose, source: without(source(), 'converter_revision') }] },
      '/commands/0/source/converter_revision',
      'required',
    ],
    [{ commands: [{ ...propose, subject: 'not-a-uuid' }] }, '/commands/0/subject', 'invalid_format'],
    [
      { commands: [{ ...propose, statement: { ...statement, rank: 'deprecated' } }] },
      '/commands/0/statement/rank',
      'unsupported',
    ],
    [
      { commands: [{ ...propose, statement: { ...statement, references: [] } }] },
      '/commands/0/statement/references',
      'required',
    ],
    [
      { commands: [{ ...propose, statement: without(statement, 'references') }] },
      '/commands/0/statement/references',
      'required',
    ],
    [
      { commands: [{ ...create, subject: without(create.subject as object, 'labels') }] },
      '/commands/0/subject/labels',
      'required',
    ],
    [
      {
        commands: [
          { ...create, subject: { ...(create.subject as object), statements: { 'schema:name': [statement] } } },
        ],
      },
      '/commands/0/subject/statements',
      'unsupported',
    ],
    [{ commands: [{ ...retract, candidate: 7 }] }, '/commands/0/candidate', 'invalid_type'],
  ];
  for (const [input, pointer, code] of cases) {
    expect({ pointer, violations: checkBatchWrite(input) }).toEqual({
      pointer,
      violations: expect.arrayContaining([{ pointer, code }]),
    });
  }
});

test('results are one per command, either a value or a problem', () => {
  const result: BatchWriteResult = {
    results: [
      { key: 'bangumi:12:1', status: 201, value: { id: crypto.randomUUID(), revision: 1 } },
      { key: 'bangumi:12:2', status: 201, value: { candidate: crypto.randomUUID(), revision: 2 } },
      {
        key: 'bangumi:12:3',
        status: 409,
        problem: { type: 'https://rezics.com/problems/fenced', title: 'Fenced', status: 409, retryable: false },
      },
    ],
  };
  expect(checkBatchWriteResult(result)).toEqual([]);
  expect(
    checkBatchWriteResult({
      results: [
        {
          key: 'bangumi:12:3',
          status: 409,
          problem: { type: 'https://rezics.com/problems/fenced', title: 'Fenced', status: 409 },
        },
      ],
    }),
  ).not.toEqual([]);
  expect(checkBatchWriteResult({ results: [{ key: 'k', status: 201 }] })).not.toEqual([]);
  expect(checkBatchWriteResult({ results: [{ key: 'k', status: 409, value: { revision: 1 } }] })).not.toEqual([]);
});
