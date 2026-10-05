import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { applyLnVnZones } from '../../../scripts/dev/seed/ln-vn-zones-step.ts';
import { SeedApi, type SeedEndpoints } from '../../../scripts/dev/seed/api.ts';
import { people, seedKey, works } from '../../../scripts/dev/seed/plan.ts';
import { seedWorks } from '../../../scripts/dev/seed/works-step.ts';
import type { SeedState, Session } from '../../../scripts/dev/seed/state.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import {
  relationLexiconSeedMapPath,
  seedRelationLexicon,
} from '../../../scripts/dev/seed/relation-lexicon.ts';
import { cataloguePlan, loadCatalogue, type CataloguePort } from '../../fixtures/catalogue/load.ts';
import { catalogueIntakePath } from '../../fixtures/catalogue/intake.ts';
import { SHOWCASE } from '../../fixtures/vndb/load.ts';
import { startMediaStack } from './media-support.ts';

test('G905: franchise fixture search-first intake replays every Work into the Light Novels Zone', async () => {
  const started = Date.now();
  const stack = await startMediaStack('g-905-catalogue');
  const namespace = `g905-${randomUUID()}`;
  let actor = '';
  try {
    const member = await stack.member('fixture-editor');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, {
      environment: stack.env,
      access: stack.access,
      media: stack.media,
      structureObjects: objects,
      catalogueIntake: new CatalogueIntakeStore(stack.accessPool, stack.env),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      libraryStatus: new ReaderLibraryStatusStore(stack.contentPool),
      libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      profiles: new ProfilesAccess(stack.accessPool),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      account: {
        verify: async (request) => {
          if (request.headers.get('authorization') !== `Bearer ${member.token}`)
            throw new AccountAssertionDenied('Unknown bearer');
          const verified = { ...member.principal, emailVerified: true as const };
          return { ...verified, currentAssertion: async () => verified };
        },
      },
    });
    const request: CataloguePort['request'] = async (method, path, body, key) => {
      const response = await app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            authorization: `Bearer ${member.token}`,
            'content-type': 'application/json',
            'idempotency-key': key ?? randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    };
    const provision = await request('POST', '/v1/agents', {
      profile: 'agent-provision-v1',
      kind: 'person',
      displayName: 'Catalogue editor',
    });
    expect(provision.status).toBe(201);
    actor = (provision.body as { agent: string }).agent;
    const grant: CataloguePort['grant'] = async (scope, action) => {
      await stack.accessPool.query(
        'INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await stack.accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        SELECT $1,$2,$3,$4,now() + interval '1 hour' WHERE NOT EXISTS (SELECT 1 FROM access.representation
          WHERE principal_id=$2 AND subject_id=$3 AND action=$4 AND active AND valid_until > now())`,
        [randomUUID(), member.principalId, actor, action],
      );
      await stack.accessPool.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        SELECT $1,$2,$2,$3,$4,now() + interval '1 hour' WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant
          WHERE recipient_subject=$2 AND scope_id=$3 AND action=$4 AND active AND valid_until > now())`,
        [randomUUID(), actor, scope, action],
      );
    };
    const port: CataloguePort = { actingSubject: actor, request, grant };
    const keys = [
      'rewrite',
      'reboot',
      'sequel',
      'spin-off',
      'adaptation',
      'credit-illustrator',
      'credit-concept-supervision',
    ];
    await grant('semantic:create:root', 'semantic.change');
    for (const key of keys) {
      const current = await readDefinitionByKey(stack.env, key, systemDisclosure);
      if (current) {
        await grant(`semantic:read:${current.definition}`, 'semantic.read');
        continue;
      }
      const definition = relationLexiconSeed.find((item) => item.key === key)!;
      await seedRelationLexicon(
        {
          post: async <T>(path: string, body: object, idempotency: string) => {
            const result = await request('POST', path, body, idempotency);
            if (result.status >= 400) throw new Error(`${path}: ${JSON.stringify(result)}`);
            return result.body as T;
          },
          authorizeDefinition: async (receipt) => {
            await grant(`semantic:read:${receipt.component}`, 'semantic.read');
            await grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
          },
        },
        actor,
        namespace,
        [{ ...definition, labels: definition.labels.filter((label) => label[0] === 'en') }],
      );
    }
    const first = await loadCatalogue(port);
    const second = await loadCatalogue({ ...port });
    expect(Object.keys(first.works)).toHaveLength(cataloguePlan().works.length);
    expect(second.createdWrites).toBe(0);
    const identities = (manifest: typeof first) =>
      Object.values(manifest.works).map((work) => [
        work.work,
        work.mainVersion,
        work.mainRevision,
        work.title,
      ]);
    expect(identities(second)).toEqual(identities(first));
    const searches = await stack.accessPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM quota.catalogue_creation WHERE principal_id=$1 AND quota_exempt',
      [member.principalId],
    );
    expect(Number(searches.rows[0]!.count)).toBe(cataloguePlan().works.length);
    const novel = first.works['sao.bunko']!;
    const zones = await applyLnVnZones({
      port,
      vnWorks: [{ vndb: SHOWCASE.vn, iri: novel.work }],
      showcaseIri: novel.work,
      extraBooks: [],
    });
    expect(zones.catalogueWorks).toEqual(Object.values(first.works).map((work) => work.work));
    const light = zones.zones.find((zone) => zone.id === 'light-novels')!;
    for (const work of Object.values(first.works)) expect(light.members).toContain(work.work);
    const route = await request(
      'GET',
      `/v1/zones/${light.zone.slice(-36)}/routes?path=${encodeURIComponent(`/catalogue/${novel.work.slice(-36)}`)}&actingSubject=${encodeURIComponent(actor)}`,
    );
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ kind: 'detail', resource: { id: novel.work } });
    expect(Date.now() - started).toBeLessThan(600_000);
  } finally {
    rmSync(relationLexiconSeedMapPath(namespace), { force: true });
    for (const item of cataloguePlan().works)
      rmSync(
        catalogueIntakePath(
          stack.env.lineage.dataEpoch,
          actor,
          `catalogue:v1:work:${item.id.toLowerCase()}`,
        ),
        { force: true },
      );
    await stack.stop();
  }
}, 420_000);

test('G905: demo restricted Work creation uses the administrator and preserves the plan author', async () => {
  const stack = await startMediaStack('g-905-seed', { profileCredits: true });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const members = await Promise.all(people.map((person) => stack.member(person.id)));
    const operator = await stack.member('administrator');
    const app = createMainApp(stack.fuseki, {
      environment: stack.env,
      access: stack.access,
      media: stack.media,
      profiles: new ProfilesAccess(stack.accessPool),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      account: {
        verify: async (request) => {
          const member = [...members, operator].find(
            (item) => request.headers.get('authorization') === `Bearer ${item.token}`,
          );
          if (!member) throw new AccountAssertionDenied('Unknown bearer');
          return member.principal;
        },
      },
    });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.handle(request) });
    const api = new SeedApi({ main: server.url.origin } as SeedEndpoints);
    const denied = members.find((item) => item.name === 'sophie')!;
    await expect(
      api.post(
        '/v1/works',
        {
          profile: 'metadata-only-v1',
          title: 'Denied mod',
          language: 'en',
          authoring: 'own-work',
          semanticTypes: ['https://rezics.com/vocab/ModPackage'],
          actingSubject: denied.actor,
        },
        denied.token,
        'g905-denied',
      ),
    ).rejects.toThrow('HTTP 403');
    for (const member of members) {
      await member.grant('work:create:root', 'work.create');
      await stack.accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
        [randomUUID(), operator.principalId, member.actor],
      );
    }
    const state = {
      api,
      sessions: members.map(
        (member) =>
          ({
            id: member.name,
            accountId: member.principal.subject,
            token: member.token,
            actingSubject: member.actor,
          }) as Session,
      ),
      penAgents: new Map([['moonlight', members[0]!.actor]]),
      operatorSession: { api, token: operator.token },
      created: new Map(),
      optional: async () => null,
    } as unknown as SeedState;
    await seedWorks(state);
    for (const plan of works.filter((work) => work.type === 'mod')) {
      const target = state.created.get(plan.id)!;
      const author = members.find((member) => member.name === plan.author)!;
      await author.grant(`work:read:${target.work}`, 'work.read');
      const receipt = await stack.accessPool.query<{ account_subject: string }>(
        `SELECT p.account_subject
        FROM access.admission a JOIN access.principal p ON p.id=a.principal_id WHERE a.idempotency_key=$1`,
        [seedKey('work', plan.id)],
      );
      expect(receipt.rows[0]?.account_subject).toBe(operator.principal.subject);
      const response = await api.get<{ items: { role: string; agent: string }[] }>(
        `/v1/works/${target.work.slice(-36)}/agent-credits?actingSubject=${encodeURIComponent(author.actor)}`,
        author.token,
      );
      expect(response.items).toContainEqual(
        expect.objectContaining({ role: 'author', agent: author.actor }),
      );
    }
  } finally {
    await server?.stop(true);
    await stack.stop();
  }
}, 120_000);
