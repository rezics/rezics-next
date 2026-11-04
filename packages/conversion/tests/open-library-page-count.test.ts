import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import editionFixture from '../../../specs/fixtures/imports/open-library/edition-number-of-pages.json';
import workFixture from '../../../specs/fixtures/imports/open-library/work-number-of-pages.json';
import { convertOpenLibrary } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const edition = editionFixture.record;
const convert = (record: object) =>
  convertOpenLibrary({ external_id: edition.key, record_revision: String(edition.revision), record }, { subjectId });
const pageCountProposal = (commands: readonly BatchCommand[]) =>
  commands.find(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'schema:numberOfPages',
  );

test('observed edition pages are a released cited unit quantity and change source evidence', () => {
  expect(editionFixture._fixture).toMatchObject({
    source_url: 'https://openlibrary.org/books/OL7353617M.json',
    revision: 28,
    last_modified: '2025-12-15T09:37:45.661490',
  });
  const result = convert(edition);
  expect(result.normalizedRecord.number_of_pages).toBe(96);
  const proposal = pageCountProposal(result.proposals);
  expect(proposal).toBeDefined();
  if (!proposal || proposal.statement.value.type !== 'value') throw new Error('Missing edition page-count proposal');
  expect(proposal.statement.value.content).toEqual({ amount: '+96', unit: '1' });
  expect(proposal.statement.references[0]?.parts).toEqual(
    expect.arrayContaining([
      { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/books/OL7353617M.json' } },
      { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL7353617M' } },
      { property: { id: 'schema:version' }, value: { type: 'value', content: '28' } },
      {
        property: { id: 'schema:dateModified' },
        value: {
          type: 'value',
          content: {
            time: '+2025-12-15T00:00:00Z',
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      },
    ]),
  );
  expect(checkStatementInput(proposal.statement, bundledRelease).violations).toEqual([]);
  expect(convert({ ...edition, number_of_pages: Number.MAX_SAFE_INTEGER }).normalizedRecord.number_of_pages).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  const maxPageProposal = pageCountProposal(convert({ ...edition, number_of_pages: Number.MAX_SAFE_INTEGER }).proposals);
  expect(maxPageProposal).toBeDefined();
  if (!maxPageProposal || maxPageProposal.statement.value.type !== 'value')
    throw new Error('Missing maximum safe page-count proposal');
  expect(maxPageProposal.statement.value.content).toEqual({ amount: `+${Number.MAX_SAFE_INTEGER}`, unit: '1' });
  expect(convert({ ...edition, number_of_pages: 97 }).digest).not.toBe(result.digest);

  const work = { ...workFixture.record, number_of_pages: 96 };
  const workResult = convertOpenLibrary(
    { external_id: work.key, record_revision: String(work.revision), record: work },
    { subjectId },
  );
  expect(workResult.sourceMetadata.subjectType).toBe('schema:Book');
  expect(workResult.normalizedRecord).not.toHaveProperty('number_of_pages');
  expect(workResult.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:numberOfPages')).toBe(
    false,
  );
});

test('missing and malformed page counts stay unknown without dropping independent edition facts', () => {
  const missing = { ...edition, pagination: '96p.', word_count: 900 };
  delete (missing as { number_of_pages?: number }).number_of_pages;
  const absent = convert(missing);
  expect(absent.diagnostics).toContainEqual({ pointer: '/number_of_pages', code: 'missing_number_of_pages' });
  expect(absent.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:numberOfPages')).toBe(
    false,
  );
  expect(absent.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount')).toBe(
    false,
  );
  expect(absent.proposals.some((command) => command.op === 'retract')).toBe(false);

  for (const value of [null, '96', '96p.', 96.5, Number.MAX_SAFE_INTEGER + 1, 0, -1, {}]) {
    const result = convert({ ...edition, number_of_pages: value, pagination: '96p.', word_count: 900 });
    expect(result.outcome).toBe('converted');
    expect(result.diagnostics).toContainEqual({ pointer: '/number_of_pages', code: 'invalid_number_of_pages' });
    expect(result.normalizedRecord).not.toHaveProperty('number_of_pages');
    expect(result.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:isbn')).toBe(
      true,
    );
    expect(result.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:inLanguage')).toBe(
      true,
    );
    expect(result.proposals.some((command) => command.op === 'retract')).toBe(false);
    expect(result.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount')).toBe(
      false,
    );
  }
});
