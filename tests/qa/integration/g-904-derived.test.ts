import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { unlink } from 'node:fs/promises';
import { createMainApp } from '../../../services/main/src/app.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import { ReadRankingProjection, rankingBuckets } from '../../../services/main/src/modules/rankings/projection.ts';
import { refreshReadRankingAdmissions } from '../../../services/main/src/modules/feed/ranking-admission.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import {
  realmSelectionDigest,
  selectRealmLocal,
} from '../../../services/main/src/modules/work/select-realm.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import {
  relationLexiconSeedMapPath,
  seedRelationLexicon,
} from '../../../scripts/dev/seed/relation-lexicon.ts';
import { startHomeStack, seedHome } from './feed-read-support.ts';
import type { Labels } from '../../../services/main/src/modules/suitability/policy.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

type Page = {
  items: { id: string; work?: string; chapterCount?: number | null; wordCount?: number | null }[];
  nextCursor: string | null;
  count: { value: number };
};
const native = () => `https://rezics.com/id/${randomUUID()}`;
const short = (ref: string) => ref.slice(-36);

test('G-904: interactive derived inventories retain rated targets and enforce current Access fences; sitemap keeps anonymous suitability', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access', 'content', 'relay']);
  const original = [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL];
  let home: Awaited<ReturnType<typeof startHomeStack>>;
  try {
    // Own the ranking/serial inventories and project only this file's commands.
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] =
      [databases.urls.access, databases.urls.content, databases.urls.relay];
    home = await startHomeStack('g904derived', { projectionStart: 'current' });
  } catch (error) { await databases.close(); throw error; }
  finally {
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] = original;
  }
  try {
    const seeded = await seedHome(home, 3),
      works = seeded.works.toSorted((a, b) => a.work.localeCompare(b.work));
    const hidden = works[0]!,
      publicWork = works[1]!,
      other = works[2]!;
    const suitability = new SuitabilityStore(home.stack.accessPool, home.stack.access);
    const governance = new GovernanceStore(
      home.stack.accessPool,
      {
        capture: async () => {
          throw new Error('Evidence capture unused in this read test');
        },
      },
      { current: async () => null },
      { current: async () => null },
    );
    // Production seeks the admitted score index. A raw-score double would
    // keep returning a revoked Work and correctly trigger the reader's stale
    // admission fence instead of exercising the SQL revocation triggers.
    const rankings = new ReadRankingProjection(home.stack.accessPool, home.stack.content,
      home.stack.contentPool, home.stack.env);
    for (let tick = 0; tick < 100; tick++) {
      if (!await rankings.tick()) break;
      if (tick === 99) throw new Error('Ranking fixture did not catch up with its owner events');
    }
    const rankingCheckpoint = await rankings.current();
    const rankingBucket = rankingBuckets(new Date(), 'week').current;
    await home.stack.accessPool.query(`INSERT INTO access.read_ranking_score
      (generation,metric,interval,bucket,work,score,growth)
      SELECT $1,'reads','week',$2,work,score,score FROM unnest($3::text[],$4::bigint[]) AS scores(work,score)`,
    [rankingCheckpoint.generation, rankingBucket, works.map(work => work.work), works.map((_, index) => 100 - index)]);
    await refreshReadRankingAdmissions(home.stack.env, home.stack.accessPool, works.map(work => work.work));
    // Numeric keysets and ordering must agree across a digit boundary. The
    // response's text aliases must not rank 99 ahead of 100 for either order.
    for (const order of ['score', 'growth'] as const) {
      const first = await rankings.candidates(rankingCheckpoint.generation, 'reads', 'week', rankingBucket, order, null, 2);
      expect(first).toHaveLength(2);
      const last = first.at(-1)!;
      const second = await rankings.candidates(rankingCheckpoint.generation, 'reads', 'week', rankingBucket, order,
        { value: last[order], work: last.work }, 2);
      expect([...first, ...second].map(row => row.work)).toEqual(works.map(work => work.work));
    }
    let graphSequence = '0';
    const serial = new SerialStatisticsProjection(
      home.stack.accessPool,
      { query: async () => ({ rows: [{ sequence: graphSequence }] }) } as unknown as Pool,
      home.stack.contentPool,
      home.stack.env,
    );
    const app = createMainApp(home.stack.fuseki, {
      ...home.deps,
      suitability,
      governance: { store: governance },
      readRankings: rankings,
      serialStats: serial,
      catalogueIntake: new CatalogueIntakeStore(home.stack.accessPool, home.stack.env),
    });
    const send = (method: string, path: string, body?: object, signed = false) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            ...(signed ? { authorization: `Bearer ${home.author.token}` } : {}),
            ...(body
              ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() }
              : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const json = home.json;
    const get = (path: string, signed: boolean) => {
      const url = new URL(path, 'http://main.local');
      if (signed && url.pathname !== '/v1/sitemap' && !url.pathname.startsWith('/v1/rankings/'))
        url.searchParams.set('actingSubject', seeded.author);
      return send('GET', `${url.pathname}${url.search}`, undefined, signed);
    };
    const grant = async (scope: string, action: string) => {
      await home.stack.accessPool.query(
        'INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await home.stack.accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), home.author.principalId, seeded.author, action],
      );
      await home.stack.accessPool.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), seeded.author, scope, action],
      );
    };
    const readFence = async (work: string, open: boolean) => {
      const changed = await home.stack.accessPool.query(`INSERT INTO access.scope_gate(id,open)
        VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET open = EXCLUDED.open`, [`work:read:${work}`, open]);
      expect(changed.rowCount).toBe(1);
    };
    for (const work of works) {
      await grant(`work:edit:${work.work}`, 'work.edit');
      const head = (
        await json<{ revision: string }>(await get(`/v1/works/${short(work.work)}`, true))
      ).revision;
      await json(
        await send(
          'POST',
          `/v1/works/${short(work.work)}/agent-credits`,
          {
            profile: 'native-agent-credit-v1',
            credit: native(),
            agent: seeded.author,
            role: 'author',
            expectedWorkHead: head,
            actingSubject: seeded.author,
          },
          true,
        ),
        201,
      );
      if (work.work !== seeded.works[0]!.work) {
        const input = {
          context: { kind: 'realm-local' as const, id: seeded.realm.realm },
          work: work.work,
          mainVersion: work.mainVersion,
          contribution: work.variants[0]!.contribution,
          publicationDecision: work.variants[0]!.decision,
          expectedSelectionHead: null,
          selectionBasis: 'realm-manager-review' as const,
          actingSubject: seeded.author,
        };
        expect(
          (
            await selectRealmLocal(
              home.stack.env,
              home.stack.admission(
                seeded.author,
                `publication:adopt:${seeded.realm.realm}`,
                'publication.adopt',
                realmSelectionDigest(input),
              ),
              input,
            )
          ).outcome,
        ).toBe('succeeded');
      }
    }
    const collections = (
      await json<Page>(await get(`/v1/agents/${short(seeded.author)}/collections`, false))
    ).items.map((item) => item.id);
    for (let n = 0; n < 2; n++) {
      const collection = native();
      collections.push(collection);
      await json(
        await send(
          'POST',
          '/v1/collections',
          {
            collection,
            name: `G904 list ${n}`,
            disclosure: 'public',
            actingSubject: seeded.author,
          },
          true,
        ),
        201,
      );
    }
    collections.sort();
    const releases: string[] = [];
    const isbnPrefix = `978${String(BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 1_000_000_000n).padStart(9, '0')}`;
    const isbn13 = `${isbnPrefix}${(10 - [...isbnPrefix].reduce((sum, digit, index) =>
      sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10}`;
    for (let n = 0; n < 3; n++) {
      const release = native();
      releases.push(release);
      await json(
        await send(
          'PUT',
          `/v1/works/${short(publicWork.work)}/releases/${short(release)}`,
          {
            profile: 'release-v1',
            id: release,
            expectedHead: null,
            actingSubject: seeded.author,
            kind: 'formal',
            status: 'official',
            contentLanguages: ['en'],
            isTranslation: false,
            originalLanguages: [],
            titleLanguage: 'en',
            tracklistLanguage: null,
            title: { value: `G904 release ${n}`, language: 'en' },
            editionStatement: null,
            publisher: null,
            publicationYear: 2026,
            isbn13,
            originalUrl: null,
            fixedRelease: null,
            coverage: null,
            evidence: null,
          },
          true,
        ),
      );
    }
    releases.sort();
    await grant('semantic:create:root', 'semantic.change');
    const existing = await readDefinitionByKey(home.stack.env, 'rewrite');
    let definition = existing && { component: existing.definition, revision: existing.revision };
    if (!definition) {
      const namespace = `g904-${randomUUID()}`;
      definition = (
        await seedRelationLexicon(
          {
            post: async <T>(path: string, body: object) =>
              json<T>(await send('POST', path, body, true), 201),
            authorizeDefinition: async (receipt) => {
              await grant(`semantic:read:${receipt.component}`, 'semantic.read');
              await grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
            },
          },
          seeded.author,
          namespace,
          relationLexiconSeed.filter((item) => item.key === 'rewrite'),
        )
      )[0]!;
      await unlink(relationLexiconSeedMapPath(namespace));
    }
    await grant(`semantic:read:${definition.component}`, 'semantic.read');
    const relations: string[] = [];
    for (let n = 0; n < 2; n++) {
      const relation = await json<{ occurrence: string }>(
        await send(
          'POST',
          '/v1/relations/changes',
          {
            profile: 'relation-change-v1',
            expectedHead: null,
            definition: definition.revision,
            participations: [
              { role: 'source', participant: { kind: 'resource', ref: other.work } },
              { role: 'rewrite', participant: { kind: 'resource', ref: publicWork.work } },
            ],
            evidence: `https://example.org/g904/${n}`,
            actingSubject: seeded.author,
          },
          true,
        ),
        201,
      );
      relations.push(relation.occurrence);
    }
    await home.author.grant('governance:platform', 'governance.moderate');
    const revisions = new Map<string, string>();
    const rate = async (target: string, labels: Labels) => {
      const result = await json<{ assessment: { revision: string } }>(
        await send(
          'PUT',
          `/v1/suitability/${short(target)}`,
          {
            actingSubject: home.author.actor,
            expectedRevision: revisions.get(target) ?? null,
            labels,
            basis: 'platform',
          },
          true,
        ),
      );
      revisions.set(target, result.assessment.revision);
    };
    await rate(hidden.work, ['r18']);
    await rate(releases[0]!, ['r18g']);
    // These inventory owners have no suitability command target grain yet.
    // Exercise their readers against stored assessment heads without adding a
    // new target binding or policy to this task.
    for (const target of [collections[0]!, relations[0]!]) {
      await home.stack.accessPool.query(
        `INSERT INTO access.suitability_assessment
        (id,target,labels,basis,assessor,principal_id,revision_number,authority_proof,idempotency_key,request_digest)
        SELECT $1,$2,labels,basis,assessor,principal_id,1,authority_proof,$3,request_digest
        FROM access.suitability_assessment WHERE target=$4 AND revision_number=1`,
        [randomUUID(), target, `g904-stored-${randomUUID()}`, hidden.work],
      );
    }
    const inventoryPaths = [
      `/v1/realms/${short(seeded.realm.realm)}/works?limit=2`,
      `/v1/agents/${short(seeded.author)}/works?limit=2`,
      '/v1/rankings/trending?limit=2',
    ];
    const pages = async (path: string, signed: boolean) => {
      const first = await json<Page>(await get(path, signed));
      expect(first.count.value, path).toBe(2);
      expect(first.nextCursor, path).not.toBeNull();
      const url = new URL(path, 'http://main.local');
      url.searchParams.set('cursor', first.nextCursor!);
      const second = await json<Page>(await get(`${url.pathname}${url.search}`, signed));
      expect(second.count.value, path).toBe(1);
      expect(second.nextCursor, path).toBeNull();
      return [...first.items, ...second.items];
    };
    // The October 2 maintainer contract treats ratings as presentation metadata
    // on interactive reads. They cannot replace Access authority or hide pages.
    for (const signed of [false, true]) {
      for (const path of inventoryPaths) {
        expect((await pages(path, signed)).map(item => item.id).sort(), path)
          .toEqual(works.map(work => work.work).sort());
      }
      expect((await pages(`/v1/realms/${short(seeded.realm.realm)}/decisions?limit=2`, signed))
        .map(item => item.work).sort()).toEqual(works.map(work => work.work).sort());
      expect((await pages(`/v1/agents/${short(seeded.author)}/collections?limit=2`, signed))
        .map(item => item.id).sort()).toEqual(collections);
      for (const path of [
        `/v1/works/${short(publicWork.work)}/releases?limit=2`,
        `/v1/releases?isbn13=${isbn13}&limit=2`,
      ]) {
        expect((await pages(path, signed)).map(item => item.id).sort(), path).toEqual(releases);
      }
      const rated = await json<{ id: string }>(await get(
        `/v1/works/${short(publicWork.work)}/releases/${short(releases[0]!)}`,
        signed,
      ));
      expect(rated.id).toBe(releases[0]);
      const absent = await get(
        `/v1/works/${short(publicWork.work)}/releases/${short(native())}`,
        signed,
      );
      expect(absent.status).toBe(404);
      const sitemap = await json<{ entries: { reference: string }[]; next: string | null }>(
        await get('/v1/sitemap', signed),
      );
      expect(sitemap.entries.map((item) => item.reference)).not.toContain(hidden.work);
      expect(sitemap.entries.map((item) => item.reference)).toContain(publicWork.work);
      expect(sitemap.next).toBeNull();
      const relationsPage = await json<{ items: { relation: string }[]; next: string | null }>(
        await get(`/v1/resources/${short(publicWork.work)}/relations?limit=1`, signed),
      );
      expect(relationsPage.items).toHaveLength(1);
      expect(relationsPage.next).not.toBeNull();
      const remainingRelations = await json<{ items: { relation: string }[]; next: string | null }>(
        await get(`/v1/resources/${short(publicWork.work)}/relations?limit=1&after=${encodeURIComponent(relationsPage.next!)}`, signed),
      );
      expect([...relationsPage.items, ...remainingRelations.items].map(item => item.relation).sort())
        .toEqual(relations.toSorted());
      expect(remainingRelations.next).toBeNull();
    }
    const assessments = await json<{ items: { target: { resource: string; base: string };
      assessment: { status: string; labels: string[] }; eligible: boolean }[] }>(
      await send('POST', '/v1/suitability/reads', { targets: [hidden.work, releases[0]!] }),
    );
    expect(assessments.items).toMatchObject([
      { target: { resource: hidden.work, base: 'work' }, assessment: { status: 'assessed', labels: ['r18'] }, eligible: false },
      { target: { resource: releases[0], base: 'release' }, assessment: { status: 'assessed', labels: ['r18g'] }, eligible: false },
    ]);
    const candidates = await json<{ candidates: { work: string }[] }>(
      await send(
        'POST',
        '/v1/catalogue/candidates',
        {
          profile: 'catalogue-candidates-v1',
          originalTitle: { value: hidden.title, language: 'en' },
          aliases: [{ value: publicWork.title, language: 'en' }],
          romanizations: [],
          creators: [],
          dates: [],
          identifiers: [],
        },
        true,
      ),
    );
    expect(candidates.candidates.map((item) => item.work)).toContain(hidden.work);
    expect(candidates.candidates.map((item) => item.work)).toContain(publicWork.work);
    // Ratings leave an interactive container's cached totals intact. An actual
    // Work read fence on a child must still suppress those totals at the same cut.
    graphSequence = (
      await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:sequence ?sequence } }`)
    ).results!.bindings[0]!.sequence!.value;
    const generation = randomUUID(),
      child = other.work,
      occurrence = native();
    await home.stack.accessPool.query(
      `INSERT INTO access.serial_stats_checkpoint(singleton,generation,graph_epoch,sequence)
      VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET generation=$1,graph_epoch=$2,sequence=$3`,
      [generation, home.stack.env.lineage.dataEpoch, graphSequence],
    );
    await home.stack.accessPool.query(
      `INSERT INTO access.serial_summary(generation,work,chapter_count,word_count,last_updated_at)
      VALUES($1,$2,1,8,now())`,
      [generation, publicWork.work],
    );
    await home.stack.accessPool.query(
      `INSERT INTO access.serial_chapter(generation,work,occurrence,resource)
      VALUES($1,$2,$3,$4)`,
      [generation, publicWork.work, occurrence, child],
    );
    for (const signed of [false, true])
      expect(
        (
          await json<{ chapterCount: number }>(
            await get(`/v1/works/${short(publicWork.work)}`, signed),
          )
        ).chapterCount,
      ).toBe(1);
    await rate(child, ['r15']);
    for (const signed of [false, true]) {
      expect(await json(await get(`/v1/works/${short(publicWork.work)}`, signed)))
        .toMatchObject({ chapterCount: 1, wordCount: 8 });
    }
    await readFence(child, false);
    for (const signed of [false, true]) {
      const header = await json<{
        chapterCount: number | null;
        wordCount: number | null;
        lastUpdatedAt: string | null;
      }>(await get(`/v1/works/${short(publicWork.work)}`, signed));
      expect(header).toMatchObject({ chapterCount: null, wordCount: null, lastUpdatedAt: null });
    }
    await readFence(child, true);
    await rate(child, []);
    expect(
      (
        await json<{ chapterCount: number }>(
          await get(`/v1/works/${short(publicWork.work)}`, false),
        )
      ).chapterCount,
    ).toBe(1);
    // Server authorization filters before counting and choosing continuations.
    await readFence(hidden.work, false);
    for (const signed of [false, true]) {
      for (const path of [...inventoryPaths, `/v1/realms/${short(seeded.realm.realm)}/decisions?limit=2`]) {
        const page = await json<Page>(await get(path, signed));
        expect(page.items.map(item => item.work ?? item.id).sort(), path)
          .toEqual([publicWork.work, other.work].sort());
        expect(page.count.value, path).toBe(2);
        expect(page.nextCursor, path).toBeNull();
      }
    }
    await readFence(hidden.work, true);
    expect((await json<Page>(await get(inventoryPaths[0]!, false))).nextCursor).not.toBeNull();
    await rate(hidden.work, []);
    const clearedSitemap = await json<{ entries: { reference: string }[] }>(await get('/v1/sitemap', false));
    expect(clearedSitemap.entries.map(item => item.reference)).toContain(hidden.work);
  } finally {
    try { await home.stop(); } finally { await databases.close(); }
  }
}, 240_000);
