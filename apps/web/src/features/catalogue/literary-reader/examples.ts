import type { LiteraryWorkIdentity } from './model';

export const literaryWorkExample = {
  identity: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000911',
    title: { text: 'The harbour', lang: 'en' },
    titles: [
      { language: 'en', text: 'The harbour' },
      { language: 'ja', text: '港' },
    ],
    aliases: [{ language: 'en', text: 'Harbour stories' }],
    descriptions: [{ language: 'en', text: 'A novel about a changing port town.' }],
  } satisfies LiteraryWorkIdentity,
  locale: 'en',
  editionHref: '/en/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000911/editions',
  factsHref: '/en/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000911/details',
};

import type { Release, ReleasedRelationDirectionResult } from '@rezics/definitions';
import type { Subject, Related } from '../../../subject/types';
import type { ProfileRelationWindow } from '../../pages/views';
import type { Stmt } from '../../pages/shared';
import recorded from '../../../kernel/recorded/definitions-release.json';

export const literaryDefinitions = recorded.release as Release;
export const literaryDigest = recorded.digest;
export const literaryIds = {
  series: '0192f3a0-6c1e-7b2a-9d4e-000000000921',
  member: '0192f3a0-6c1e-7b2a-9d4e-000000000922',
  edition: '0192f3a0-6c1e-7b2a-9d4e-000000000923',
  author: '0192f3a0-6c1e-7b2a-9d4e-000000000924',
};
export function literaryStatement(property: string, target: string, position?: string): Stmt {
  return {
    id: `statement-${property}-${target}`,
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers:
      position === undefined
        ? []
        : [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://bgm.tv/subject/1' },
          },
        ],
      },
    ],
  };
}
export function literaryDirection(property: string, direction: 'forward' | 'inverse'): ReleasedRelationDirectionResult {
  return {
    state: 'admitted',
    property,
    direction,
    inverse: literaryDefinitions.properties[property]?.relation?.inverse ?? null,
    sourceTypes: [],
    targetTypes: [],
    release: literaryDigest,
    qualifiers: [],
  };
}
export function literaryGrainExample(type: 'schema:Book' | 'schema:BookSeries' | 'bf:Instance' = 'schema:BookSeries') {
  const id =
    type === 'schema:BookSeries'
      ? literaryIds.series
      : type === 'bf:Instance'
        ? literaryIds.edition
        : literaryIds.member;
  const membership = literaryStatement('wdt:P179', literaryIds.series, '上巻・02a');
  const canonical = literaryStatement('schema:exampleOfWork', literaryIds.member);
  const author = literaryStatement('schema:author', literaryIds.author);
  const subject = {
    id,
    type,
    labels: { en: 'Harbour stories', ja: '港の物語', 'zh-Hant': '海港的故事' },
    aliases: {},
    descriptions: {},
    context: '00000000-0000-8000-8000-000000000000',
    release: literaryDigest,
    revision: 1,
    resolution: {},
    relationCounts: {},
    statements:
      type === 'bf:Instance'
        ? { 'schema:exampleOfWork': [canonical] }
        : type === 'schema:Book'
          ? { 'wdt:P179': [membership], 'schema:author': [author] }
          : {
              'wdt:P2635': [
                {
                  ...author,
                  id: 'stated-count',
                  property: { id: 'wdt:P2635', data_type: 'quantity' },
                  value: {
                    type: 'value',
                    content: { amount: '+999', unit: 'http://www.wikidata.org/entity/Q1238720' },
                  },
                },
              ],
            },
  } as unknown as Subject;
  const related = {
    [literaryIds.series]: { id: literaryIds.series, type: 'schema:BookSeries', labels: { en: 'Harbour series' } },
    [literaryIds.member]: { id: literaryIds.member, type: 'schema:Book', labels: { en: 'Harbour work' } },
    [literaryIds.author]: { id: literaryIds.author, type: 'schema:Person', labels: { en: 'Supplied author' } },
  } as unknown as Related;
  const memberRow = {
    subject: literaryIds.member,
    property: 'wdt:P179',
    statement: membership.id,
    assertion: membership,
    label: 'Harbour work',
    type: 'schema:Book',
    related: {},
    summary: { id: literaryIds.member, type: 'schema:Book', label: { value: 'Harbour work', language: 'ja' } },
  };
  const editionStatement = literaryStatement('schema:exampleOfWork', literaryIds.member);
  const editionRow = {
    subject: literaryIds.edition,
    property: 'schema:exampleOfWork',
    statement: editionStatement.id,
    assertion: editionStatement,
    related: {},
    summary: { id: literaryIds.edition, type: 'bf:Instance', label: { value: 'Harbour, 2nd edition', language: 'en' } },
  };
  const window: ProfileRelationWindow = {
    node: 'members',
    property: 'wdt:P179',
    direction: 'inverse',
    rows: [memberRow],
    limit: 12,
    status: 200,
    valid: true,
    complete: false,
    next: 'native/opaque?cursor=next',
    caughtUp: true,
  };
  const windows: ProfileRelationWindow[] =
    type === 'schema:BookSeries'
      ? [window]
      : type === 'schema:Book'
        ? [{ ...window, node: 'editions', property: 'schema:exampleOfWork', rows: [editionRow] }]
        : [];
  return {
    work: subject,
    related,
    source: {},
    locale: 'en',
    context: { id: subject.context, population: { kind: 'global' } },
    definitions: literaryDefinitions,
    descriptorState: 'released' as const,
    digest: literaryDigest,
    windows,
    view: 'contents',
    directions: [
      literaryDirection('wdt:P179', 'inverse'),
      literaryDirection('wdt:P179', 'forward'),
      literaryDirection('schema:author', 'forward'),
      literaryDirection('schema:exampleOfWork', 'forward'),
      literaryDirection('schema:exampleOfWork', 'inverse'),
    ],
  };
}
