import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { subjectAlias, subjectIndexDefinition, subjectIndexName } from '../../src/search/indices.ts';
import { OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import { emptyScopePublicCost } from '../../src/search/scope-ordered.ts';
import { unavailableSearchWriterPublication } from '../../src/search/writer-guard.ts';

const prefix = 'publication-replay-';
const alias = subjectAlias(prefix);
const index = subjectIndexName(prefix, 2);
const meaning = { digest: releaseDigest(bundledRelease), release: bundledRelease };
const reference = {
  job: crypto.randomUUID(),
  consumer: {
    physicalTarget: index,
    incarnation: 'original-allocation',
    consumerGeneration: 'generation-2',
    projectionGeneration: 'projection-2',
    meaningDigest: meaning.digest,
    readDefinition: 'native-publication',
  },
};
const fence = crypto.randomUUID();
const unexpected = () => {
  throw new TypeError('Unexpected publication operation');
};

function fixture(active: number[], lostSave = false, incarnation = reference.consumer.incarnation) {
  const targets = active.map((generation) => subjectIndexName(prefix, generation));
  const job = {
    ...reference,
    physical_target: index,
    family: 'subjects',
    prefix,
    generation: '2',
    phase: 'active',
    fenced_pass: true,
    fence: fence as string | null,
    revision: '1',
  };
  const released: unknown[] = [];
  const pool = {
    async connect() {
      return {
        async query({ text, values }: { text: string; values: unknown[] }) {
          if (text.includes('pg_try_advisory_lock')) {
            expect(values).toEqual([alias]);
            return { rows: [{ locked: true }] };
          }
          if (text.includes('pg_advisory_unlock')) {
            expect(values).toEqual([alias]);
            return { rows: [{ unlocked: true }] };
          }
          if (text.startsWith('SELECT * FROM search.generation_publication')) {
            expect(values).toEqual([reference.job]);
            return { rows: [{ ...job }] };
          }
          expect(text).toStartWith('UPDATE search.generation_publication');
          expect(values.slice(0, 3)).toEqual([job.job, job.revision, 'active']);
          expect(values.slice(8, 10)).toEqual([null, true]);
          if (lostSave) {
            lostSave = false;
            return { rows: [] };
          }
          job.fence = null;
          job.revision = '2';
          return { rows: [{ revision: job.revision }] };
        },
        release(error?: Error) {
          expect(error).toBeUndefined();
        },
      };
    },
  } as unknown as Pool;
  const search: OpenSearch = {
    async request<T>(method: string, path: string) {
      expect(method).toBe('GET');
      const entries = Object.fromEntries(targets.map((target) => [target, { aliases: { [alias]: {} } }]));
      if (path === `/_alias/${alias}` && targets.length === 0) throw new OpenSearchError(404, {});
      const responses: Record<string, unknown> = {
        [`/${index}/_settings`]: { [index]: { settings: { index: { uuid: incarnation } } } },
        [`/${index}/_mapping`]: { [index]: subjectIndexDefinition() },
        [`/_resolve/index/${alias}*`]: {
          indices: [...new Set([index, ...targets])].map((name) => ({
            name,
            attributes: ['open'],
            aliases: targets.length === 1 && targets[0] === name ? [alias] : [],
          })),
          aliases: targets.length === 1 ? [{ name: alias, indices: targets }] : [],
          data_streams: [],
        },
        [`/_alias/${alias}`]: entries,
      };
      expect(Object.hasOwn(responses, path)).toBe(true);
      return { status: 200, body: responses[path] as T };
    },
    bulk: unexpected,
  };
  const publication = createSearchGenerationPublication({
    pool,
    search,
    meaning,
    clock: () => new Date(),
    source: {
      readPublicFilterProjectionPage: unexpected,
      readPrivacyReductionHeads: unexpected,
      readPrivacyReductionPage: unexpected,
    },
    sourceKeys: { read: unexpected },
    binding: { resolve: unexpected, join: unexpected },
    readPublicationCompletion: unexpected,
    writerGuard: {
      ...unavailableSearchWriterPublication,
      write: unexpected,
      async releasePublication(value) {
        released.push(value);
        return { status: 'released', cost: emptyScopePublicCost() };
      },
    },
  });
  return { run: () => publication.activate(reference, { deadline: Date.now() + 1000 }), job, released };
}

test('a superseded Subject publication releases its exact fence after a lost checkpoint', async () => {
  const f = fixture([10], true);
  expect(await f.run()).toMatchObject({ status: 'unready', reason: 'observation_lost' });
  expect(f.job.fence).toBe(fence);
  expect(await f.run()).toMatchObject({ status: 'superseded', consumer: reference.consumer });
  expect(f.job.fence).toBeNull();
  expect(await f.run()).toMatchObject({ status: 'superseded' });
  expect(f.released).toEqual([
    { ...reference, fence },
    { ...reference, fence },
  ]);
});

test('Subject publication replay keeps its fence when supersession or the original allocation is unproven', async () => {
  for (const active of [[], [1], [2, 10]]) {
    const f = fixture(active);
    expect(await f.run()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(f.job.fence).toBe(fence);
    expect(f.released).toEqual([]);
  }
  const f = fixture([10], false, 'replacement-allocation');
  expect(await f.run()).toMatchObject({ status: 'unready', reason: 'incarnation_changed' });
  expect(f.released).toEqual([]);
});

test('an unfinished Subject cannot displace a newer generation or release uncertain intent', async () => {
  const f = fixture([10]);
  f.job.phase = 'intent';
  expect(await f.run()).toMatchObject({ status: 'unready', reason: 'source_pending' });
  expect(f.job.fence).toBe(fence);
  expect(f.released).toEqual([]);
});
