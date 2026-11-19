import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogueWalkRouteKey } from '../../../../scripts/walk-stack.ts';
import { crossMediaAliases, emptyCrossMediaPlan, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  publishReviewedPersonMerge,
  readCombinedPersonCredits,
} from '../../../importer/src/showcase-person-identity.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readPersonMergeContinuation } from '../../scripts/read-person-merge-continuation.ts';
import { startWorker } from '../../src/worker.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiObserver } from './api-observer.ts';
import { importWorkerEnvironment, openApiRuntime } from './api-runtime.ts';
import { fixtureFetch } from './type-helpers.ts';
import '../support/native-history-composition.ts';

test('a reviewed Person pair merges once through the native contract and both originals read the canonical Person', async () => {
  const searchUrl = process.env.OPENSEARCH_URL;
  if (!searchUrl) throw new Error('Person merge publication requires OPENSEARCH_URL');
  const search = createOpenSearch(searchUrl);
  const routeKey = catalogueWalkRouteKey();
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65_536,
    workerStartup: 'on-demand',
    routeKey,
  });
  const directory = await mkdtemp(join(tmpdir(), 'identity-person-merge-native-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const prefix = 'reviewed-' + randomUUID().replaceAll('-', '');
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker({ databaseUrl: runtime.database.url, poolSize: 10, handleSignals: false }, undefined, {
      ...importWorkerEnvironment(runtime.identity),
      STRIPE_SECRET_KEY: undefined,
      DATABASE_URL: runtime.database.url,
      OPENSEARCH_URL: searchUrl,
      KERNEL_SEARCH_PREFIX: prefix,
    });
    const port = captureShowcaseCommands(runtime.importTransport, journal);
    const editor = await openApiObserver(runtime, { reviewedMerge: true });
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
      payload: {
        id: 1916,
        type: 1,
        name: '麻枝准',
        name_cn: '麻枝准',
        birth_year: 1975,
        birth_mon: 1,
        birth_day: 3,
        summary: 'Source biography',
        career: ['producer'],
      },
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
        aliases: [
          { id: 's224', aid: '386', name: '麻枝 准' },
          { id: 's224', aid: '28069', name: '前田 純' },
        ],
      },
    });
    const first = await seedCrossMedia(plan, join(directory, 'state.sqlite'), port, { origin: runtime.origin });
    const pair = first.personReview!.pair;
    expect(pair.state).toBe('selected');
    if (pair.state !== 'selected') throw new Error('Expected the selected Person pair');
    const grant = async (actions: string[]) => {
      const response = await editor.http('/v1/grants', {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: runtime.identity.bulk.accountId },
        actions,
        valid: '(,)',
      });
      expect(response.status).toBe(201);
    };
    await grant(['context:accept', 'context:adopt']);
    await publishShowcase({
      plan,
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });

    const subjects = pair.sources.map(({ boundSubjectId }) => boundSubjectId);
    const sources = [
      { source: 'bangumi_cross_media', externalId: 'person:1916', property: 'wdt:P6298', value: '1916' },
      { source: 'vndb_cross_media', externalId: 's224', property: 'wdt:P3180', value: 's224' },
    ] as const;
    const claimRoutes = sources.map(({ source, externalId }) => tupleRoute(routeKey, source, externalId));
    expect(claimRoutes).toEqual([11075, 11072]);
    expect(subjects.map(routeOf)).toEqual(claimRoutes);
    expect(claimRoutes.map(partitionOf)).toEqual([692, 692]);
    const survivorRead = await publicClient.readSubject(subjects[0]!);
    expect(survivorRead.subject.statements?.['schema:name']).toHaveLength(2);
    expect(survivorRead.subject.statements?.['schema:birthDate']).toHaveLength(1);
    const works = [
      {
        type: 'schema:TVSeries',
        externalId: '1851',
        label: 'Angel Beats!',
        roles: [
          ['schema:author', '1'],
          ['schema:musicBy', '6'],
          ['schema:contributor', '10'],
          ['schema:musicBy', '31'],
          ['schema:lyricist', '32'],
          ['schema:author', '3'],
        ],
        citation: () => 'https://bgm.tv/subject/1851#/subject-persons/1851/1916/position',
      },
      {
        type: 'wd:Q689445',
        externalId: 'v4',
        label: 'CLANNAD',
        roles: [
          ['schema:author', 'scenario'],
          ['schema:contributor', 'staff'],
          ['schema:musicBy', 'music'],
        ],
        citation: (role: string) => `https://vndb.org/v4#/vn_staff/v4/386/${role}`,
      },
    ] as const;
    const snak = (id: string, content: string) => ({ property: { id }, value: { type: 'value' as const, content } });
    const creditedWorks: { externalId: string; boundSubjectId: string }[] = [];
    for (const [i, work] of works.entries()) {
      const statements: Record<
        string,
        {
          property: { id: string };
          value: { type: 'value'; content: string };
          qualifiers: ReturnType<typeof snak>[];
          references: { parts: ReturnType<typeof snak>[] }[];
        }[]
      > = {};
      for (const [property, role] of work.roles) {
        const concept = await runtime.request(
          '/v1/subjects',
          {
            type: 'skos:Concept',
            labels: { en: role },
          },
          runtime.bulk.bearer,
          randomUUID(),
        );
        expect(concept.status).toBe(201);
        const { subject } = (await concept.json()) as { subject: { id: string } };
        (statements[property] ??= []).push({
          ...snak(property, subjects[i]!),
          qualifiers: [snak('wdt:P3831', subject.id), ...(i === 1 ? [snak('wdt:P1932', '麻枝 准')] : [])],
          references: [{ parts: [snak('schema:url', work.citation(role))] }],
        });
      }
      const response = await runtime.request(
        '/v1/subjects',
        {
          type: work.type,
          labels: { en: work.label },
          statements,
        },
        runtime.bulk.bearer,
        randomUUID(),
      );
      const created = (await response.json()) as { subject: { id: string } };
      expect(response.status, JSON.stringify(created)).toBe(201);
      creditedWorks.push({ externalId: work.externalId, boundSubjectId: created.subject.id });
    }
    // The catalogue has already published and read both works before it submits the merge.
    for (const [i, work] of creditedWorks.entries()) {
      const current = await publicClient.readSubject(work.boundSubjectId);
      for (const [property] of works[i]!.roles) {
        expect(current.subject.statements?.[property]).toHaveLength(
          works[i]!.roles.filter(([key]) => key === property).length,
        );
      }
    }
    const endpoints = [];
    for (const [index, source] of sources.entries()) {
      const subject = subjects[index]!;
      const read = await runtime.importTransport.readReviewedPersonIdentity(subject, source);
      const response = runtime.captures.at(-1)!.response;
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(read.reviewedIdentity).toEqual({
        ...source,
        subject,
        securityRevision: '0',
        revision: expect.any(Number),
        claimTransactionId: expect.any(String),
      });
      endpoints.push(read.reviewedIdentity);
    }
    const body = { subjects, expectedIdentity: { endpoints } };
    const closed = await runtime.request('/v1/subjects:merge', body, runtime.bulk.bearer);
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ code: 'platform_closed', effect_status: 'not_applied' });
    await grant(['subject:merge', 'gate:subject_identity']);

    const merge = (polls?: number) =>
      publishReviewedPersonMerge({
        ...(polls === undefined ? {} : { polls }),
        pair: pair.sources,
        transport: runtime.importTransport,
        readPublic: (id) => publicClient.readSubject(id),
        journal,
      });
    const admitted = await merge(1);
    expect(admitted.state).toBe('pending');
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const published = await merge();
    if (published.state === 'pending') {
      const id = published.operation;
      const observation = await readPersonMergeContinuation(runtime.database.admin, id);
      throw new Error(`Operation ${id} remained pending at ${JSON.stringify(observation)}`);
    }
    expect(published.state).toBe('published');
    if (published.state !== 'published') throw new Error('Expected the native merge to publish');
    expect(admitted).toEqual({ state: 'pending', operation: published.operation });
    expect(await readPersonMergeContinuation(runtime.database.admin, published.operation)).toMatchObject({
      state: 'observed',
      job: 'published',
      admitted_event: true,
      effect_queue: 'governance',
      coordinator: expect.any(String),
      redirected: true,
    });
    const requests = await runtime.database.admin.query(
      `SELECT workflow_uuid, output::jsonb->'json'->'receipt' AS receipt
       FROM dbos.operation_outputs WHERE workflow_uuid LIKE $1 AND function_name='semantic.identityEpoch.produce'
         AND output::jsonb->'json'->>'writerRequested'='true'`,
      [`semantic:identity:${published.operation}:%`],
    );
    expect(requests.rowCount).toBeGreaterThan(0);
    expect(new Set(requests.rows.map((row) => JSON.stringify(row))).size).toBe(requests.rowCount!);
    const acks = await runtime.database.admin.query(
      `SELECT step FROM semantic.identity_epoch_ack WHERE partition_no=$1 AND job_id=$2
       AND progress->>'state'='complete' ORDER BY step`,
      [partitionOf(routeOf(published.operation)!), published.operation],
    );
    expect(acks.rows.map(({ step }) => step)).toEqual([
      'library-private-follow-counts',
      'mapping',
      'search-canonical-index',
    ]);
    expect(published.identities.map((entry) => entry.currentSubjectId)).toEqual([
      published.survivor,
      published.survivor,
    ]);
    expect(published.identities.map((entry) => entry.boundSubjectId)).toEqual(
      pair.sources.map((source) => source.boundSubjectId),
    );
    expect(published.identities.map((entry) => entry.identity.externalId)).toEqual(['person:1916', 's224']);
    expect([published.survivor, published.redirected].sort()).toEqual(
      pair.sources.map((source) => source.boundSubjectId).sort(),
    );
    const combined = await readCombinedPersonCredits({
      canonicalPersonId: published.survivor,
      originals: published.identities.map(({ boundSubjectId, identity }) => ({
        boundPersonId: boundSubjectId,
        personExternalId: identity.externalId,
      })),
      works: creditedWorks,
      readPublic: (id) => publicClient.readSubject(id),
    });
    if (!('credits' in combined)) throw new Error('Both original credit windows must be readable');
    const expectedCredits = works.flatMap((work, i) =>
      work.roles.map(([property, role]) => [
        work.externalId,
        subjects[i],
        published.survivor,
        property,
        i === 1 ? ['麻枝 准'] : [],
        [work.citation(role)],
      ]),
    );
    const creditKeys = (rows: unknown[][]) => rows.map((row) => JSON.stringify(row)).sort();
    expect(
      creditKeys(
        combined.credits.map((credit) => [
          credit.workExternalId,
          credit.boundPersonId,
          credit.canonicalPersonId,
          credit.property,
          credit.creditedAs,
          credit.citations,
        ]),
      ),
    ).toEqual(creditKeys(expectedCredits));
    const redirect = await runtime.request(`/v1/subjects/${published.redirected}`);
    expect([redirect.status, redirect.headers.get('location')]).toEqual([308, `/v1/subjects/${published.survivor}`]);
    // A reopened run replays the journaled intent: the admitted operation is not sent again.
    expect(await merge()).toEqual(published);
    const admissions = runtime.captures.filter(({ request }) => new URL(request.url).pathname === '/v1/subjects:merge');
    expect(admissions.map(({ response }) => response.status)).toEqual([202]);
    expect(JSON.parse(admissions[0]!.body)).toEqual(body);
    const location = `/v1/subjectIdentityOperations/${published.operation}`;
    expect(admissions[0]!.response.headers.get('location')).toBe(location);
    expect(await admissions[0]!.response.json()).toEqual({ operation: { id: published.operation } });
    const poll = runtime.captures.findLast(({ request }) => new URL(request.url).pathname === location);
    expect(poll?.response.status).toBe(200);
    expect(await poll!.response.json()).toEqual({
      operation: {
        id: published.operation,
        done: true,
        result: { survivor: published.survivor, redirected: published.redirected, revision: published.revision },
      },
    });
  } finally {
    try {
      await worker?.stop();
      const { body: indices } = await search.request<{ index: string }[]>(
        'GET',
        `/_cat/indices/${prefix}*`,
        undefined,
        {
          query: { format: 'json', h: 'index' },
        },
      );
      for (const { index } of indices) await search.request('DELETE', `/${index}`);
    } finally {
      journal.close();
      try {
        await runtime.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 600_000);
