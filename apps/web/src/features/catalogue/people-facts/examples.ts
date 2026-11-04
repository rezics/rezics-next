import definitions from '../../../kernel/recorded/definitions-release.json';
import { personReaderExample } from '../person-reader/examples';
import type { PersonDefinitions } from '../person-reader/model';

/** Supplied response examples for mounted consumers; these are not native seeded journeys. */
export function peopleFactsExample(character = false) {
  const fixture = personReaderExample();
  const read = fixture.read;
  const property = character ? 'schema:height' : 'wdt:P106';
  const rows = Array.from({ length: 43 }, (_, index) => {
    const statement = character
      ? fixture.statement(property, { amount: '+165.5', unit: 'http://www.wikidata.org/entity/Q174728' }, 'quantity')
      : structuredClone(read.subject.statements[property]![0]!);
    statement.id = `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
    statement.rezics = { release: definitions.digest, revision: index + 1 };
    statement.qualifiers = [
      {
        property: { id: 'schema:name', data_type: 'monolingualtext' },
        value: {
          type: 'value',
          content: { text: index === 0 ? '最初 العربية — original' : `Condition ${index + 1}`, language: 'ja' },
        },
      },
    ];
    return statement;
  });
  if (character) {
    read.subject.type = 'wd:Q95074';
    read.subject.statements = {};
  }
  read.subject.statements[property] = rows;
  read.subject.release = definitions.digest;
  return { ...fixture, read, property, rows, release: definitions.release as unknown as PersonDefinitions };
}
