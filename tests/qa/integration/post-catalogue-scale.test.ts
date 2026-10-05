import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { POST_READ_COST } from '../../../services/main/src/modules/post/read.ts';
import {
  mainSelectionDigest,
  selectMainDefault,
} from '../../../services/main/src/modules/work/select-main.ts';
import {
  realmSelectionDigest,
  selectRealmLocal,
} from '../../../services/main/src/modules/work/select-realm.ts';
import {
  createRealmSpace,
  spaceCreationDigest,
} from '../../../services/main/src/modules/space/create.ts';
import { startMediaStack } from './media-support.ts';
import { measureGraphResponses as measurePostLayerRead } from './support/graph-responses.ts';

const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('A Book with 1000 chapter Posts stays one Work and reads have the same graph cost as 10 chapters', async () => {
  const setupStarted = performance.now();
  const stack = await startMediaStack('post-catalogue-scale', { library: true, agents: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const member = await stack.member('scale-author');
    const provision = await json<{ agent: string }>(
      await member.send('POST', '/v1/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: 'Scale author',
      }),
      201,
    );
    const actor = provision.agent;
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const discovery = new DiscoveryProjection(stack.accessPool);
    const zoneBrowse = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    const deps = {
      environment: stack.env,
      access: stack.access,
      structureObjects: objects,
      profiles: new ProfilesAccess(stack.accessPool),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      discovery,
      zoneBrowse,
      account: {
        verify: async () => {
          const principal = { ...member.principal, emailVerified: true as const };
          return { ...principal, currentAssertion: async () => principal };
        },
      },
    };
    const app = createMainApp(stack.fuseki, deps);
    const send = (path: string, body: unknown) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${member.token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const title = `thousandchapter${randomUUID().replaceAll('-', '')}`;
    const book = await json<{ work: string; mainVersion: string }>(
      await send('/v1/works', {
        profile: 'metadata-only-v1',
        authoring: 'own-work',
        title,
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: actor,
      }),
      201,
    );
    const text = await stack.contribution(book.work, actor, 'en', `${title} opening`);
    const selected = {
      context: { kind: 'main-version-default' as const, id: book.mainVersion },
      work: book.work,
      contribution: text.contribution,
      publicationDecision: text.decision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const,
      actingSubject: actor,
    };
    await selectMainDefault(
      stack.env,
      stack.admission(
        actor,
        `publication:select:${book.mainVersion}`,
        'publication.select',
        mainSelectionDigest(selected),
      ),
      selected,
    );
    const composition = await json<{ structure: string; revision: string }>(
      await send('/v1/compositions', {
        profile: 'book-composition',
        work: book.work,
        mainVersion: book.mainVersion,
        actingSubject: actor,
      }),
      201,
    );
    const space = { name: 'Scale Realm', capabilities: ['realm' as const], actingSubject: actor };
    const created = await createRealmSpace(
      stack.env,
      stack.admission(actor, 'space:create:root', 'space.create', spaceCreationDigest(space)),
      space,
    );
    if (!created.realm) throw new Error('Missing Realm');
    const adoption = {
      ...selected,
      context: { kind: 'realm-local' as const, id: created.realm },
      mainVersion: book.mainVersion,
      selectionBasis: 'realm-manager-review' as const,
    };
    await selectRealmLocal(
      stack.env,
      stack.admission(
        actor,
        `publication:adopt:${created.realm}`,
        'publication.adopt',
        realmSelectionDigest(adoption),
      ),
      adoption,
    );
    console.info(
      `Post scale Book/author/Realm preparation: ${Math.round(performance.now() - setupStarted)} ms`,
    );
    const refreshProjections = async (chapters: number) => {
      const started = performance.now();
      await stack.accessPool.query(
        `INSERT INTO access.serial_stats_checkpoint
      (singleton,generation,graph_epoch,sequence) VALUES (true,$1,$2,0)
      ON CONFLICT (singleton) DO UPDATE SET generation=$1,graph_epoch=$2,sequence=0`,
        [randomUUID(), stack.env.lineage.dataEpoch],
      );
      await zoneBrowse.backfill();
      const basis = { scope: 'global' as const, realm: null, context: null },
        operator = automaticDiscovery(null);
      const request = new Request('http://main.internal/post-discovery-build');
      let generation = await workRead(deps, request, {}, (session) =>
        discovery.register(operator, basis, session.position, {
          idempotencyKey: randomUUID(),
          requestDigest: 'a'.repeat(64),
        }),
      );
      while (!generation.complete) {
        generation = await workRead(deps, request, {}, async (session) => {
          const lease = await discovery.beginStep(
            operator,
            generation.generation_id,
            generation.checkpoint,
          );
          return {
            ...(await discovery.commitBatch(
              operator,
              generation.generation_id,
              lease.lease,
              generation.checkpoint,
              await projectDiscoveryBatch(session, basis, generation.checkpoint),
              session.position,
            )),
            replayed: false,
          };
        });
      }
      await workRead(deps, request, {}, (session) =>
        discovery.activate(
          operator,
          generation.generation_id,
          generation.active_head,
          session.position,
          { idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) },
        ),
      );
      console.info(
        `Post scale ${chapters} chapters projection preparation: ${Math.round(performance.now() - started)} ms`,
      );
    };
    const measureReads = async (chapters: number, post: { post: string; occurrence: string }) => {
      const catalogue = async () => {
        const read = await json<{ results: { work: string }[] }>(
          await app.handle(new Request(`http://main.local/v1/search/catalogue?q=${title}`)),
        );
        expect(read.results.map((row) => row.work)).toEqual([book.work]);
      };
      const page = (path: string) => async () => {
        const read = await json<{ items: { id: string }[] }>(
          await app.handle(new Request(`http://main.local${path}`)),
        );
        expect(read.items.map((row) => row.id)).toEqual([book.work]);
      };
      const placements = async () => {
        const read = await json<{
          profile: string;
          id: string;
          placements: { book: string; occurrence: string }[];
          placementsTruncated: boolean;
        }>(await member.read(`/v1/posts/${short(post.post)}`));
        expect(read).toMatchObject({
          profile: 'post-read-v2',
          id: post.post,
          placements: [{ book: book.work, occurrence: post.occurrence }],
          placementsTruncated: false,
        });
      };
      const reads = {
        catalogue,
        author: page(`/v1/agents/${short(actor)}/works`),
        zone: page(`/v1/realms/${short(created.realm!)}/modules/browse`),
        discover: page('/v1/works'),
        placements,
      };
      const costs: Record<string, { graphCalls: number; graphRows: number }> = {};
      for (const [name, read] of Object.entries(reads)) {
        // Retain both first and repeat samples: a cache must not hide growth in the first read after writes.
        for (const sample of ['first', 'repeat']) {
          const measured = await measurePostLayerRead(stack.fuseki, read);
          console.info(
            `Post scale read: ${JSON.stringify({ chapters, name, sample, ...measured.cost, ms: measured.ms })}`,
          );
          expect(measured.cost.graphCalls).toBeGreaterThan(0);
          expect(measured.cost.graphRows).toBeGreaterThan(0);
          if (name === 'placements')
            expect(measured.cost.graphCalls).toBeLessThanOrEqual(POST_READ_COST.graphCalls);
          costs[`${name}/${sample}`] = measured.cost;
        }
      }
      return costs;
    };

    let head = composition.revision,
      count = 0,
      preparationMs = 0;
    let firstPost: { post: string; occurrence: string } | undefined;
    let smallCosts: Awaited<ReturnType<typeof measureReads>> | undefined;
    for (const chapters of [10, 1000]) {
      const started = performance.now();
      // Every Post still comes from Studio's guarded chapter command; no raw graph shortcut or batching.
      for (; count < chapters; count++) {
        if (preparationMs + performance.now() - started >= 600_000) {
          throw new Error('Chapter preparation exceeded ten minutes');
        }
        const chapter = await json<{
          post: string;
          occurrence: string;
          compositionRevision: string;
        }>(
          await send(`/v1/works/${short(book.work)}/chapters`, {
            profile: 'book-chapter-create-v1',
            title: `Chapter ${count + 1}`,
            language: 'en',
            direction: 'ltr',
            parent: composition.structure,
            position: 'last',
            expectedCompositionHead: head,
            actingSubject: actor,
          }),
        );
        head = chapter.compositionRevision;
        firstPost ??= chapter;
      }
      preparationMs += performance.now() - started;
      console.info(
        `Post scale ${chapters} chapters command preparation: ${Math.round(preparationMs)} ms cumulative`,
      );
      expect(preparationMs).toBeLessThan(600_000);
      const inventory = await stack.fuseki
        .query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT (COUNT(DISTINCT ?work) AS ?works) (COUNT(DISTINCT ?post) AS ?posts) (COUNT(DISTINCT ?main) AS ?mains) WHERE {
          GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork . ?main a rv:MainVersion . ?post a rv:Post . }
        }`);
      expect(inventory.results?.bindings).toMatchObject([
        { works: { value: '1' }, posts: { value: String(chapters) }, mains: { value: '1' } },
      ]);
      if (!firstPost) throw new Error('Missing Studio chapter');
      if (chapters === 10) await member.grant(`work:read:${firstPost.post}`, 'work.read');
      await refreshProjections(chapters);
      const costs = await measureReads(chapters, firstPost);
      if (smallCosts) expect(costs).toEqual(smallCosts);
      else smallCosts = costs;
    }
  } finally {
    await relay.end();
    await stack.stop();
  }
}, 600_000);
