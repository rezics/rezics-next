import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import { assertWorkCost, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import type { ResourceListQuery } from '../../../services/main/src/modules/query/resource-contract.ts';

interface Page {
  items: { id: string; types: string[]; name: { value: string }; work?: unknown }[];
  nextCursor: string | null;
  complete: boolean;
  stale: boolean;
  count: { value: number; kind: string };
}

/** Adversarial diagnostics. First-after-write is application-cold, not a cold
 * JVM/OS cache; catalogue-scale preparation is a separate public-API profile. */
test('G1032: dense/negated Query has fixed calls and advancing partial pages with private, disclosure and stale state', async () => {
  let restored: Awaited<ReturnType<typeof import('../../../scripts/load/catalogue-backup.ts')['restoreCatalogueBackup']>> | undefined;
  const corpus = Bun.env.G1032_BACKUP ? JSON.parse(readFileSync(resolve(dirname(Bun.env.G1032_BACKUP), 'corpus.json'), 'utf8')) as {
    scale: number; catalogueWorksIncludingSamples: number; definitions: { concept: string; sense: string }[] } : undefined;
  if (Bun.env.G1032_BACKUP) {
    const { restoreCatalogueBackup } = await import('../../../scripts/load/catalogue-backup.ts');
    const target = `g1032-restore-${randomUUID().slice(0, 8)}`;
    restored = await restoreCatalogueBackup(Bun.env.G1032_BACKUP, target);
    Object.assign(process.env, restored.apps, { REZICS_QA_RUN_ID: target });
  }
  const sink = startWorkProfileSink({ settleMs: 50 });
  startTelemetry('g-1032-query', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  // pg must load after telemetry installs its hooks. A static fixture import
  // reports a misleading zero SQL spans even while the direct meter sees work.
  const { startHomeStack, meterStatements } = await import('./feed-read-support.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { DiscoveryProjection } =
    await import('../../../services/main/src/modules/discovery/store.ts');
  const { AccessPolicyOwner } =
    await import('../../../services/main/src/modules/access/policy-owner.ts');
  const { backfillPublicNames } =
    await import('../../../services/main/src/modules/search/names.ts');
  const { RESOURCE_LIST_COST } =
    await import('../../../services/main/src/modules/query/resource-contract.ts');
  const { MANAGE_SCOPE, MANAGE_ACTION } =
    await import('../../../services/main/src/modules/recommendation/derived-generation.ts');
  const { configureDisclosure, DisclosureStore } =
    await import('../../../services/main/src/modules/disclosure/read.ts');
  const home = await startHomeStack('g-1032-query', restored ? { projectionStart: 'current' } : {});
  const { stack, author, reader } = home;
  const projection = new DiscoveryProjection(stack.accessPool);
  const account = home.deps.account;
  let accountChecks = 0,
    privateReads = 0;
  const deps = {
    ...home.deps,
    discovery: projection,
    accessPolicy: new AccessPolicyOwner(stack.accessPool),
    account: {
      ...account,
      verify: async (...args: Parameters<typeof account.verify>) => {
        accountChecks++;
        return account.verify(...args);
      },
    },
  };
  const app = createMainApp(stack.fuseki, deps);
  configureDisclosure(stack.env, new DisclosureStore(stack.accessPool));
  const sql = meterStatements();
  const evidence: Record<string, unknown>[] = [];
  const baseline = Bun.env.G1032_BASELINE === '1';
  const started = performance.now();
  const token = `g1032${randomUUID().replaceAll('-', '')}`;
  const works: { work: string; mainVersion: string }[] = [];
  const definitions: { concept: string; sense: string }[] = corpus?.definitions ?? [];
  const call = (query: ResourceListQuery, bearer?: string, headers = new Headers()) => {
    headers.set('content-type', 'application/json');
    headers.set('accept-language', 'en');
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    return app.handle(
      new Request('http://main.local/v1/query', {
        method: 'POST',
        headers,
        body: JSON.stringify(query),
      }),
    );
  };
  const command = async <T>(path: string, body: unknown, expected = 200) =>
    home.json<T>(
      await app.handle(
        new Request(`http://main.local${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${author.token}`,
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      ),
      expected,
    );
  const refresh = async () => {
    let row = await command<{ generation: string; checkpoint: string; complete: boolean }>(
      '/v1/discovery/generation-builds',
      {
        profile: 'discovery-generation-build-v1',
        actingSubject: author.actor,
        basis: { scope: 'global', realm: null, context: null },
      },
    );
    while (!row.complete)
      row = await command(`/v1/discovery/generations/${row.generation}/advance`, {
        actingSubject: author.actor,
        expectedCheckpoint: row.checkpoint,
      });
    const head = await home.json<{ activeHeadRevision: string | null }>(
      await app.handle(
        new Request(
          `http://main.local/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(author.actor)}`,
          { headers: { authorization: `Bearer ${author.token}` } },
        ),
      ),
    );
    await command('/v1/discovery/generation-activations', {
      profile: 'discovery-generation-activation-v1',
      actingSubject: author.actor,
      generation: row.generation,
      expectedHeadRevision: head.activeHeadRevision,
    });
  };
  const type = { facet: 'type', any: ['https://schema.org/CreativeWork'] };
  const base: ResourceListQuery = {
    profile: 'resource-list-v1',
    context: 'global',
    scope: { kind: 'all' },
    sort: 'relevance',
    q: token,
    limit: 3,
    filter: { all: [type] },
  };
  try {
    await author.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await author.grant('classification:define:global', 'classification.proposition.define');
    await author.grant('classification:decide:global', 'classification.decision.set');
    for (let index = definitions.length; index < 8; index++)
      definitions.push(
        await command(
          '/v1/classification-vocabulary',
          {
            profile: 'classification-proposition-v2',
            scheme: null,
            labels: [{ language: 'en', value: `${token} topic ${index}` }],
            alternativeLabels: [],
            broader: [],
            narrower: [],
            actingSubject: author.actor,
          },
          201,
        ),
      );
    await author.grant('work:create:catalogue-import', 'work.create');
    // Exactly the same adversarial distribution, created in independent items
    // under the real public import capability rather than 544 fixture commits.
    for (let start = 0; start < 136; start += 128) {
      const items = Array.from({ length: Math.min(128,136-start) }, (_, offset) => {
        const index = start + offset;
        return { key: randomUUID(), input: { profile: 'work-catalogue-import-v1', expectedWorkHead: null,
          title: `${token} common ${index}`, language: 'en', evidence: 'G1032 dense/negated query fixture',
          aliases: [], semanticTypes: [], credits: [],
          classifications: (index === 135 ? definitions.slice(0,8) : index >= 4 ? definitions.slice(0,1) : [])
            .map(row => ({ sense: row.sense,
              expectedSenseHead: (corpus?.definitions as unknown as { definitionRevision: string }[] | undefined)?.[definitions.indexOf(row)]?.definitionRevision,
              expectedDecisionHead: null, outcome: 'accepted' })) } };
      });
      // Definition pins come from the owning vocabulary response/read, including
      // the legacy fixture response whose local type omitted that field.
      for (const item of items) for (const row of item.input.classifications) if (!row.expectedSenseHead) {
        const head = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
          GRAPH <urn:rezics:graph:current> { <${row.sense}> rv:head ?head } } LIMIT 2`);
        row.expectedSenseHead = head.results!.bindings[0]!.head!.value;
      }
      const imported = await command<{ items: { status: string; receipt: { work: string; mainVersion: string } }[] }>('/v1/work-imports/bulk', {
        actingSubject: author.actor, items });
      expect(imported.items.every(row => row.status === 'succeeded')).toBe(true);
      works.push(...imported.items.map(row => row.receipt));
    }
    const privateWork = await stack.privateWork(reader.actor, `${token} common private`);
    // A real grant to this bearer must never enter a public catalogue plan.
    await reader.grant(`work:read:${privateWork.work}`, 'work.read');
    // Background private episodes grow the reader's authority inventory while
    // the public read must issue zero private-membership/proof lookups.
    const privateOwners = Array.from(
      { length: 256 },
      () => `https://rezics.com/id/${randomUUID()}`,
    );
    await stack.accessPool.query(
      `INSERT INTO access.authority_subject(id,kind)
      SELECT owner,'agent' FROM unnest($1::text[]) owners(owner)`,
      [privateOwners],
    );
    await stack.accessPool.query(
      `INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision)
      SELECT 'realm',owner,1,'g1032-private-terms' FROM unnest($1::text[]) owners(owner)`,
      [privateOwners],
    );
    const episodes = privateOwners.map((owner) => ({
      owner,
      consent: randomUUID(),
      membership: randomUUID(),
    }));
    await stack.accessPool.query(
      `INSERT INTO access.private_membership_consent
      (id,principal_id,principal_epoch,kind,owner_subject,policy_revision,terms_revision,next_generation,expires_at)
      SELECT consent::uuid,$2,0,'realm',owner,1,'g1032-private-terms',1,now() + interval '5 minutes'
      FROM jsonb_to_recordset($1::jsonb) episodes(owner text,consent text)`,
      [JSON.stringify(episodes), reader.principalId],
    );
    await stack.accessPool.query(
      `INSERT INTO access.private_membership
      (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
      SELECT membership::uuid,'realm',owner,$2,'joined',1,1,'g1032-private-terms',consent::uuid
      FROM jsonb_to_recordset($1::jsonb) episodes(owner text,consent text,membership text)`,
      [JSON.stringify(episodes), reader.principalId],
    );
    const canReadWork = stack.access.canReadWork.bind(stack.access);
    stack.access.canReadWork = async (...args) => {
      privateReads++;
      return canReadWork(...args);
    };
    const realmProof = stack.access.realmReadProof.bind(stack.access);
    stack.access.realmReadProof = async (...args) => {
      privateReads++;
      return realmProof(...args);
    };
    await backfillPublicNames(stack.env);
    await refresh();
    const measured = async (name: string, query: ResourceListQuery, bearer?: string) => {
      const captured: string[] = [];
      let candidates = 0,
        seekRows = 0,
        cardWorks = 0;
      const native = stack.fuseki.query.bind(stack.fuseki);
      const seek = projection.resourcePage.bind(projection);
      const membership = projection.resourceMembership.bind(projection);
      const payloads = projection.resourceCardPayloads.bind(projection);
      const beforeSql = sql.count(),
        beforeAccount = accountChecks,
        beforePrivate = privateReads;
      stack.fuseki.query = async (...args) => {
        captured.push(args[0]);
        return native(...args);
      };
      projection.resourcePage = async (...args) => {
        const rows = await seek(...args);
        seekRows += rows.length;
        return rows;
      };
      projection.resourceMembership = async (...args) => {
        candidates += args[1].length;
        return membership(...args);
      };
      projection.resourceCardPayloads = async (...args) => {
        cardWorks += args[1].length;
        return payloads(...args);
      };
      try {
        const { result, profile } = await profileRequest(
          sink,
          async (headers) => {
            const response = await call(query, bearer, headers);
            const text = await response.text();
            expect(response.status, text).toBe(200);
            return (JSON.parse(text) as { result: Page }).result;
          },
          {
            service: 'g-1032-query',
            peers: { fuseki: Bun.env.FUSEKI_URL! },
            flush: flushTelemetryTraces,
          },
        );
        const statements = sql.count() - beforeSql;
        evidence.push({
          name,
          viewer: bearer ? 'signed' : 'anonymous',
          query,
          returned: result.items.length,
          complete: result.complete,
          stale: result.stale,
          count: result.count,
          candidates,
          seekRows,
          cardWorks,
          statements,
          accountChecks: accountChecks - beforeAccount,
          privateReads: privateReads - beforePrivate,
          ...Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'spans')),
          queries: captured,
        });
        expect(result.items.map((item) => item.id)).not.toContain(privateWork.work);
        expect(privateReads - beforePrivate).toBe(0);
        expect(accountChecks - beforeAccount).toBe(bearer ? 1 : 0);
        if (!baseline) {
          assertWorkCost(profile, {
            fusekiRequests: RESOURCE_LIST_COST.graphCalls,
            postgresStatements: 160,
            fusekiReceivedBytes: 1024 * 1024,
            fusekiSentBytes: 256 * 1024,
          });
          expect(profile.postgresStatements).toBeGreaterThan(0);
          expect(candidates).toBeLessThanOrEqual(RESOURCE_LIST_COST.candidates);
          expect(seekRows).toBeLessThanOrEqual(3 * 65);
          expect(cardWorks).toBeLessThanOrEqual(query.limit ?? 20);
          expect(statements).toBeLessThanOrEqual(160);
          expect(captured.filter((text) => text.includes('SELECT ?r ?concept'))).toHaveLength(0);
          expect(
            captured.filter((text) => text.includes('SELECT DISTINCT ?r ?type WHERE')),
          ).toHaveLength(0);
          expect(
            captured.filter((text) => text.includes('SELECT ?concept ?realm ?sense')),
          ).toHaveLength(
            query.filter?.all.some((node) => 'facet' in node && node.facet === 'concept') ? 1 : 0,
          );
        }
        return result;
      } finally {
        stack.fuseki.query = native;
        projection.resourcePage = seek;
        projection.resourceMembership = membership;
        projection.resourceCardPayloads = payloads;
      }
    };
    for (const bearer of [undefined, reader.token]) {
      const largePage = await measured('dense-64-card-page', { ...base, limit: 64 }, bearer);
      expect(largePage.items).toHaveLength(64);
      for (const sort of ['relevance', 'newest', 'updated'] as const) {
        const query = { ...base, sort };
        const first = await measured(`dense-${sort}-first-after-writes`, query, bearer);
        const warm = await measured(`dense-${sort}-warm`, query, bearer);
        expect(first.items).toEqual(warm.items);
        expect(first.items).toHaveLength(3);
        expect(first.complete).toBe(false);
        const second = await measured(
          `dense-${sort}-continuation`,
          { ...query, cursor: first.nextCursor! },
          bearer,
        );
        expect(second.items).toHaveLength(3);
        expect(
          second.items.every((item) => !first.items.some((prior) => prior.id === item.id)),
        ).toBe(true);
      }
      const excluded: ResourceListQuery = {
        ...base,
        q: undefined,
        sort: 'newest',
        filter: { all: [type, { facet: 'concept', none: definitions.map((row) => row.concept) }] },
      };
      const first = await measured('dense-eight-exclusions-first', excluded, bearer);
      if (!baseline) {
        expect(first.items).toHaveLength(0);
        expect(first.complete).toBe(false);
        expect(first.count).toEqual({ value: 0, kind: 'at-least' });
        expect(first.nextCursor).not.toBeNull();
      }
      const seen = new Set(first.items.map((item) => item.id));
      let cursor = first.nextCursor;
      for (let page = 0; cursor && page < Math.ceil(((corpus?.catalogueWorksIncludingSamples ?? 0) + 136) / RESOURCE_LIST_COST.candidates) + 4; page++) {
        const next = await measured(
          `dense-eight-exclusions-page-${page + 2}`,
          { ...excluded, cursor },
          bearer,
        );
        for (const item of next.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        expect(next.nextCursor).not.toBe(cursor);
        cursor = next.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual(new Set(works.slice(0, 4).map((row) => row.work)));
      for (const sort of ['relevance', 'newest', 'updated'] as const) {
        const result = await measured(
          `include-plus-exclude-${sort}`,
          {
            ...base,
            sort,
            filter: {
              all: [
                type,
                { facet: 'concept', all: [definitions[0]!.concept] },
                { facet: 'concept', none: definitions.slice(1).map((row) => row.concept) },
              ],
            },
          },
          bearer,
        );
        expect(result.items).toHaveLength(3);
        expect(result.items.some((item) => item.id === works[135]!.work)).toBe(false);
      }
    }
    const beforeWrite = await measured('cursor-before-write', base, reader.token);
    await stack.publicWork(author.actor, ['en'], `${token} stale-new`);
    const stale = await measured('stale-projection', base, reader.token);
    expect(stale.stale).toBe(true);
    expect(stale.complete).toBe(false);
    await refresh();
    const disclosure = new DisclosureStore(stack.accessPool);
    let denied = new Set<string>();
    configureDisclosure(stack.env, {
      read: async (targets, viewer, channel) => {
        const decisions = await disclosure.read(targets, viewer, channel);
        return targets.map((target, index) =>
          denied.has(target.resource) ? 'hidden' : decisions[index]!,
        );
      },
    });
    const visible = await measured('disclosure-before', { ...base, q: undefined, sort: 'newest' });
    denied = new Set(visible.items.map((item) => item.id));
    const filtered = await measured(
      'disclosure-after',
      { ...base, q: undefined, sort: 'newest' },
      reader.token,
    );
    expect(filtered.items).toHaveLength(3);
    expect(filtered.items.every((item) => !denied.has(item.id))).toBe(true);
    if (!baseline) {
      denied = new Set();
      const payloads = projection.resourceCardPayloads.bind(projection);
      projection.resourceCardPayloads = async (...args) => {
        const rows = await payloads(...args);
        denied = new Set(args[1]);
        return rows;
      };
      const revoked = await measured('disclosure-revoked-during-preview', {
        ...base,
        q: undefined,
        sort: 'newest',
      });
      expect(revoked.items).toHaveLength(0);
      expect(revoked.complete).toBe(false);
      expect(revoked.count).toEqual({ kind: 'at-least', value: 0 });
      // Shared Discover previews use resourceCards' default page mode. They
      // need the same post-preview revocation fence as the enclosing Query.
      denied = new Set();
      const { publicWorkRead } =
        await import('../../../services/main/src/modules/work/read-session.ts');
      const { resourceCards } =
        await import('../../../services/main/src/modules/query/resources.ts');
      const cards = await publicWorkRead(
        deps,
        new Request('http://main.internal/g1032-cards'),
        {},
        (session) =>
          resourceCards(session, [
            { id: works[0]!.work, summary: works[0]!.work, kind: 'work', order: '' },
          ]),
      );
      expect(cards).toHaveLength(0);
      projection.resourceCardPayloads = payloads;
    }
    expect((await call({ ...base, cursor: beforeWrite.nextCursor! }, reader.token)).status).toBe(
      409,
    );
    if (!baseline) {
      // A cached readiness proof cannot survive a process restart. Inject the
      // changed health identity after the native collector, then require the
      // owning final fence to refuse delivery (no native service is restarted).
      const health = stack.fuseki.commandHealth.bind(stack.fuseki);
      const native = stack.fuseki.query.bind(stack.fuseki);
      let collected = false;
      stack.fuseki.query = async (...args) => {
        const result = await native(...args);
        if (args[0].includes('BIND(rv:rankedText(rv:publicTitle')) collected = true;
        return result;
      };
      stack.fuseki.commandHealth = async () => {
        const current = await health();
        return collected ? { ...current, instanceId: randomUUID() } : current;
      };
      try {
        expect((await call(base)).status).toBe(503);
      } finally {
        stack.fuseki.commandHealth = health;
        stack.fuseki.query = native;
      }
    }
    expect(performance.now() - started).toBeLessThan(600_000);
  } finally {
    writeFileSync(
      join(Bun.env.REZICS_QA_ARTIFACT_DIR!, `g-1032-query-${baseline ? 'before' : 'after'}.json`),
      JSON.stringify(
        {
          evidence, catalogueScale: corpus?.scale ?? null, restoreMs: restored?.elapsedMs ?? null,
          elapsedMs: performance.now() - started,
          unobserved: [
            'native Lucene postings visited',
            'storage-cold JVM/OS caches',
            ...(corpus ? ['catalogue scale 50000', '128/512 vocabulary scale probe'] : ['catalogue scales 1000/10000/50000']),
            'real Account service calls (fixture counts verify invocations)',
          ],
        },
        null,
        2,
      ),
    );
    sql.restore();
    await home.stop();
    await shutdownTelemetry();
    await sink.stop();
    await restored?.stop();
  }
}, 420_000);
