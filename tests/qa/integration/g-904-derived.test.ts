import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { unlink } from 'node:fs/promises';
import { createMainApp } from '../../../services/main/src/app.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import type { ReadRankingProjection } from '../../../services/main/src/modules/rankings/projection.ts';
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

type Page = {
  items: { id: string; work?: string; chapterCount?: number | null; wordCount?: number | null }[];
  nextCursor: string | null;
  count: { value: number };
};
const native = () => `https://rezics.com/id/${randomUUID()}`;
const short = (ref: string) => ref.slice(-36);

test('G-904: derived HTTP inventories, pages, continuations and counts admit only current readable targets', async () => {
  const home = await startHomeStack('g904derived');
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
    const scores = works.map((work, index) => ({
      work: work.work,
      score: String(100 - index),
      growth: '1',
    }));
    const rankings = {
      current: async () => ({
        generation: 'g904',
        contentEpoch: 'content',
        contentSequence: '1',
        graphEpoch: home.stack.env.lineage.dataEpoch,
        reviewPosition: '0',
      }),
      candidates: async (
        _generation: string,
        _metric: string,
        _interval: string,
        _bucket: string,
        _order: string,
        after: { value: string; work: string } | null,
        limit: number,
      ) =>
        scores
          .filter(
            (row) =>
              !after ||
              Number(row.score) < Number(after.value) ||
              (row.score === after.value && row.work > after.work),
          )
          .slice(0, limit),
    } as unknown as ReadRankingProjection;
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
            isbn13: '9780316371247',
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
    for (const signed of [false, true]) {
      for (const path of inventoryPaths) {
        const page = await json<Page>(await get(path, signed));
        expect(page.items.map((item) => item.id).sort(), path).toEqual(
          [publicWork.work, other.work].sort(),
        );
        expect(page.count.value, path).toBe(2);
        expect(page.nextCursor, path).toBeNull();
      }
      const decisions = await json<Page>(
        await get(`/v1/realms/${short(seeded.realm.realm)}/decisions?limit=2`, signed),
      );
      expect(decisions.items.map((item) => item.work).sort()).toEqual(
        [publicWork.work, other.work].sort(),
      );
      expect(decisions.count.value).toBe(2);
      expect(decisions.nextCursor).toBeNull();
      const lists = await json<Page>(
        await get(`/v1/agents/${short(seeded.author)}/collections?limit=2`, signed),
      );
      expect(lists.items.map((item) => item.id)).toEqual(collections.slice(1));
      expect(lists.nextCursor).toBeNull();
      for (const path of [
        `/v1/works/${short(publicWork.work)}/releases?limit=2`,
        '/v1/releases?isbn13=9780316371247&limit=2',
      ]) {
        const page = await json<Page>(await get(path, signed));
        expect(
          page.items.map((item) => item.id),
          path,
        ).toEqual(releases.slice(1));
        expect(page.count.value).toBe(2);
        expect(page.nextCursor).toBeNull();
      }
      const denied = await get(
        `/v1/works/${short(publicWork.work)}/releases/${short(releases[0]!)}`,
        signed,
      );
      const absent = await get(
        `/v1/works/${short(publicWork.work)}/releases/${short(native())}`,
        signed,
      );
      expect(denied.status).toBe(404);
      expect(await denied.text()).toBe(await absent.text());
      const sitemap = await json<{ entries: { reference: string }[]; next: string | null }>(
        await get('/v1/sitemap', signed),
      );
      expect(sitemap.entries.map((item) => item.reference)).not.toContain(hidden.work);
      expect(sitemap.entries.map((item) => item.reference)).toContain(publicWork.work);
      expect(sitemap.next).toBeNull();
      const relationsPage = await json<{ items: { relation: string }[]; next: string | null }>(
        await get(`/v1/resources/${short(publicWork.work)}/relations?limit=1`, signed),
      );
      expect(relationsPage.items.map((item) => item.relation)).toEqual([relations[1]!]);
      expect(relationsPage.next).toBeNull();
    }
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
    expect(candidates.candidates.map((item) => item.work)).not.toContain(hidden.work);
    expect(candidates.candidates.map((item) => item.work)).toContain(publicWork.work);
    // A fixed read-model cut stays unchanged while the independent assessment
    // owner restricts a child. The HTTP Work header must fence its cached totals.
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
      const header = await json<{
        chapterCount: number | null;
        wordCount: number | null;
        lastUpdatedAt: string | null;
      }>(await get(`/v1/works/${short(publicWork.work)}`, signed));
      expect(header).toMatchObject({ chapterCount: null, wordCount: null, lastUpdatedAt: null });
    }
    await rate(child, []);
    expect(
      (
        await json<{ chapterCount: number }>(
          await get(`/v1/works/${short(publicWork.work)}`, false),
        )
      ).chapterCount,
    ).toBe(1);
    await rate(hidden.work, []);
    expect((await json<Page>(await get(inventoryPaths[0]!, false))).nextCursor).not.toBeNull();
  } finally {
    await home.stop();
  }
}, 240_000);
