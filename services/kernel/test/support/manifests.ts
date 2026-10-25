// Deterministic fixture verticals for expansion and search cost tests.
// Each vertical is one schema that imports core, plus one label file for every UI locale.
// The ex prefix is a fixture vocabulary and is never part of the bundled catalogue.

export const VERTICAL_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;

const PROPERTIES = [
  ['relatedWork', 'wikibase-item', 'work'],
  ['relatedEdition', 'wikibase-item', 'edition'],
  ['member', 'wikibase-item', 'agent'],
  ['cast', 'wikibase-item', 'person'],
  ['publisher', 'wikibase-item', 'organization'],
  ['published', 'time', 'date'],
  ['revised', 'time', 'date'],
  ['count', 'quantity', 'integer'],
  ['note', 'string', 'string'],
  ['headline', 'monolingualtext', 'string'],
  ['code', 'external-id', 'string'],
  ['subtitle', 'string', 'string'],
] as const;

const FACETS = ['cast', 'published', 'count'] as const;

export type VerticalProfile = {
  readonly index: number;
  readonly name: string;
  readonly schema: string;
  readonly work: string;
  readonly edition: string;
  readonly agent: string;
  readonly cast: string;
  readonly published: string;
  readonly count: string;
  readonly properties: readonly string[];
};

export type VerticalSources = {
  readonly schemas: Readonly<Record<string, string>>;
  readonly presentation: Readonly<Record<string, string>>;
};

function manifestIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError('Vertical index must be a non-negative safe integer');
}

const slotName = (index: number, key: string) => `v${index}${key[0]!.toUpperCase()}${key.slice(1)}`;
const propertyCurie = (index: number, key: string) => `ex:${slotName(index, key)}`;

export function verticalProfile(index: number): VerticalProfile {
  manifestIndex(index);
  return {
    index,
    name: `v${index}`,
    schema: `v${index}.yaml`,
    work: `ex:V${index}Work`,
    edition: `ex:V${index}Edition`,
    agent: `ex:V${index}Agent`,
    cast: propertyCurie(index, 'cast'),
    published: propertyCurie(index, 'published'),
    count: propertyCurie(index, 'count'),
    properties: PROPERTIES.map(([key]) => propertyCurie(index, key)),
  };
}

function rangeOf(index: number, range: string): string {
  if (range === 'work') return `V${index}Work`;
  if (range === 'edition') return `V${index}Edition`;
  if (range === 'agent') return `V${index}Agent`;
  if (range === 'person') return 'Person';
  if (range === 'organization') return 'Organization';
  return range;
}

function schemaYaml(index: number): string {
  const slots = PROPERTIES.map(([key]) => slotName(index, key));
  const slotList = slots.map((name) => `      - ${name}`).join('\n');
  const classes = [
    ['Work', 'CreativeWork'],
    ['Edition', 'CreativeWork'],
    ['Agent', 'Thing'],
  ]
    .map(([suffix, parent]) => {
      const facets =
        suffix === 'Agent'
          ? `    annotations:\n      facets: ${FACETS.map((key) => slotName(index, key)).join(' ')}\n`
          : '';
      return `  V${index}${suffix}:\n    is_a: ${parent}\n    class_uri: ex:V${index}${suffix}\n    description: Fixture ${suffix.toLowerCase()} for vertical v${index}.\n${facets}    slots:\n${slotList}`;
    })
    .join('\n');
  const definitions = PROPERTIES.map(([key, datatype, range]) => {
    const name = slotName(index, key);
    const mapping = datatype === 'external-id' ? `    exact_mappings:\n      - wd:P${900000 + index}\n` : '';
    const quantity =
      datatype === 'quantity' ? `    range: integer\n    minimum_value: 0\n` : `    range: ${rangeOf(index, range)}\n`;
    const units = datatype === 'quantity' ? `      units: '1'\n` : '';
    return `  ${name}:\n    slot_uri: ex:${name}\n    description: Fixture ${key} for vertical v${index}.\n${quantity}${mapping}    annotations:\n      datatype: ${datatype}\n${units}`;
  }).join('');
  return `id: https://example.org/vocab/v${index}
name: v${index}
version: 1.0.0
description: Fixture vertical v${index}.
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
  ex: https://example.org/vocab/
default_range: string
imports:
  - linkml:types
  - core
classes:
${classes}
slots:
${definitions}`;
}

function labelsYaml(index: number, locale: string): string {
  const profile = verticalProfile(index);
  const types = [profile.work, profile.edition, profile.agent]
    .map((curie) => `  ${curie}: ${locale} ${curie}`)
    .join('\n');
  const properties = profile.properties.map((curie) => `  ${curie}: ${locale} ${curie}`).join('\n');
  return `types:\n${types}\nproperties:\n${properties}\n`;
}

/** Sources to merge into bundledSources(): one schema and eight label files per vertical. */
export function verticalManifests(count: number): VerticalSources {
  manifestIndex(count);
  const schemas: Record<string, string> = {};
  const presentation: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const profile = verticalProfile(index);
    schemas[profile.schema] = schemaYaml(index);
    for (const locale of VERTICAL_LOCALES) presentation[`${profile.name}/${locale}`] = labelsYaml(index, locale);
  }
  return { schemas, presentation };
}
