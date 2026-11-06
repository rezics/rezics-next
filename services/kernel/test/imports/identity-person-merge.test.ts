import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossMediaAliases, emptyCrossMediaPlan, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { publishReviewedPersonMerge } from '../../../importer/src/showcase-person-identity.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { fixtureFetch } from './type-helpers.ts';

test('a reviewed Person pair merges once through the native contract and both originals read the canonical Person', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'identity-person-merge-native-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const port = captureShowcaseCommands(runtime.importTransport, journal);
    const editor = await openApiObserver(runtime);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: fixtureFetch(async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      }),
    });
    const plan = emptyCrossMediaPlan();
    plan.entities.bangumi.push({
      source: 'bangumi',
      key: 'person:1916',
      revision: 'native-bangumi',
      payload: { id: 1916, type: 1, name: '麻枝准', summary: 'Source biography' },
    });
    plan.entities.vndb.push({
      source: 'vndb',
      key: 's224',
      revision: 'native-vndb',
      payload: {
        id: 's224',
        main: '28069',
        prod: null,
        name: '前田 純',
        staff_alias: [{ id: 's224', aid: '28069', name: '前田 純', latin: 'Maeda Jun' }],
      },
    });
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port, { origin: runtime.origin });
    const pair = first.personReview!.pair;
    expect(pair.state).toBe('selected');
    if (pair.state !== 'selected') throw new Error('Expected the selected Person pair');
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt', 'subject:merge'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });

    const merge = () =>
      publishReviewedPersonMerge({
        pair: pair.sources,
        transport: runtime.importTransport,
        readPublic: (id) => publicClient.readSubject(id),
        journal,
        pause: async () => {},
      });
    const published = await merge();
    expect(published.state).toBe('published');
    if (published.state !== 'published') throw new Error('Expected the native merge to publish');
    expect(published.identities.map((entry) => entry.currentSubjectId)).toEqual([
      published.survivor,
      published.survivor,
    ]);
    expect([published.survivor, published.redirected].sort()).toEqual(
      pair.sources.map((source) => source.boundSubjectId).sort(),
    );
    // A reopened run replays the journaled intent: the admitted operation is not sent again.
    expect(await merge()).toMatchObject({
      state: 'published',
      operation: published.operation,
      survivor: published.survivor,
    });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);
