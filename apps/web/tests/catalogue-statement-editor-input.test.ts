import { expect, test } from 'bun:test';
import { proposalInput, type ProposalCommand, type StatementInput } from '../src/features/catalogue/statement-editor';
import { statementDraftChanged } from '../src/features/catalogue/statement-editor-navigation';

test('the correction BFF accepts a native statement object rather than a selected-statement route id', () => {
  const command: ProposalCommand = {
    id: crypto.randomUUID(),
    key: crypto.randomUUID(),
    statement: {
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://example.org/correction' },
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } }],
        },
      ],
    },
  };
  const original = structuredClone(command);
  expect(proposalInput(command)).toEqual(original);
  expect(proposalInput({ ...command, statement: crypto.randomUUID() })).toEqual({ invalid: true });
  expect(proposalInput({ ...command, source: { source: 'wikidata' } })).toEqual({ invalid: true });
  expect(proposalInput({ ...command, statement: { ...command.statement, source: { source: 'wikidata' } } })).toEqual({
    invalid: true,
  });
  expect(command).toEqual(original);
});

test('statement draft comparison covers values, entity selections, qualifiers, and citation metadata as one correction', () => {
  const original: StatementInput = {
    property: { id: 'schema:datePublished' },
    value: { type: 'value', content: { time: '+1943-04-06T00:00:00Z', precision: 11 } },
    qualifiers: [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: { id: 'Q42', label: 'Author' } },
      },
    ],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } },
          { property: { id: 'schema:author' }, value: { type: 'value', content: { id: 'Q7', label: 'Editor' } } },
        ],
      },
    ],
    rank: 'normal',
  };
  expect(statementDraftChanged(original, structuredClone(original))).toBe(false);
  const reverted = structuredClone(original);
  reverted.value = { type: 'value', content: { time: '+1946-04-06T00:00:00Z' } };
  expect(statementDraftChanged(original, reverted)).toBe(true);
  reverted.value = structuredClone(original.value);
  expect(statementDraftChanged(original, reverted)).toBe(false);
  const reordered = structuredClone(original);
  reordered.qualifiers![0]!.value = { type: 'value', content: { label: 'Author', id: 'Q42' } };
  expect(statementDraftChanged(original, reordered)).toBe(false);
  for (const edit of [
    (draft: StatementInput) => (draft.value = { type: 'value', content: { time: '+1946-04-06T00:00:00Z' } }),
    (draft: StatementInput) => (draft.qualifiers![0]!.value = { type: 'value', content: { id: 'Q43' } }),
    (draft: StatementInput) => (draft.references[0]!.parts[1]!.value = { type: 'value', content: { id: 'Q8' } }),
  ]) {
    const draft = structuredClone(original);
    edit(draft);
    expect(statementDraftChanged(original, draft)).toBe(true);
  }
});
