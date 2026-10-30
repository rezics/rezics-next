import { expect, test } from 'bun:test';
import { proposalInput, type ProposalCommand } from '../src/features/catalogue/statement-editor';

test('the correction BFF accepts a native statement object rather than a selected-statement route id', () => {
  const command: ProposalCommand = {
    id: crypto.randomUUID(),
    key: crypto.randomUUID(),
    statement: {
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://example.org/correction' },
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } }] },
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
