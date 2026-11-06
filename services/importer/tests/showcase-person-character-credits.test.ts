import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { ReviewedPersonRead } from '@rezics/client';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { MediaVariantDecision, ReviewedSubjectRead } from '../src/import-client.ts';
import { ImportTransportError } from '../src/import-client.ts';
import { PublicSubjectGetUnavailable, ReviewedSubjectNotReady } from '../src/public-bulk-client.ts';
import { bangumiVoiceDraft, deliverBangumiCreatorCredits } from '../src/bangumi-creator-credits.ts';
import {
  characterIdentityForSource,
  importProducerPhase,
  observeCharacterIdentity,
  observePersonIdentity,
  personIdentityForSource,
  publishReviewedPersonMerge,
  readAdoptedCharacter,
  recordCombinedPersonCredits,
  rereadCanonicalPersonIdentities,
  type BoundPersonIdentity,
  type PersonReviewSource,
  type ReviewedPersonMergeTransport,
} from '../src/showcase-person-identity.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';

const bangumiOriginal = '00000000-0000-4000-8000-00000000000a';
const vndbOriginal = '00000000-0000-4000-8000-00000000000b';
const survivor = bangumiOriginal;
const operation = '00000000-0000-4000-8000-0000000000c1';
const claim = '00000000-0000-4000-8000-0000000000d1';
const angelBeats = '00000000-0000-4000-8000-000000001851';
const clannad = '00000000-0000-4000-8000-00000000000v4';
const yui = '00000000-0000-4000-8000-0000000000c3';
const media = '00000000-0000-4000-8000-0000000000e1';

const bangumi = personIdentityForSource('bangumi', 'person:1916', 'schema:Person')!;
const vndb = personIdentityForSource('vndb', 's224', 'schema:Person')!;

function source(identity: typeof bangumi, boundSubjectId: string, sourceAlias: string): PersonReviewSource {
  return {
    identity,
    boundSubjectId,
    sourceAlias,
    record: { source: identity.source, key: identity.externalId, revision: 'fixture', payload: {} } as SourceRecord,
    digest: 'a'.repeat(64),
    converterRevision: 'fixture-1',
  };
}

const pair = [
  source(bangumi, bangumiOriginal, 'bangumi_cross_media'),
  source(vndb, vndbOriginal, 'vndb_cross_media'),
] as const;

function publicPerson(id: string): ReviewedSubjectRead {
  return {
    subject: {
      id,
      type: 'schema:Person',
      statements: {
        'wdt:P6298': [{ rank: 'normal', value: { type: 'value', content: '1916' } }],
        'wdt:P3180': [{ rank: 'normal', value: { type: 'value', content: 's224' } }],
      },
    },
  } as unknown as ReviewedSubjectRead;
}

function characterRead(): ReviewedSubjectRead {
  return {
    subject: {
      id: yui,
      type: 'wd:Q95074',
      statements: {
        'wdt:P6296': [{ rank: 'normal', value: { type: 'value', content: '116' } }],
        'schema:name': [{ rank: 'normal', value: { type: 'value', content: 'ユイ' } }],
        'schema:alternateName': [{ rank: 'normal', value: { type: 'value', content: 'Yui' } }],
        'schema:gender': [{ rank: 'normal', value: { type: 'value', content: 'female' } }],
        'schema:height': [{ rank: 'normal', value: { type: 'value', content: { amount: '+155', unit: 'Q174728' } } }],
        'schema:url': [{ rank: 'normal', value: { type: 'value', content: 'https://bgm.tv/character/116' } }],
      },
    },
    summary: {
      cover: {
        media,
        credit: { holder: 'Key', via: 'https://bgm.tv/character/116' },
        variants: [
          { format: 'avif', width: 240 },
          { format: 'webp', width: 240 },
        ],
      },
    },
  } as unknown as ReviewedSubjectRead;
}

function workCredits(id: string, person: string, property: string, cited: string): ReviewedSubjectRead {
  return {
    subject: {
      id,
      type: id === angelBeats ? 'schema:TVSeries' : 'wd:Q689445',
      statements: {
        [property]: [
          {
            rank: 'normal',
            value: { type: 'value', content: person },
            qualifiers: [{ property: { id: 'wdt:P1932' }, value: { type: 'value', content: '麻枝准' } }],
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: cited } }] }],
          },
        ],
      },
    },
    related: person === survivor ? {} : { [person]: { redirect: survivor } },
  } as unknown as ReviewedSubjectRead;
}

test('Publish reviewed Person identities with Character and credit reads through separate proposal, authorized adoption and independent current reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-character-credits-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  try {
    const merges: { body: unknown; key: string }[] = [];
    const native: ReviewedPersonMergeTransport = {
      async readReviewedPersonIdentity(id) {
        const identity = id === bangumiOriginal ? bangumi : vndb;
        const alias = id === bangumiOriginal ? 'bangumi_cross_media' : 'vndb_cross_media';
        return {
          subject: { id },
          reviewedIdentity: {
            subject: id,
            revision: 3,
            securityRevision: '7',
            source: alias,
            externalId: identity.externalId,
            claimTransactionId: claim,
            property: identity.property,
            value: identity.value,
          },
        } as unknown as ReviewedPersonRead;
      },
      async mergeReviewedPersons(body, key) {
        merges.push({ body: structuredClone(body), key });
        return { operation: { id: operation } };
      },
      async readReviewedPersonOperation(id) {
        return { id, done: true, result: { survivor, redirected: vndbOriginal, revision: 4 } };
      },
    };
    const published = await publishReviewedPersonMerge({
      pair,
      transport: native,
      readPublic: async () => publicPerson(survivor),
      journal,
      pause: async () => {},
    });
    expect(published).toMatchObject({ state: 'published', survivor, operation });
    expect(merges).toHaveLength(1);
    expect(merges[0]!.body).toMatchObject({
      subjects: [bangumiOriginal, vndbOriginal],
      expectedIdentity: {
        endpoints: [{ value: '1916' }, { value: 's224' }],
      },
    });

    const identities: BoundPersonIdentity[] = [
      { state: 'current', currentSubjectId: bangumiOriginal, boundSubjectId: bangumiOriginal, identity: bangumi },
      { state: 'current', currentSubjectId: vndbOriginal, boundSubjectId: vndbOriginal, identity: vndb },
    ];
    const afterMerge = await rereadCanonicalPersonIdentities({
      identities,
      readPublic: async () => publicPerson(survivor),
    });
    expect(afterMerge.canonicalPersons).toEqual({ 'person:1916': survivor, s224: survivor });
    expect(new Set(afterMerge.identities.map((entry) => entry.currentSubjectId))).toEqual(new Set([survivor]));
    expect(afterMerge.identities.map((entry) => entry.boundSubjectId)).toEqual([bangumiOriginal, vndbOriginal]);

    const bound = {
      '1851': angelBeats,
      'person:1916': bangumiOriginal,
      'character:116': yui,
    };
    const commands: Extract<BatchCommand, { op: 'propose' }>[] = [];
    const credits = await deliverBangumiCreatorCredits({
      alias: 'bangumi_cross_media',
      drafts: [bangumiVoiceDraft({ subject_id: 1851, person_id: 1916, character_id: 116 }, 2)],
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      claim: ({ external_id }) => ({ state: 'bound', subject: bound[external_id as keyof typeof bound]! }),
      async batch(request) {
        for (const command of request.commands) if (command.op === 'propose') commands.push(command);
        return {
          results: request.commands.map((command) => ({
            key: command.key,
            status: 201 as const,
            value: { candidate: survivor, revision: 1 },
          })),
        };
      },
      async fence() {
        return { fenced: false };
      },
      async read(id) {
        if (id === yui) return characterRead();
        if (id === bangumiOriginal || id === vndbOriginal) return publicPerson(survivor);
        return {
          subject: {
            id: angelBeats,
            type: 'schema:TVSeries',
            statements: { 'wdt:P5732': [{ value: { type: 'value', content: '1851' } }] },
          },
        } as unknown as ReviewedSubjectRead;
      },
      expectedNativeType(externalId) {
        return externalId === '1851'
          ? 'schema:TVSeries'
          : externalId.startsWith('person:')
            ? 'schema:Person'
            : 'wd:Q95074';
      },
      metadataFor() {
        return {
          digest: 'c'.repeat(64),
          recordRevision: 'angel-beats',
          recordUrl: 'https://bgm.tv/subject/1851',
        };
      },
    });
    expect(credits.gaps).toEqual([]);
    expect(credits.identities['person:1916']).toMatchObject({ id: bangumiOriginal, type: 'schema:Person' });
    expect(credits.canonicalPersons['person:1916']).toBe(survivor);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.source.external_id).toBe('1851');
    expect(commands[0]!.statement.value).toEqual({ type: 'value', content: bangumiOriginal });

    const character = observePersonIdentity(
      { source: 'bangumi', externalId: 'person:1916', property: 'wdt:P6298', value: '1916' },
      characterRead(),
    );
    expect(character.state).toBe('wrong_type');
    const characterIdentity = characterIdentityForSource('bangumi', 'character:116', 'wd:Q95074')!;
    expect(observeCharacterIdentity(characterIdentity, characterRead())).toMatchObject({
      state: 'current',
      currentSubjectId: yui,
    });
    const adopted = await readAdoptedCharacter({
      identity: characterIdentity,
      boundSubjectId: yui,
      readPublic: async () => characterRead(),
      appearances: [angelBeats],
      performers: [survivor],
      authorizeMediaVariant: async (mediaId, variant) =>
        ({
          allowed: true,
          key: variant,
          sha256: 'a'.repeat(64),
          mediaType: variant.startsWith('avif') ? 'image/avif' : 'image/webp',
          byteCount: 2048,
          publicCache: false,
          cacheControl: 'private, no-cache',
        }) as MediaVariantDecision,
    });
    expect(adopted).toMatchObject({
      state: 'current',
      names: ['ユイ', 'Yui'],
      traits: ['female'],
      measurements: ['+155'],
      sourceLinks: ['https://bgm.tv/character/116'],
      appearances: [angelBeats],
      performers: [survivor],
      image: { state: 'served', mediaId: media },
    });

    const combined = recordCombinedPersonCredits({
      canonicalPersonId: survivor,
      originals: [
        { boundPersonId: bangumiOriginal, personExternalId: 'person:1916' },
        { boundPersonId: vndbOriginal, personExternalId: 's224' },
      ],
      works: [
        {
          externalId: '1851',
          read: workCredits(angelBeats, bangumiOriginal, 'wdt:P725', 'https://bgm.tv/subject/1851'),
        },
        { externalId: 'v4', read: workCredits(clannad, vndbOriginal, 'schema:author', 'https://vndb.org/v4') },
      ],
    });
    expect(combined.credits).toHaveLength(2);
    expect(combined.credits.map((credit) => credit.workExternalId).sort()).toEqual(['1851', 'v4']);
    expect(new Set(combined.credits.map((credit) => credit.canonicalPersonId))).toEqual(new Set([survivor]));
    expect(combined.credits.every((credit) => credit.citations.length === 1)).toBe(true);

    expect(importProducerPhase(new ReviewedSubjectNotReady(yui))).toBe('readiness');
    expect(importProducerPhase(new PublicSubjectGetUnavailable(yui))).toBe('SubjectGET503');
    expect(importProducerPhase(new ImportTransportError(403, undefined, undefined, false, undefined, 'merge403'))).toBe(
      'merge403',
    );

    const redirected: ReviewedPersonMergeTransport = {
      ...native,
      readReviewedPersonIdentity: async (id) =>
        ({ subject: { id }, reviewedIdentity: null }) as unknown as ReviewedPersonRead,
    };
    expect(
      await publishReviewedPersonMerge({
        pair,
        transport: redirected,
        readPublic: async () => publicPerson(survivor),
        journal,
        pause: async () => {},
      }),
    ).toMatchObject({ state: 'published', operation, survivor });
    expect(merges).toHaveLength(1);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
