import { expect } from 'bun:test';
import { createSearchGenerationPublication } from '../../../src/search/generation-publication.ts';
import { createOpenSearch } from '../../../src/search/opensearch.ts';
import { unavailableSearchWriterPublication } from '../../../src/search/writer-guard.ts';
import { createSubjectSourceKeyPages } from '../../../src/semantic/subject-source-key-pages.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../../src/semantic/public-filter-source-binding.ts';
import type { PublicFilterConsumer, PublicFilterSource } from '../../../src/semantic/public-filter-source-contract.ts';
import { readContext, type Fixture } from './public-filter-source.ts';

/** Retain an actual generation job through its owner; no Source/engine receipt is manufactured. */
export async function publicationJob(f: Fixture, source: PublicFilterSource, consumer: PublicFilterConsumer) {
  const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
  const publication = createSearchGenerationPublication({
    pool: f.db.pool,
    search: createOpenSearch(process.env.OPENSEARCH_URL!),
    source,
    sourceKeys: createSubjectSourceKeyPages(f.db.pool, f.config.routeKey, f.config.access),
    binding,
    readPublicationCompletion: (request, context) =>
      readNativePublicFilterPublicationCompletion(binding, request, context),
    clock: f.config.clock,
    meaning: f.meaning,
    writerGuard: {
      ...unavailableSearchWriterPublication,
      async write() {
        throw new Error('Source completion must not dispatch generation writes');
      },
    },
  });
  try {
    const prepared = await publication.prepare(consumer, readContext());
    expect(prepared.status).toBe('preparing');
    if (prepared.status !== 'preparing') throw new Error(`Native publication ${prepared.reason}`);
    return prepared.job.job;
  } finally {
    await publication.close();
  }
}
