import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId } from '../../src/route/route.ts';
import type { FactRow } from '../../src/semantic/item.ts';
import { projectWorkReleaseCardFacts } from '../../src/semantic/work-release-cards.ts';

const edition = newId(0x2345);
const sourceUrl = 'https://example.org/catalog/book-edition';
const sourceParts = [{ property: 'schema:url', value: { type: 'value', content: sourceUrl } }];

function nativeFact(
  property: string,
  statementId: string | null,
  body: unknown,
  revision: number | null,
  release: string | null,
): FactRow {
  return {
    kind: 'statement',
    language: null,
    property,
    statement_id: statementId,
    operation: 'assert',
    body,
    fact_revision: revision,
    fact_release: release,
  };
}

test('projects native Book edition date, language and publisher facts with row evidence and reference hashes', () => {
  const dateId = newId(0x2345);
  const languageId = newId(0x2345);
  const publisherId = newId(0x2345);
  const publisher = newId(0x3456);
  const dateRelease = 'a'.repeat(64);
  const languageRelease = 'b'.repeat(64);
  const publisherRelease = bundledDigest;
  const projected = projectWorkReleaseCardFacts(
    edition,
    'bf:Instance',
    bundledRelease,
    'global',
    new Map([
      [
        'schema:datePublished',
        [
          nativeFact(
            'schema:datePublished',
            dateId,
            {
              rank: 'preferred',
              value: { type: 'value', content: { time: '+2024-03-00T00:00:00Z', precision: 10 } },
              qualifiers: [{ property: 'schema:inLanguage', value: { type: 'value', content: 'ja' } }],
              references: [{ parts: sourceParts }],
            },
            7,
            dateRelease,
          ),
        ],
      ],
      [
        'schema:inLanguage',
        [
          nativeFact(
            'schema:inLanguage',
            languageId,
            { rank: 'normal', value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] },
            11,
            languageRelease,
          ),
        ],
      ],
      [
        'schema:publisher',
        [
          nativeFact(
            'schema:publisher',
            publisherId,
            {
              rank: 'normal',
              value: { type: 'value', content: publisher },
              qualifiers: [{ property: 'wdt:P1932', value: { type: 'value', content: 'Imprint name' } }],
              references: [{ parts: sourceParts }],
            },
            19,
            publisherRelease,
          ),
        ],
      ],
    ]),
  );

  const date = projected.get('schema:datePublished')!;
  expect(date.unavailable).toBe(false);
  expect(date.statements[0]).toMatchObject({
    id: dateId,
    property: { id: 'schema:datePublished', data_type: 'time' },
    rank: 'preferred',
    qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
    rezics: { release: dateRelease, revision: 7 },
  });
  expect(date.statements[0]!.references[0]!.hash).toBe(
    createHash('sha256')
      .update(
        '[{"property":"schema:url","value":{"content":"https://example.org/catalog/book-edition","type":"value"}}]',
      )
      .digest('hex'),
  );

  expect(projected.get('schema:inLanguage')).toMatchObject({
    unavailable: false,
    statements: [
      { id: languageId, value: { type: 'value', content: 'ja' }, rezics: { release: languageRelease, revision: 11 } },
    ],
  });
  expect(projected.get('schema:publisher')).toMatchObject({
    unavailable: false,
    statements: [
      {
        id: publisherId,
        property: { id: 'schema:publisher', data_type: 'wikibase-item' },
        value: { type: 'value', content: publisher },
        qualifiers: [{ property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Imprint name' } }],
        rezics: { release: publisherRelease, revision: 19 },
      },
    ],
  });
});

test('does not fabricate native IDs or revision and release evidence', () => {
  const missingId = projectWorkReleaseCardFacts(
    edition,
    'bf:Instance',
    bundledRelease,
    'global',
    new Map([
      [
        'schema:inLanguage',
        [
          nativeFact(
            'schema:inLanguage',
            null,
            { rank: 'normal', value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] },
            11,
            bundledDigest,
          ),
        ],
      ],
    ]),
  );
  const missingRevision = projectWorkReleaseCardFacts(
    edition,
    'bf:Instance',
    bundledRelease,
    'global',
    new Map([
      [
        'schema:inLanguage',
        [
          nativeFact(
            'schema:inLanguage',
            newId(0x2345),
            { rank: 'normal', value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] },
            null,
            null,
          ),
        ],
      ],
    ]),
  );
  expect(missingId.get('schema:inLanguage')).toEqual({ statements: [], unavailable: true });
  expect(missingRevision.get('schema:inLanguage')).toEqual({ statements: [], unavailable: true });
});
