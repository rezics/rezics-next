import type { WorkReleaseCard } from '@rezics/client';
import { gameExample, type GameExample } from './examples';
import type { GameStatement } from './model';

export type ComparisonExample = 'partial' | 'tba' | 'withheld' | 'advice-unavailable' | 'sparse' | 'retirement';

const publisherId = '00000000-0000-4000-8000-00000000c401';
const producerId = '00000000-0000-4000-8000-00000000c402';
const developerId = '00000000-0000-4000-8000-00000000c403';
const statusId = '00000000-0000-4000-8000-00000000c404';
const creatorId = '00000000-0000-4000-8000-00000000c409';

function summary(id: string, type: string, label: string, locale: string): WorkReleaseCard['summary'] {
  return {
    id,
    type,
    label: { language: locale, value: label },
    types: [type],
    creativeWork: false,
    cover: null,
  } as WorkReleaseCard['summary'];
}

function statement(
  n: number,
  property: string,
  data_type: GameStatement['property']['data_type'],
  content: unknown,
): GameStatement {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    property: { id: property, data_type },
    value:
      typeof content === 'object' && content !== null && 'type' in content
        ? (content as GameStatement['value'])
        : { type: 'value', content },
    rank: 'normal',
    qualifiers: [],
    references: [],
    rezics: { release: `sha256:${'1'.repeat(64)}`, revision: 1 },
  };
}

function available(statement: GameStatement, related: WorkReleaseCard['related'] = {}) {
  return { state: 'available' as const, statements: [statement], related };
}

/** Public response examples for comparison, withheld targets, partial/TBA dates, sparse pages and retirement. */
export function workReleaseComparisonExample(scenario: ComparisonExample = 'partial', locale = 'en') {
  const base: GameExample = scenario === 'tba' ? 'tba' : scenario === 'sparse' ? 'empty' : 'work';
  const fixture = gameExample(base, locale);
  if (scenario === 'sparse') {
    fixture.respond({ ...fixture.first, links: [], workReleaseCards: { state: 'available', cards: [] } });
    return fixture;
  }
  const row = fixture.first.links[0];
  if (!row?.summary || !row.assertion) throw new Error('Comparison example requires one disclosed release membership');
  const platformId = Object.entries(fixture.publicRead.related).find(([, value]) => value.type === 'skos:Concept')?.[0];
  if (!platformId) throw new Error('Comparison example requires a disclosed platform concept');
  const platform = summary(platformId, 'skos:Concept', 'Windows', locale);
  const publisher = summary(publisherId, 'schema:Organization', 'Harbour Digital', locale);
  const producer = summary(producerId, 'schema:Organization', 'Harbour Release Producer', locale);
  const developer = summary(developerId, 'schema:Organization', 'Harbour Development', locale);
  const status = summary(statusId, 'skos:Concept', 'Early access', locale);
  fixture.publicRead.related[creatorId] = { type: 'schema:Person', labels: { [locale]: 'Original VN creator' } };
  fixture.publicRead.subject.statements['schema:author'] = [
    statement(409, 'schema:author', 'wikibase-item', creatorId),
  ];
  const date = fixture.publicRead.subject.statements['schema:datePublished']?.[0];
  if (!date) throw new Error('Comparison example requires the shared date fixture');
  const dateStatement = {
    ...date,
    id: '00000000-0000-4000-8000-00000000c410',
    rezics: { release: fixture.release.digest, revision: 1 },
  };
  const fields: WorkReleaseCard['fields'] = {
    'schema:gamePlatform': available(statement(401, 'schema:gamePlatform', 'wikibase-item', platformId), {
      [platformId]: platform,
    }),
    'schema:inLanguage': available(statement(402, 'schema:inLanguage', 'string', 'ja')),
    'schema:datePublished': available(dateStatement),
    'schema:creativeWorkStatus': available(statement(403, 'schema:creativeWorkStatus', 'wikibase-item', statusId), {
      [statusId]: status,
    }),
    'wdt:P5804': { state: 'unsupported' },
    'rezics:releaseStatus': { state: 'missing' },
    'schema:contentRating': { state: 'unsupported' },
    'schema:publisher': available(statement(405, 'schema:publisher', 'wikibase-item', publisherId), {
      [publisherId]: publisher,
    }),
    'schema:producer': available(statement(406, 'schema:producer', 'wikibase-item', producerId), {
      [producerId]: producer,
    }),
    'wdt:P178': available(statement(407, 'wdt:P178', 'wikibase-item', developerId), { [developerId]: developer }),
    'wdt:P162': { state: 'unsupported' },
    'wdt:P2899':
      scenario === 'withheld'
        ? { state: 'withheld' }
        : available(
            statement(408, 'wdt:P2899', 'quantity', { amount: '+17', unit: 'http://www.wikidata.org/entity/Q577' }),
          ),
  };
  const card: WorkReleaseCard = {
    subject: row.subject,
    type: row.summary.type,
    summary: row.summary as WorkReleaseCard['summary'],
    membership: row.assertion,
    related: {
      ...row.related,
      [platformId]: platform,
      [publisherId]: publisher,
      [producerId]: producer,
      [developerId]: developer,
      [statusId]: status,
    },
    fields,
  };
  fixture.publicRead.viewerActions =
    scenario === 'advice-unavailable'
      ? { state: 'unavailable' }
      : {
          state: 'available',
          actions: [{ action: 'statement:propose', operations: ['subject.propose', 'subject.terms'] }],
        };
  fixture.respond({ ...fixture.first, workReleaseCards: { state: 'available', cards: [card] } });
  return fixture;
}
