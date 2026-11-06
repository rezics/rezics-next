import { expect, test } from 'bun:test';
import { admitBoundProposals, createSourceRegistration } from '../src/source-registry.ts';
import pinned from '../../kernel/test/imports/showcase-books-source.json';

const alias = 'bangumi_cross_media';
const subjectId = '00000000-0000-8000-8000-0000000000aa';
const rows = pinned.rows as Record<string, Record<string, unknown>[]>;
const subject = (id: number) => rows.subject!.find((row) => row.id === id)!;
const proposedProperties = (proposals: readonly { op: string; statement?: { property: { id: string } } }[]) =>
  proposals.flatMap((command) =>
    command.op === 'propose' && command.statement ? [command.statement.property.id] : [],
  );

test('bound book statements keep only what the released native profile admits', () => {
  const registration = admitBoundProposals(createSourceRegistration('bangumi', { source: alias }), (externalId) =>
    externalId === '499' ? 'schema:BookSeries' : 'schema:Book',
  );
  const convert = (id: number) =>
    registration.convert(
      { external_id: String(id), record_revision: 'unversioned', record: subject(id) as never },
      { source: alias, subjectId },
    );

  // A BookSeries admits names and publisher; its Bangumi identity, date and summary are withheld, not sent.
  const series = convert(499);
  expect(proposedProperties(series.proposals)).toContain('schema:name');
  for (const property of ['wdt:P5732', 'schema:datePublished', 'schema:abstract'])
    expect(proposedProperties(series.proposals)).not.toContain(property);
  expect(series.diagnostics.filter((item) => item.code === 'property_not_admitted')).toHaveLength(3);

  // A Book volume admits all three statements, so nothing is withheld.
  const volume = convert(26);
  for (const property of ['wdt:P5732', 'schema:datePublished', 'schema:abstract'])
    expect(proposedProperties(volume.proposals)).toContain(property);
  expect(volume.diagnostics.some((item) => item.code === 'property_not_admitted')).toBe(false);
});
