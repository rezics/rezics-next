import { expect, test } from 'bun:test';
import { compileCatalogue } from '../src/compile.ts';

const prefixes = { linkml: 'https://w3id.org/linkml/', ex: 'https://example.org/' };

const classes = {
  Thing: { abstract: true, class_uri: 'ex:Thing' },
  Agent: { abstract: true, is_a: 'Thing' },
  Group: { abstract: true, is_a: 'Agent', class_uri: 'ex:Group' },
  Staff: { is_a: 'Group', class_uri: 'ex:Staff' },
  Person: { is_a: 'Agent', class_uri: 'ex:Person' },
  Work: { abstract: true, is_a: 'Thing', class_uri: 'ex:Work' },
  Book: { is_a: 'Work', class_uri: 'ex:Book' },
};

const slots = {
  focus: { slot_uri: 'ex:focus', range: 'Thing', annotations: { datatype: 'wikibase-item' } },
  member: { slot_uri: 'ex:member', range: 'Agent', annotations: { datatype: 'wikibase-item' } },
  about: { slot_uri: 'ex:about', range: 'Work', annotations: { datatype: 'wikibase-item' } },
  credit: {
    slot_uri: 'ex:credit',
    any_of: [{ range: 'Book' }, { range: 'Person' }],
    annotations: { datatype: 'wikibase-item' },
  },
};

const labels = {
  types: { 'ex:Staff': 'staff', 'ex:Person': 'person', 'ex:Book': 'book' },
  properties: { 'ex:focus': 'focus', 'ex:member': 'member', 'ex:about': 'about', 'ex:credit': 'credit' },
};

function input(novel = false) {
  const imported = ['linkml:types', 'core', ...(novel ? ['novel'] : [])];
  const schemas: Record<string, string> = {
    'fixture.yaml': JSON.stringify({
      id: 'https://example.org/catalogue/fixture',
      name: 'fixture',
      version: '1.0.0',
      prefixes,
      imports: imported,
    }),
    'core.yaml': JSON.stringify({
      id: 'https://example.org/catalogue/core',
      name: 'core',
      version: '1.0.0',
      prefixes,
      default_range: 'string',
      imports: ['linkml:types'],
      classes,
      slots,
    }),
  };
  const presentation = {
    en: JSON.stringify({
      ...labels,
      ...(novel ? { types: { ...labels.types, 'ex:Novel': 'novel' } } : {}),
    }),
  };
  if (novel)
    schemas['novel.yaml'] = JSON.stringify({
      id: 'https://example.org/catalogue/novel',
      name: 'novel',
      version: '1.0.0',
      prefixes,
      imports: ['linkml:types', 'core'],
      classes: { Novel: { is_a: 'Book', class_uri: 'ex:Novel' } },
    });
  return { root: 'fixture.yaml', schemas, presentation };
}

test("an item property's targets are its declared range classes", async () => {
  const release = await compileCatalogue(input());
  expect(release.properties['ex:focus']!.targets).toEqual(['ex:Thing']);
  expect(release.properties['ex:member']!.targets).toEqual(['ex:Group', 'ex:Person']);
  expect(release.properties['ex:about']!.targets).toEqual(['ex:Work']);
  expect(release.properties['ex:credit']!.targets).toEqual(['ex:Book', 'ex:Person']);
});

test("adding a vertical subtype leaves every other property's targets unchanged", async () => {
  const first = await compileCatalogue(input());
  const second = await compileCatalogue(input(true));
  expect(second.types['ex:Novel']).toBeDefined();
  for (const [key, property] of Object.entries(first.properties))
    expect(second.properties[key]!.targets).toEqual(property.targets);
});
