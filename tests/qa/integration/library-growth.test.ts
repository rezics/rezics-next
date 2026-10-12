import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { root } from '../../../scripts/fixture/stack.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  createCorpusBackupDriver,
  type CorpusRestoreSmokeInput,
  type ManagedCorpusBackupDriver,
} from '../../../scripts/load/corpus-backup-driver.ts';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  type CorpusApi,
  type CorpusDimensions,
  type WorkProfileCorpusManifest,
  type WorkProfileCorpusRecipe,
  type WorkProfileDimension,
  type WorkProfileScale,
} from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { READER_LIBRARY_COST } from '../../../services/main/src/modules/library/read.ts';
import { STATUS_SHELF_COST } from '../../../services/main/src/modules/library/status.ts';
import {
  assertWorkCostAtScales,
  profileRequest,
  startWorkProfileSink,
  type WorkCostContract,
  type WorkProfile,
} from '../support/work-profile.ts';
import { startMediaStack } from './media-support.ts';

const emptyDimensions: CorpusDimensions = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};

const scales: readonly WorkProfileScale[] = ['small', 'medium', 'large'];
const workAxis: WorkProfileDimension = 'unrelatedWorks';
const postAxis: WorkProfileDimension = 'unrelatedPosts';
const fixedPosts = 4;
const largestWorkPopulation = 64;
const targetKey = 'library-growth:reader-target';
const hostBookKey = 'library-growth:post-host';
const targetStatusKey = 'library-growth:reader-status';
const authorAgentKey = 'library-growth:author-agent';
const readerAgentKey = 'library-growth:reader-agent';
const authorName = 'Library growth corpus author';
const readerName = 'Library growth corpus reader';

function apiFor(stack: Awaited<ReturnType<typeof startMediaStack>>, token: string) {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
}

type LiveSource = {
  stack: Awaited<ReturnType<typeof startMediaStack>>;
  authorToken: string;
  readerToken: string;
};

function liveApiFor(readSource: () => LiveSource | undefined, member: 'author' | 'reader') {
  return workProfileCorpusApi('http://main.local', 'refreshed-by-fetch', {
    fetch: ((input, init) => {
      const current = readSource();
      if (!current) throw new Error('Library corpus source is stopped');
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${member === 'author' ? current.authorToken : current.readerToken}`);
      return current.stack.main.handle(new Request(input, { ...init, headers }));
    }) as typeof fetch,
  });
}

function actorCommand(name: string) {
  return {
    method: 'POST' as const,
    path: '/v1/agents' as const,
    body: { profile: 'agent-provision-v1', kind: 'person', displayName: name },
  };
}

async function seedPostBook(api: CorpusApi, actor: string) {
  const created = await api.command<{ work: string; mainVersion: string }>(`${hostBookKey}:work`, {
    method: 'POST',
    path: '/v1/works',
    body: {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: 'Library growth post host',
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      actingSubject: actor,
    },
  });
  const draft = await api.command<{ contribution: string; draftRevision: string }>(
    `${hostBookKey}:draft`,
    {
      method: 'POST',
      path: '/v1/contributions',
      body: {
        profile: 'text-contribution-v1',
        work: created.work,
        body: 'A fixed host for unrelated chapter posts.',
        language: 'en',
        actingSubject: actor,
      },
    },
  );
  const published = await api.command<{ publicationDecision: string }>(`${hostBookKey}:publish`, {
    method: 'POST',
    path: '/v1/contribution-publications',
    body: {
      profile: 'text-publication-v1',
      contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: actor,
    },
  });
  await api.command(`${hostBookKey}:select`, {
    method: 'POST',
    path: '/v1/publication-selections',
    body: {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: created.mainVersion },
      work: created.work,
      contribution: draft.contribution,
      publicationDecision: published.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: actor,
    },
  });
  const composition = await api.command<{ structure: string; revision: string }>(
    `${hostBookKey}:composition`,
    {
      method: 'POST',
      path: '/v1/compositions',
      body: {
        profile: 'book-composition',
        work: created.work,
        mainVersion: created.mainVersion,
        actingSubject: actor,
      },
    },
  );
  return { ...created, ...composition };
}

type Chapter = { post: string; title: string; compositionRevision: string };

async function addChapter(
  api: CorpusApi,
  actor: string,
  book: { work: string; structure: string },
  expectedCompositionHead: string,
  index: number,
): Promise<Chapter> {
  const title = `Library growth unrelated post ${index}`;
  const result = await api.command<{
    post: string;
    compositionRevision: string;
  }>(`library-growth:unrelated-post:${index}`, {
    method: 'POST',
    path: `/v1/works/${book.work.slice(-36)}/chapters`,
    body: {
      profile: 'book-chapter-create-v1',
      title,
      language: 'en',
      direction: 'ltr',
      parent: book.structure,
      position: 'last',
      expectedCompositionHead,
      actingSubject: actor,
    },
  });
  return { ...result, title };
}

function createRecipe(
  axis: WorkProfileDimension,
  authorApi: CorpusApi,
  readerApi: CorpusApi,
) {
  const axisSlug = axis.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const fixed: CorpusDimensions = {
    ...emptyDimensions,
    unrelatedWorks: axis === workAxis ? 1 : largestWorkPopulation,
    unrelatedPosts: fixedPosts,
  };
  const works: Array<Awaited<ReturnType<typeof seedPublicProfileWork>>> = [];
  const posts: Chapter[] = [];
  let author = '';
  let reader = '';
  let target: Awaited<ReturnType<typeof seedPublicProfileWork>> | undefined;
  let book: Awaited<ReturnType<typeof seedPostBook>> | undefined;
  let compositionHead = '';
  let serialPosts = Promise.resolve();

  const recipe: WorkProfileCorpusRecipe = {
    version: `library-reader-growth-${axisSlug}-v1`,
    fixed,
    async initialize(api) {
      author = (await api.command<{ agent: string }>(authorAgentKey, actorCommand(authorName))).agent;
      reader = (
        await readerApi.command<{ agent: string }>(readerAgentKey, actorCommand(readerName))
      ).agent;
      target = await seedPublicProfileWork(api, targetKey, {
        actingSubject: author,
        title: 'Library growth reading target',
        body: 'A fixed public Work whose reader state is measured.',
      });
      await readerApi.command(`${targetStatusKey}:set`, {
        method: 'PUT',
        path: `/v1/works/${target.work.slice(-36)}/reader-status`,
        body: {
          actingSubject: reader,
          expectedVersion: 0,
          status: 'reading',
          startedOn: null,
          finishedOn: null,
        },
      });

      book = await seedPostBook(api, author);
      compositionHead = book.revision;
      posts.length = 0;
      for (let index = 0; index < fixedPosts; index++) {
        const chapter = await addChapter(api, author, book, compositionHead, index);
        posts.push(chapter);
        compositionHead = chapter.compositionRevision;
      }
      serialPosts = Promise.resolve();

      works.length = 0;
      works.push(book as Awaited<ReturnType<typeof seedPublicProfileWork>>);
      if (axis === postAxis) {
        for (let index = 1; index < largestWorkPopulation; index++) {
          works.push(await seedPublicProfileWork(api, `library-growth:unrelated-work:${index}`, {
            actingSubject: author,
            title: `Library growth unrelated Work ${index}`,
            body: `An unrelated public Work used to hold the post axis fixed (${index}).`,
          }));
        }
      }
    },
    async grow(api, dimension, index) {
      expect(dimension).toBe(axis);
      if (dimension === workAxis) {
        const created = await seedPublicProfileWork(api, `library-growth:unrelated-work:${index + 1}`, {
          actingSubject: author,
          title: `Library growth unrelated Work ${index + 1}`,
          body: `An unrelated public Work outside the reader's shelf (${index + 1}).`,
        });
        works[index + 1] = created;
        return;
      }
      if (dimension !== postAxis || !book) throw new Error('Unexpected library corpus dimension');
      const chapterIndex = fixedPosts + index;
      const pending = serialPosts.then(async () => {
        const chapter = await addChapter(api, author, book!, compositionHead, chapterIndex);
        posts[chapterIndex] = chapter;
        compositionHead = chapter.compositionRevision;
      });
      serialPosts = pending.then(() => undefined);
      await pending;
    },
    async verify(api) {
      if (!target || !book || !author || !reader) throw new Error('Library corpus is incomplete');
      for (const [index, created] of works.entries()) {
        const selected = await api.read<{ work: string; mainVersion: string; body: string }>(
          `/v1/main-versions/${created.mainVersion.slice(-36)}/selection?language=en`,
        );
        expect(selected).toMatchObject({
          work: created.work,
          mainVersion: created.mainVersion,
          body: index === 0 ? 'A fixed host for unrelated chapter posts.' : expect.any(String),
        });
      }
      for (const chapter of posts) {
        const post = await api.read<{ id: string; title: { value: string } }>(
          `/v1/posts/${chapter!.post.slice(-36)}?actingSubject=${encodeURIComponent(author)}`,
        );
        expect(post).toMatchObject({ id: chapter!.post, title: { value: chapter!.title } });
      }
      expect(new Set(works.map(({ work }) => work)).size).toBe(works.length);
      expect(new Set(posts.map(({ post }) => post)).size).toBe(posts.length);
      return { ...emptyDimensions, unrelatedWorks: works.length, unrelatedPosts: posts.length };
    },
  };
  return { recipe, authorApi, readerApi, get author() { return author; }, get reader() { return reader; },
    get target() { return target; }, get works() { return works; }, get posts() { return posts; } };
}

async function openRestoredStack(input: CorpusRestoreSmokeInput) {
  const env = {
    ...input.apps,
    REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration',
    REZICS_STACK_PROFILE: 'qa',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    return await startMediaStack(`library-growth-restore-${input.target}`, {
      library: true,
      ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!,
        content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
      },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

type RestoredContext = {
  stack: Awaited<ReturnType<typeof startMediaStack>>;
  authorToken: string;
  readerToken: string;
  fusekiUrl: string;
};

const readerCost = {
  fusekiRequests: READER_LIBRARY_COST.graphCalls,
  fusekiReceivedBytes: READER_LIBRARY_COST.responseBytes,
  postgresStatements: READER_LIBRARY_COST.sqlReads,
  accountCalls: 0,
  otherFetches: 0,
  unclassifiedFetches: 0,
} satisfies Omit<WorkCostContract, 'growth'>;

// Status shelf traversal is a bounded indexed candidate walk; its SQL allowance
// composes the reader read budget with the two candidate batches it may request.
const shelfCost = {
  fusekiRequests: READER_LIBRARY_COST.graphCalls,
  fusekiReceivedBytes: READER_LIBRARY_COST.responseBytes,
  postgresStatements: READER_LIBRARY_COST.sqlReads + STATUS_SHELF_COST.candidateBatches,
  accountCalls: 0,
  otherFetches: 0,
  unclassifiedFetches: 0,
} satisfies Omit<WorkCostContract, 'growth'>;

function costContract(
  maxima: Omit<WorkCostContract, 'growth'>,
): WorkCostContract {
  return {
    ...maxima,
    growth: {
      fusekiRequests: { class: 'constant', dimension: 'mainCalls' },
      fusekiSentBytes: { class: 'constant', dimension: 'mainCalls' },
      fusekiReceivedBytes: { class: 'constant', dimension: 'mainCalls' },
      postgresStatements: { class: 'constant', dimension: 'mainCalls' },
    },
  };
}

test('Reader library shelf and Work status reads stay constant as unrelated Works and Posts grow', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through goalctl integration QA');
  }
  const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${runId}`);
  if (readEnv(join(sourceDirectory, 'compose.env')).REZICS_STACK_STORAGE !== 'persistent') {
    throw new Error('Library growth checkpoints require the persistent catalogue-disk QA project');
  }

  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('library-growth-cost', {
    ...process.env,
    ...sink.env,
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  let source: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  let liveSource: LiveSource | undefined;
  const authorApi = liveApiFor(() => liveSource, 'author');
  const readerApi = liveApiFor(() => liveSource, 'reader');
  let driver: ManagedCorpusBackupDriver | undefined;
  let activeCheckpoint: WorkProfileCorpusManifest | undefined;
  let activeFixture: ReturnType<typeof createRecipe> | undefined;
  const restored = new Map<string, RestoredContext>();
  const profiles: Array<{
    axis: WorkProfileDimension;
    scale: number;
    operation: 'status-shelf' | 'reader-state';
    profile: WorkProfile;
  }> = [];

  try {
    source = await startMediaStack('library-growth-source', { library: true });
    const authorMember = await source.member('library-growth-author', { stable: true, verified: true });
    const readerMember = await source.member('library-growth-reader', { stable: true, verified: true });
    liveSource = { stack: source, authorToken: authorMember.token, readerToken: readerMember.token };
    const backupDriver = createCorpusBackupDriver({
      sourceRunId: runId,
      directory: join(root, '.temp/work-profiles', `library-growth-${runId}`, 'backups'),
      async quiesce(signal) {
        signal.throwIfAborted();
        const stopped = liveSource;
        if (!stopped) throw new Error('Library corpus source is unavailable before backup');
        liveSource = undefined;
        source = undefined;
        await stopped.stack.stop();
        return async () => {
          const resumed = await startMediaStack('library-growth-source', { library: true });
          try {
            const author = await resumed.member('library-growth-author', { stable: true, verified: true });
            const reader = await resumed.member('library-growth-reader', { stable: true, verified: true });
            source = resumed;
            liveSource = { stack: resumed, authorToken: author.token, readerToken: reader.token };
          } catch (error) {
            await resumed.stop();
            throw error;
          }
        };
      },
      async smokeRead(input) {
        const stack = await openRestoredStack(input);
        try {
          const author = await stack.member('library-growth-author', { stable: true, verified: true });
          const reader = await stack.member('library-growth-reader', { stable: true, verified: true });
          const authorApi = apiFor(stack, author.token);
          const readerApi = apiFor(stack, reader.token);
          const readerAgent = (
            await readerApi.command<{ agent: string }>(readerAgentKey, actorCommand(readerName))
          ).agent;
          if (!activeCheckpoint || !activeFixture?.target) throw new Error('No active library checkpoint');
          const restoredDimensions = await activeFixture.recipe.verify(authorApi);
          for (const [dimension, expected] of Object.entries(activeCheckpoint.dimensions))
            expect(restoredDimensions[dimension as keyof CorpusDimensions] ?? 0).toBe(expected);
          const target = activeFixture.target;
          const readerState = await readerApi.read<{
            work: string;
            status: { status: string };
          }>(`/v1/works/${target.work.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(readerAgent)}`);
          expect(readerState).toMatchObject({ work: target.work, status: { status: 'reading' } });
          restored.set(input.target, {
            stack,
            authorToken: author.token,
            readerToken: reader.token,
            fusekiUrl: input.apps.FUSEKI_URL!,
          });
          return async () => {
            restored.delete(input.target);
            await stack.stop();
          };
        } catch (error) {
          await stack.stop();
          throw error;
        }
      },
    });
    driver = backupDriver;

    const axes: WorkProfileDimension[] = [workAxis, postAxis];
    for (const axis of axes) {
      const fixture = createRecipe(axis, authorApi, readerApi);
      activeFixture = fixture;
      for (const scale of scales) {
        const checkpoint = await prepareWorkProfileCorpus({
          recipe: fixture.recipe,
          api: fixture.authorApi,
          backups: backupDriver,
          dimension: axis,
          scale,
          directory: join(root, '.temp/work-profiles', `library-growth-${runId}`, 'manifests'),
        });
        activeCheckpoint = checkpoint;
        const target = `library-growth-${axis === workAxis ? 'works' : 'posts'}-${scale}`;
        const restoreStarted = performance.now();
        await restoreWorkProfileCorpus(checkpoint, target, backupDriver, restoreStarted);
        const context = restored.get(target);
        if (!context || !fixture.target || !fixture.reader) throw new Error('Restored library fixture is incomplete');
        const actingSubject = encodeURIComponent(fixture.reader);
        const requests = [
          {
            operation: 'status-shelf' as const,
            path: `/v1/me/shelves/status/reading/works?actingSubject=${actingSubject}&sort=added&order=desc&limit=${STATUS_SHELF_COST.pageSize}`,
          },
          {
            operation: 'reader-state' as const,
            path: `/v1/works/${fixture.target.work.slice(-36)}/reader-state?actingSubject=${actingSubject}`,
          },
        ];
        for (const request of requests) {
          const token = context.readerToken;
          const { result, profile } = await profileRequest(
            sink,
            async (headers) => {
              headers.set('authorization', `Bearer ${token}`);
              const response = await context.stack.main.handle(
                new Request(`http://main.local${request.path}`, { headers }),
              );
              const body = await response.text();
              expect(response.status, body).toBe(200);
              return JSON.parse(body) as Record<string, unknown>;
            },
            {
              service: 'library-growth-cost',
              peers: { fuseki: context.fusekiUrl },
              flush: flushTelemetryTraces,
            },
          );
          expect(profile.mainCalls).toBe(0);
          expect(profile.unclassifiedFetches).toBe(0);
          if (request.operation === 'status-shelf') {
            const shelf = result as { items: Array<{ work: string; status: string }> };
            expect(shelf.items).toHaveLength(1);
            expect(shelf.items[0]).toMatchObject({ work: fixture.target.work, status: 'reading' });
          } else {
            expect(result).toMatchObject({
              work: fixture.target.work,
              status: { status: 'reading' },
            });
          }
          // The shared growth assertion takes a WorkProfile counter as its axis.
          // Preserve the measured main-call assertion above, then use this field
          // only as a test-local marker for the known corpus checkpoint size.
          profiles.push({ axis, scale: checkpoint.dimensions[axis], operation: request.operation,
            profile: { ...profile, mainCalls: checkpoint.dimensions[axis] } });
          sink.clear();
        }
        console.log('Library growth counters', profiles.slice(-2).map(({ axis: dimension, scale: size, operation, profile }) => ({
          dimension, size, operation, fusekiRequests: profile.fusekiRequests,
          fusekiSentBytes: profile.fusekiSentBytes, fusekiReceivedBytes: profile.fusekiReceivedBytes,
          postgresStatements: profile.postgresStatements,
        })));
        await backupDriver.stop(target);
      }
    }

    const failures: string[] = [];
    for (const operation of ['status-shelf', 'reader-state'] as const) {
      const maxima = operation === 'status-shelf' ? shelfCost : readerCost;
      for (const axis of axes) {
        const group = profiles
          .filter((item) => item.operation === operation && item.axis === axis)
          .sort((a, b) => a.scale - b.scale)
          .map((item) => item.profile);
        const label = `library-${operation}-${axis === workAxis ? 'unrelated-works' : 'unrelated-posts'}`;
        try {
          assertWorkCostAtScales(group, costContract(maxima), label);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const target of [...restored.keys()]) {
      try {
        await driver?.stop(target);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await source?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await shutdownTelemetry();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await sink.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Library growth cleanup failed');
  }
}, 600_000);
