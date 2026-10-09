import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { readEnv } from '../../../scripts/dev/config.ts';
import { penNames, people, realms, works, semanticTypes } from '../../../scripts/dev/seed/plan.ts';
import { communityPeople } from '../../../scripts/dev/seed/community-plan.ts';
import { requiresSeedAdministrator } from '../../../scripts/dev/seed/work-authority.ts';
import {
  operatorSeedSession,
  grantImportedWorkSeedAuthority,
} from '../../../scripts/dev/seed/operator.ts';
import { SeedApi } from '../../../scripts/dev/seed/api.ts';
import { seedAccounts } from '../../../scripts/dev/seed/accounts-step.ts';
import { seedWorks } from '../../../scripts/dev/seed/works-step.ts';
import { seedContributions } from '../../../scripts/dev/seed/contributions-step.ts';
import { seedRealms } from '../../../scripts/dev/seed/realms-step.ts';
import { seedLibrary } from '../../../scripts/dev/seed/library-step.ts';
import type { SeedState } from '../../../scripts/dev/seed/state.ts';
import { demoClassics } from '../../fixtures/sources/open-library.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';

test.each(['member', 'administrator'] as const)(
  'baseline seed %s journey: full native plan partitions replay with exact authority',
  async (journey) => {
    const root = resolve(import.meta.dir, '../../..');
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['account', 'access'], 'owner');
    const oldAccount = Bun.env.ACCOUNT_DATABASE_URL;
    const oldAccess = Bun.env.ACCESS_DATABASE_URL;
    Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
    Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
    const scopes = [
      'agent:create',
      'work:create',
      'work:edit',
      'work:read',
      'space:create',
      'collection:edit',
      'semantic:read',
    ];
    let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
    try {
      h = await agentProvisionHarness(scopes);
    } catch (error) {
      await databases.close();
      throw error;
    } finally {
      Bun.env.ACCOUNT_DATABASE_URL = oldAccount;
      Bun.env.ACCESS_DATABASE_URL = oldAccess;
    }
    const directory = join(root, '.temp', `baseline-seed-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const compose = readEnv(
      join(root, '.temp', 'stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`, 'compose.env'),
    );
    const email = accountEmailQueue(
      h.accountPool,
      Bun.env.ACCOUNT_SECRET!,
      smtpSender({
        host: '127.0.0.1',
        port: Number(compose.MAILPIT_SMTP_PORT),
        secure: false,
        requireTLS: false,
        user: '',
        password: '',
        from: 'REZICS QA <qa@example.test>',
      }),
      h.base,
    );
    let delivering: Promise<void> | undefined;
    const timer = setInterval(() => {
      delivering ??= email.drain().finally(() => {
        delivering = undefined;
      });
    }, 50);
    let accountApp: ReturnType<typeof createAccountApp>;
    const accountServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => accountApp.handle(request),
    });
    const accountBase = `http://127.0.0.1:${accountServer.port}`;
    accountApp = createAccountApp(
      createAccountAuth({
        baseURL: accountBase,
        secret: Bun.env.ACCOUNT_SECRET!,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
        pool: h.accountPool,
        operatorUserIds: new Set(),
        email,
        requireEmailVerification: true,
      }),
      h.accountPool,
    );
    const account = new AccountAssertionVerifier({
      issuer: `${accountBase}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${accountBase}/api/auth/jwks`,
      introspectUrl: `${accountBase}/api/auth/oauth2/introspect`,
      clientId: h.verifierClient.client_id,
      clientSecret: h.verifierClient.client_secret!,
    });
    const access = new AccessAdmissionRegistry(h.accessPool);
    access.configureBaseline(h.fuseki);
    const objects = new S3ImmutableObjects({
      endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/',
    });
    await objects.initialize();
    const app = createMainApp(h.fuseki, {
      environment: { ...h.env,addresses: new AliasRegistry(h.accessPool) },
      account,
      access,
      profiles: new ProfilesAccess(h.accessPool),
      personPreferences: new PersonPreferencesStore(h.accessPool),
      agentProfiles: new AgentPublicProfiles(h.accessPool, h.env, {
        avatarSelection: async () => {
          throw new Error('No avatar in the seed fixture');
        },
      }),
      agentHandles: new AgentVanityHandles(h.accessPool),
      agentProvisioning: new AgentProvisioning(h.accessPool, h.env),
      structureObjects: objects,
    });
    const main = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => app.handle(request),
    });
    const endpoints = {
      account: accountBase,
      main: `http://127.0.0.1:${main.port}`,
      mailpit: `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}`,
      clientId: h.client.client_id,
      redirectUri: h.redirectUri,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      scope: `openid ${scopes.join(' ')}`,
    };
    const nativePlan = works.filter(
      (work) => !demoClassics.some((classic) => classic.id === work.id),
    );
    const nativeWorks = nativePlan.filter(
      (work) =>
        requiresSeedAdministrator(semanticTypes(work.type)) === (journey === 'administrator'),
    );
    expect(nativeWorks.length).toBeGreaterThan(0);
    expect(
      nativePlan.filter((work) => !requiresSeedAdministrator(semanticTypes(work.type))).length +
        nativePlan.filter((work) => requiresSeedAdministrator(semanticTypes(work.type))).length,
    ).toBe(nativePlan.length);
    const accounts = people.length + communityPeople.length;
    const agents = accounts + penNames.length;
    let firstWorks: string[] | undefined;
    // Optional seed steps swallow their errors into findings; a failed expectation must show them.
    let attemptFindings = new Set<string>();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const findings = (attemptFindings = new Set<string>());
        const state: SeedState = {
          api: new SeedApi(endpoints),
          endpoints,
          fixture: {
            operator: null,
            accountDatabaseUrl: null,
            accessDatabaseUrl: null,
            accountSecret: null,
          },
          findings,
          async optional<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
            try {
              return await operation();
            } catch (error) {
              findings.add(`${label}: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          },
          sessions: [],
          penAgents: new Map(),
          operatorInput: null,
          operatorSession: null,
          agentCount: 0,
          created: new Map(),
          createdRealms: [],
          seededZones: [],
          publishedCount: 0,
          selectedCount: 0,
          publicForRealm: new Map(),
          publicWorks: new Map(),
          ratingContext: null,
          communityRealms: new Map(),
          discussionVotes: [],
          commentCount: 0,
          replyCount: 0,
          reviewCount: 0,
          profileCreditCount: 0,
          profileFollowCount: 0,
        };
        await seedAccounts(state);
        if (journey === 'administrator') {
          const owner = state.sessions[0]!;
          if (attempt === 0) {
            const restricted = nativeWorks[0]!;
            const writer = state.sessions.find((session) => session.id === restricted.author)!;
            await expect(
              state.api.post(
                '/v1/works',
                {
                  profile: 'metadata-only-v1',
                  title: restricted.title,
                  language: restricted.language,
                  semanticTypes: semanticTypes(restricted.type),
                  authoring: 'own-work',
                  actingSubject: writer.actingSubject,
                },
                writer.token,
                randomUUID(),
              ),
            ).rejects.toMatchObject({ status: 403 });
            await expect(seedWorks(state, nativeWorks)).rejects.toThrow(
              'requires the local fixture administrator',
            );
            expect(state.created.size).toBe(0);
          }
          await h.accountPool.query(
            `INSERT INTO rezics_account_operator (user_id,role)
          VALUES ($1,'owner') ON CONFLICT (user_id) DO NOTHING`,
            [owner.accountId],
          );
          state.operatorInput = {
            endpoints,
            credentials: people[0]!,
            accountDatabaseUrl: databases.urls.account,
            accessDatabaseUrl: databases.urls.access,
            accountSecret: Bun.env.ACCOUNT_SECRET!,
            accountSubject: owner.accountId,
            ownerAccountSubject: owner.accountId,
            actingSubject: owner.actingSubject,
          };
          state.operatorSession = await operatorSeedSession(state.operatorInput);
        }
        await seedWorks(state, nativeWorks);
        if (state.operatorInput)
          for (const work of nativeWorks) {
            const owner =
              state.sessions.find((session) => session.id === work.author) ?? state.sessions[0]!;
            const receipt = state.created.get(work.id)!;
            await grantImportedWorkSeedAuthority(
              {
                ...state.operatorInput,
                ownerAccountSubject: owner.accountId,
                actingSubject: owner.actingSubject,
              },
              receipt.work,
              receipt.mainVersion,
            );
          }
        if (state.operatorInput && attempt === 0) {
          const authorityRows = async () =>
            (
              await h.accessPool.query<{ id: string; same: boolean; bounded: boolean }>(
                `SELECT id, issuer_subject = recipient_subject AS same,
                  active AND valid_until > now()
                    AND valid_until <= now() + interval '8 hours 1 minute' AS bounded
                FROM access.permission_grant
                WHERE action IN ('work.read', 'work.edit', 'contribution.create', 'publication.select')
                ORDER BY id`,
              )
            ).rows;
          const before = await authorityRows();
          expect(before.length).toBeGreaterThan(0);
          expect(before.every((row) => row.same && row.bounded)).toBe(true);
          const sample = nativeWorks[0]!;
          const sampleOwner =
            state.sessions.find((session) => session.id === sample.author) ?? state.sessions[0]!;
          const sampleReceipt = state.created.get(sample.id)!;
          const again = {
            ...state.operatorInput,
            ownerAccountSubject: sampleOwner.accountId,
            actingSubject: sampleOwner.actingSubject,
          };
          await grantImportedWorkSeedAuthority(again, sampleReceipt.work, sampleReceipt.mainVersion);
          expect(await authorityRows()).toEqual(before);
          const closedScope = `work:read:${sampleReceipt.work}`;
          await h.accessPool.query(
            'UPDATE access.scope_gate SET open = false, dispatch_open = false WHERE id = $1',
            [closedScope],
          );
          try {
            await expect(
              grantImportedWorkSeedAuthority(again, sampleReceipt.work, sampleReceipt.mainVersion),
            ).rejects.toMatchObject({
              name: 'FixtureAuthorityDenied', kind: 'gate',
              message: `fixture scope is closed: ${closedScope}`,
            });
            expect(await authorityRows()).toEqual(before);
          } finally {
            await h.accessPool.query(
              'UPDATE access.scope_gate SET open = true, dispatch_open = true WHERE id = $1',
              [closedScope],
            );
          }
        }
        await seedContributions(state, nativeWorks);
        if (journey === 'member') {
          await seedRealms(state);
          await seedLibrary(state);
        }
        expect(state.created.size).toBe(nativeWorks.length);
        const createdWorks = [...state.created.values()].map((receipt) => receipt.work).sort();
        if (firstWorks) {
          expect(createdWorks).toEqual(firstWorks);
          expect([...state.created.values()].every((receipt) => receipt.replayed)).toBe(true);
        } else firstWorks = createdWorks;
        expect(state.createdRealms).toHaveLength(journey === 'member' ? realms.length : 0);
        expect(state.agentCount).toBe(agents);
        expect(state.publishedCount).toBe(nativeWorks.filter((work) => work.excerpt).length);
        expect(state.selectedCount).toBe(state.publishedCount);
        expect(
          [...findings].filter((value) =>
            /^(Space \/ Realm creation|Personal collection|Text contribution|Contribution publication):/.test(
              value,
            ),
          ),
        ).toEqual([]);
        // Provisioning creates narrow consent and Realm-owner grants; none grants these baseline writes.
        if (journey === 'member')
          expect(
            (
              await h.accountPool.query(
                'SELECT user_id FROM rezics_account_operator WHERE user_id = ANY($1::text[])',
                [state.sessions.map((session) => session.accountId)],
              )
            ).rows,
          ).toEqual([]);
        if (journey === 'member')
          expect(
            (
              await h.accessPool.query(`SELECT count(*)::int AS n FROM access.permission_grant
        WHERE action IN ('work.create', 'contribution.create', 'contribution.publish', 'space.create', 'collection.edit')`)
            ).rows[0]?.n,
          ).toBe(0);
        expect(
          (await h.accountPool.query('SELECT count(*)::int AS n FROM "user" WHERE "emailVerified"'))
            .rows[0]?.n,
        ).toBe(accounts);
        writeFileSync(
          join(directory, `attempt-${attempt}.json`),
          JSON.stringify({
            nativeWorks: state.created.size,
            accounts,
            agents,
            published: state.publishedCount,
            findings: [...findings],
          }),
        );
      }
    } catch (error) {
      if (attemptFindings.size)
        console.error(`Seed findings before the failure:\n${[...attemptFindings].join('\n')}`);
      throw error;
    } finally {
      clearInterval(timer);
      await delivering;
      await main.stop(true);
      await accountServer.stop(true);
      await h.close();
      await databases.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  240_000,
);
