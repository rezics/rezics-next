import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { ReviewedPersonRead } from '@rezics/client';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  personIdentityForSource,
  publishReviewedPersonMerge,
  rereadCanonicalPersonIdentities,
  type BoundPersonIdentity,
  type PersonReviewSource,
  type ReviewedPersonMergeTransport,
} from '../src/showcase-person-identity.ts';
import { ShowcaseJournal } from '../src/showcase-publication.ts';
import { createPublicBulkClient, ReviewedSubjectNotReady } from '../src/public-bulk-client.ts';

const bangumiOriginal = '00000000-0000-4000-8000-00000000000a';
const vndbOriginal = '00000000-0000-4000-8000-00000000000b';
const survivor = bangumiOriginal;
const operation = '00000000-0000-4000-8000-0000000000c1';
const claim = '00000000-0000-4000-8000-0000000000d1';

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

function endpoint(subject: string, identity: typeof bangumi, sourceAlias: string) {
  return {
    subject,
    revision: 3,
    securityRevision: '7',
    source: sourceAlias,
    externalId: identity.externalId,
    claimTransactionId: claim,
    property: identity.property,
    value: identity.value,
  };
}

function reviewed(subject: string, identity: typeof bangumi, sourceAlias: string): ReviewedPersonRead {
  return {
    subject: { id: subject },
    reviewedIdentity: endpoint(subject, identity, sourceAlias),
  } as unknown as ReviewedPersonRead;
}

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

type Calls = { merges: { body: unknown; key: string }[]; polls: number };

/** Native double: admission returns an operation; completion becomes visible after `doneAfter` observations. */
function transport(options: { doneAfter?: number; mergeError?: unknown; withholdVndb?: boolean } = {}) {
  const calls: Calls = { merges: [], polls: 0 };
  const native: ReviewedPersonMergeTransport = {
    async readReviewedPersonIdentity(id) {
      if (options.withholdVndb && id === vndbOriginal)
        return { subject: { id }, reviewedIdentity: null } as unknown as ReviewedPersonRead;
      return id === bangumiOriginal
        ? reviewed(id, bangumi, 'bangumi_cross_media')
        : reviewed(id, vndb, 'vndb_cross_media');
    },
    async mergeReviewedPersons(body, key) {
      calls.merges.push({ body: structuredClone(body), key });
      if (options.mergeError !== undefined) throw options.mergeError;
      return { operation: { id: operation } };
    },
    async readReviewedPersonOperation(id) {
      calls.polls += 1;
      return calls.polls >= (options.doneAfter ?? 1)
        ? { id, done: true, result: { survivor, redirected: vndbOriginal, revision: 4 } }
        : { id, done: false };
    },
  };
  return { calls, native };
}

test('a reviewed pair merges once, observes the native job and reads both identifiers on the survivor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-merge-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  try {
    const { calls, native } = transport({ doneAfter: 2 });
    const publish = () =>
      publishReviewedPersonMerge({
        pair,
        transport: native,
        readPublic: async (id) => publicPerson(survivor),
        journal,
        pause: async () => {},
      });
    const published = await publish();
    expect(published).toEqual({
      state: 'published',
      operation,
      survivor,
      redirected: vndbOriginal,
      revision: 4,
      identities: [
        { boundSubjectId: bangumiOriginal, identity: bangumi, currentSubjectId: survivor },
        { boundSubjectId: vndbOriginal, identity: vndb, currentSubjectId: survivor },
      ],
    });
    expect(calls.merges).toHaveLength(1);
    expect(calls.merges[0]!.body).toMatchObject({
      subjects: [bangumiOriginal, vndbOriginal],
      expectedIdentity: {
        endpoints: [
          endpoint(bangumiOriginal, bangumi, 'bangumi_cross_media'),
          endpoint(vndbOriginal, vndb, 'vndb_cross_media'),
        ],
      },
    });
    // After the merge the originals redirect and expose no reviewed identity; reopening resumes from the journal.
    const redirected = {
      ...native,
      readReviewedPersonIdentity: async (id: string) =>
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
    expect(calls.merges).toHaveLength(1);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('unknown delivery replays the exact sealed body and key, while a definite refusal stays terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-merge-replay-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  const refusedJournal = new ShowcaseJournal(join(directory, 'refused.sqlite'));
  try {
    const lost = transport({ mergeError: new Error('connection reset') });
    const run = (native: ReviewedPersonMergeTransport, db: ShowcaseJournal) =>
      publishReviewedPersonMerge({
        pair,
        transport: native,
        readPublic: async () => publicPerson(survivor),
        journal: db,
        pause: async () => {},
      });
    await expect(run(lost.native, journal)).rejects.toThrow('connection reset');
    const replayed = transport();
    expect(await run(replayed.native, journal)).toMatchObject({ state: 'published', operation });
    expect(replayed.calls.merges).toHaveLength(1);
    expect(replayed.calls.merges[0]).toEqual(lost.calls.merges[0]);

    const refused = transport({ mergeError: Object.assign(new Error('refused'), { status: 403 }) });
    expect(await run(refused.native, refusedJournal)).toEqual({
      state: 'withheld',
      reason: 'Native merge refused with HTTP 403',
    });
    const again = transport();
    expect(await run(again.native, refusedJournal)).toEqual({
      state: 'withheld',
      reason: 'review-http-403',
    });
    expect(again.calls.merges).toHaveLength(0);
  } finally {
    journal.close();
    refusedJournal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('a pending native job resumes from its admitted operation, and disagreeing reads are never published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-merge-pending-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  try {
    const first = transport({ doneAfter: 3 });
    const bounded = {
      pair,
      transport: first.native,
      readPublic: async () => publicPerson(survivor),
      journal,
      pause: async () => {},
    };
    expect(await publishReviewedPersonMerge({ ...bounded, polls: 2 })).toEqual({ state: 'pending', operation });
    const resumed = transport({ doneAfter: 1 });
    expect(await publishReviewedPersonMerge({ ...bounded, transport: resumed.native, polls: 5 })).toMatchObject({
      state: 'published',
      operation,
    });
    expect(first.calls.merges).toHaveLength(1);
    expect(resumed.calls.merges).toHaveLength(0);

    const other = await publishReviewedPersonMerge({
      ...bounded,
      readPublic: async (id) => (id === vndbOriginal ? publicPerson(vndbOriginal) : publicPerson(survivor)),
    });
    expect(other).toEqual({ state: 'unconfirmed', operation });

    const complementary = await publishReviewedPersonMerge({
      ...bounded,
      readPublic: async (id) =>
        ({
          subject: {
            id: survivor,
            type: 'schema:Person',
            statements:
              id === bangumiOriginal
                ? { 'wdt:P6298': [{ rank: 'normal', value: { type: 'value', content: '1916' } }] }
                : { 'wdt:P3180': [{ rank: 'normal', value: { type: 'value', content: 's224' } }] },
          },
        }) as unknown as ReviewedSubjectRead,
    });
    expect(complementary).toEqual({ state: 'unconfirmed', operation });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('an original without a coherent reviewed identity withholds the merge before any effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-merge-withheld-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  try {
    const { calls, native } = transport({ withholdVndb: true });
    expect(
      await publishReviewedPersonMerge({
        pair,
        transport: native,
        readPublic: async () => publicPerson(survivor),
        journal,
        pause: async () => {},
      }),
    ).toEqual({ state: 'withheld', reason: 's224 has no coherent reviewed identity' });
    expect(calls.merges).toHaveLength(0);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('a not-yet-current Subject read is observed again, while any other read failure stays terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'person-merge-readiness-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  try {
    const { native } = transport();
    let reads = 0;
    const published = await publishReviewedPersonMerge({
      pair,
      transport: native,
      readPublic: async (id) => {
        reads += 1;
        if (reads <= 2) throw new ReviewedSubjectNotReady(id);
        return publicPerson(survivor);
      },
      journal,
      pause: async () => {},
    });
    expect(published).toMatchObject({ state: 'published', survivor });
    expect(reads).toBe(4);
    const reader = (type: string) =>
      createPublicBulkClient({
        origin: 'https://api.rezics.test',
        fetch: (async (_input: RequestInfo | URL) => Response.json({ type }, { status: 503 })) as typeof fetch,
      });
    await expect(
      reader('https://rezics.com/problems/semantic_not_ready').readSubject(bangumiOriginal),
    ).rejects.toBeInstanceOf(ReviewedSubjectNotReady);
    await expect(reader('https://rezics.com/problems/overloaded').readSubject(bangumiOriginal)).rejects.toThrow(
      'returned 503',
    );
    await expect(
      publishReviewedPersonMerge({
        pair,
        transport: native,
        readPublic: async () => {
          throw new Error('gateway unavailable');
        },
        journal,
        pause: async () => {},
      }),
    ).rejects.toThrow('gateway unavailable');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test('after merge, reread maps each original binding onto the survivor and skips only semantic_not_ready', async () => {
  const identities: BoundPersonIdentity[] = [
    { state: 'current', currentSubjectId: bangumiOriginal, boundSubjectId: bangumiOriginal, identity: bangumi },
    { state: 'current', currentSubjectId: vndbOriginal, boundSubjectId: vndbOriginal, identity: vndb },
  ];
  expect(
    await rereadCanonicalPersonIdentities({
      identities,
      readPublic: async () => publicPerson(survivor),
    }),
  ).toEqual({
    identities: [
      { state: 'current', currentSubjectId: survivor, boundSubjectId: bangumiOriginal, identity: bangumi },
      { state: 'current', currentSubjectId: survivor, boundSubjectId: vndbOriginal, identity: vndb },
    ],
    canonicalPersons: { 'person:1916': survivor, s224: survivor },
    unconfirmed: [],
  });
  const lagging = await rereadCanonicalPersonIdentities({
    identities,
    readPublic: async (id) => {
      if (id === vndbOriginal) throw new ReviewedSubjectNotReady(id);
      return publicPerson(survivor);
    },
  });
  expect(lagging.canonicalPersons).toEqual({ 'person:1916': survivor });
  expect(lagging.unconfirmed).toEqual(identities.slice(1));
  await expect(
    rereadCanonicalPersonIdentities({
      identities,
      readPublic: async () => {
        throw new Error('gateway unavailable');
      },
    }),
  ).rejects.toThrow('gateway unavailable');
});
