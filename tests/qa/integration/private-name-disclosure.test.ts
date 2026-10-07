import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, sha } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import {
  PersonPreferencesStore,
  DEFAULT_PERSON_CHOICES,
} from '../../../services/main/src/modules/preferences/store.ts';
import { namePreferencesProjection } from '../../../services/main/src/modules/search/name-preferences.ts';
import {
  DisclosureStore,
  configureDisclosure,
} from '../../../services/main/src/modules/disclosure/read.ts';
import { discloseSearchMatches } from '../../../services/main/src/modules/disclosure/search.ts';
import { assembleSitemapEntries } from '../../../services/main/src/modules/disclosure/sitemap.ts';
import {
  disclosureViewer,
  withDisclosureViewer,
} from '../../../services/main/src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import { readResourceSummaries } from '../../../services/main/src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { discloseExportPlan } from '../../../services/main/src/modules/export/readers.ts';
import { planExport } from '../../../services/main/src/modules/export/planner.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';

test('Private profile names are omitted by anonymous search, export and sitemap, remain readable by controllers and return when public', async () => {
  const s = await startMediaStack('private-name-disclosure');
  try {
    const owner = await s.member('name-controller'),
      stranger = await s.member('name-stranger');
    const principal = { ...owner.principal, emailVerified: true };
    const marker = `Private name ${randomUUID()}`;
    const governance = new GovernanceStore(
      s.accessPool,
      {
        capture: async () => {
          throw new Error('This read fixture captures no evidence');
        },
      },
      { current: async () => null },
      new GovernanceRules(s.accessPool),
    );
    const app = createMainApp(s.fuseki, {
      environment: s.env,
      access: s.access,
      account: { verify: async () => principal },
      agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      governance: { store: governance, rules: new GovernanceRules(s.accessPool) },
      media: s.media,
      personPreferences: new PersonPreferencesStore(s.accessPool),
    });
    const created = await app.handle(
      new Request('http://main.local/v1/agents', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner.token}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          profile: 'agent-provision-v1',
          kind: 'person',
          displayName: marker,
        }),
      }),
    );
    const body = (await created.json()) as { agent: string };
    expect(created.status, JSON.stringify(body)).toBe(201);
    const agent = body.agent;
    configureDisclosure(s.env, new DisclosureStore(s.accessPool));
    const preferences = new PersonPreferencesStore(s.accessPool, namePreferencesProjection(s.env));
    const head = (
      await s.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(agent)} <${RV}head> ?head } }`)
    ).results?.bindings[0]?.head?.value;
    expect(head).toBeDefined();
    const candidates = [{ work: agent, matchedField: 'name', matchedText: marker }];
    const summary = (viewer = ANONYMOUS_VIEWER) =>
      readResourceSummaries(
        s.env,
        undefined,
        { viewer },
        { resources: [agent], context: DEFAULT_MEDIA_CONTEXT, language: null },
      );
    const plan = await planExport(
      {
        targetProfile: 'private-name-portable-v1',
        useScope: 'full',
        residuals: [],
        members: [
          {
            sourceOwner: 'graph',
            sourceNamespace: 'product',
            sourceGrain: 'work',
            exactRef: head!,
            contentRevisionId: null,
            refDigest: sha(marker),
            ownerDataEpoch: s.env.lineage.dataEpoch,
            ownerSequence: '1',
            sourcePosition: null,
            targetGrain: 'Agent',
            mapping: 'exact',
            value: { kind: 'text', lexical: marker, language: null },
            data: { work: agent, name: marker },
          },
        ],
      },
      async () => [],
    );
    const publicReaders = async (visible: boolean) => {
      const indexed =
        (
          await s.fuseki.query(`PREFIX rv: <${RV}> SELECT ?name WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:PublicNameMatchUnit ;
          rv:resource ${iri(agent)} ; rv:publicTitle ?name } } LIMIT 65`)
        ).results?.bindings ?? [];
      expect(indexed.map((row) => row.name?.value)).toEqual(visible ? [marker] : []);
      expect(
        await new DisclosureStore(s.accessPool).read(
          [{ owner: 'graph', resource: agent, component: 'name' }],
          ANONYMOUS_VIEWER,
          'read',
        ),
      ).toEqual([visible ? 'visible' : 'hidden']);
      const queried = await app.handle(
        new Request('http://main.local/v1/queries', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            profile: 'public-disclosed-fields-phrase-v1',
            phrase: marker,
            resources: [agent],
            contexts: [],
            statements: [],
            mediaContext: DEFAULT_MEDIA_CONTEXT,
            language: null,
          }),
        }),
      );
      const queriedBody = await queried.json();
      expect(queried.status, JSON.stringify(queriedBody)).toBe(200);
      expect(queriedBody).toMatchObject({
        total: visible ? 1 : 0,
        facets: { names: visible ? 1 : 0 },
      });
      expect(JSON.stringify(queriedBody).includes(marker)).toBe(visible);
      const search = await withDisclosureViewer(ANONYMOUS_VIEWER, () =>
        discloseSearchMatches(s.env, candidates),
      );
      expect(search).toHaveLength(visible ? 1 : 0);
      const sitemap = await assembleSitemapEntries(s.env, [{ reference: agent, revision: head! }]);
      expect(sitemap).toHaveLength(visible ? 1 : 0);
      const exported = await discloseExportPlan(s.env, plan, ANONYMOUS_VIEWER);
      expect(JSON.stringify(exported).includes(marker)).toBe(visible);
      if (!visible) expect(exported.members[0]?.data).toEqual({ omitted: 'disclosure_restricted' });
      const summaries = await summary();
      expect(summaries.summaries[0]?.status).toBe(visible ? 'available' : 'unavailable');
      expect(JSON.stringify(summaries).includes(marker)).toBe(visible);
    };
    await publicReaders(true);
    await preferences.write(
      principal,
      agent,
      { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' },
      0,
      randomUUID(),
    );
    await publicReaders(false);
    const authorized = disclosureViewer(principal, agent);
    expect((await summary(authorized)).summaries[0]).toMatchObject({
      status: 'available',
      name: { value: marker },
    });
    expect(JSON.stringify(await discloseExportPlan(s.env, plan, authorized))).toContain(marker);
    expect((await summary(disclosureViewer(stranger.principal, stranger.actor))).summaries).toEqual(
      [{ reference: agent, status: 'unavailable' }],
    );
    expect(
      await withDisclosureViewer(authorized, () => discloseSearchMatches(s.env, candidates)),
    ).toEqual([]);
    // There is no instant at which both gates below allow this occurrence:
    // the Work closes before the name becomes public. A second preference
    // query after an earlier Work snapshot would incorrectly disclose it.
    const work = await s.publicWork(owner.actor, ['en'], 'Name policy atomic cut');
    const gate = `work:read:${work.work}`;
    await s.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [gate],
    );
    let ownerStatements = 0;
    const measuredPool = new Proxy(s.accessPool, {
      get(target, property) {
        if (property === 'query')
          return async (...args: unknown[]) => {
            ownerStatements++;
            const result = await Reflect.apply(target.query, target, args);
            if (String(args[0]).includes('requested AS')) {
              expect(String(args[0])).toContain('name_policy AS MATERIALIZED');
              await s.accessPool.query(
                `UPDATE access.scope_gate SET open = false, dispatch_open = false,
            authority_epoch = authority_epoch + 1 WHERE id = $1`,
                [gate],
              );
              await preferences.write(principal, agent, DEFAULT_PERSON_CHOICES, 1, randomUUID());
            }
            return result;
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(
      await new DisclosureStore(measuredPool).read(
        [
          {
            owner: 'graph',
            resource: work.work,
            work: work.work,
            component: 'name',
            nameOwner: agent,
          },
        ],
        ANONYMOUS_VIEWER,
        'read',
      ),
    ).toEqual(['hidden']);
    expect(ownerStatements).toBe(1);
    await publicReaders(true);
    // Deactivating the principal must invalidate a previously trusted viewer too.
    await preferences.write(
      principal,
      agent,
      { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' },
      2,
      randomUUID(),
    );
    await s.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [
      owner.principalId,
    ]);
    expect((await summary(authorized)).summaries).toEqual([
      { reference: agent, status: 'unavailable' },
    ]);
  } finally {
    await s.stop();
  }
}, 180_000);
