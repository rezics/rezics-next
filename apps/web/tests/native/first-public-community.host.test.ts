import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BrowserContext } from 'playwright';
import { grantOrdinaryOwnerActions } from '../../../../services/importer/src/ordinary-owner-grants.ts';
import {
  communityOwnerActions,
  seedCommunityEntities,
  type CommunityFixture,
} from '../../scripts/first-public-scope-fixture.ts';
import {
  communityKernel,
  probeSignIn,
  publicFields,
  sourceRevision,
  walkCommunityPath,
} from '../../scripts/first-public-scope-walk.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import { startNativeWebStack } from './stack.ts';

const lifecycle = new NativeTestLifecycle('first-public native community');
const evidencePath = resolve(import.meta.dir, '../../../../.temp/goal/web/community-native-host/evidence.json');
// Realm creation checks the host Space and Context before reading back the newly created Realm.
const ownerScopes = [
  'subject:create',
  'thread:create',
  'space:manage',
  'context:read',
  'realm:read',
  ...communityOwnerActions,
];
const rosterScopes = ['realm:read', 'realm:manage'];
const selected = ['W29', 'W31'] as const;
type Case = (typeof selected)[number];
type Origins = Parameters<typeof communityKernel>[0];
type Result = {
  status: 'PASS' | 'FAIL';
  elapsedMs: number;
  stage?: string;
  evidence?: unknown;
};
type SetupObservation = {
  action: string;
  method?: string;
  status?: number;
  problem?: string;
  returned?: boolean;
  account?: 'expected' | 'unexpected';
  mismatch?: string;
};

let source: string;
let setup = 'native stack';
let auth: NativeAuthStack;
let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let origins: Origins;
let seed: CommunityFixture;
let signIn: Awaited<ReturnType<typeof probeSignIn>>;
const results: Partial<Record<Case, Result>> = {};
const setupTrace: SetupObservation[] = [];
const knownProblems = new Set([
  'authentication_required',
  'conflict',
  'deadline_exceeded',
  'dependency_unavailable',
  'forbidden',
  'idempotency_conflict',
  'invalid_credentials',
  'invalid_request',
  'not_found',
  'platform_closed',
  'rate_limited',
]);

function observeSetup(action: string, method?: string): SetupObservation {
  const observation = { action, ...(method === undefined ? {} : { method }) };
  if (setupTrace.length < 24) setupTrace.push(observation);
  return observation;
}

function observeStatus(observation: SetupObservation, status: number, body: unknown) {
  observation.status = status;
  if (status < 400) return;
  const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
  observation.problem = typeof code === 'string' && knownProblems.has(code) ? code : 'unclassified';
}

const seedActions: Record<string, string> = {
  'POST subjects': 'create Concept',
  'GET subjects': 'read public Concept',
  'POST boards': 'create Global Board',
  'GET boards': 'read public Board directory',
  'POST threads': 'create Thread opening',
  'POST spaces': 'create Space',
  'POST realms': 'create public Realm',
  'GET spaces': 'read public Space and Realm',
};

async function retain() {
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(
    evidencePath,
    `${JSON.stringify({ source, scope: 'community-native-host', selected, setup, setupTrace, results }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function bearer(persona: { authorization: string }): string {
  if (!persona.authorization.startsWith('Bearer ')) throw new Error('Native Auth returned an invalid credential');
  return persona.authorization.slice('Bearer '.length);
}

async function activePersona(persona: 'alice' | 'bob'): Promise<CommunityFixture['owner']> {
  const credential = observeSetup(`resolve ${persona} through native Auth`);
  const { accountId, email } = await stack.authPersona(persona).catch((error: unknown) => {
    credential.returned = false;
    throw error;
  });
  credential.returned = true;
  const observation = observeSetup(`read ${persona} public identity`, 'GET');
  const { status, value } = await communityKernel(origins, 'GET', '/v1/accounts', { query: { ids: accountId } }).catch(
    (error: unknown) => {
      observation.returned = false;
      throw error;
    },
  );
  observeStatus(observation, status, value);
  const account = Array.isArray(value.accounts) && value.accounts.length === 1 ? value.accounts[0] : undefined;
  const checks = {
    status: status === 200,
    exactAccount: account?.id === accountId,
    active: account?.state === 'active',
    actor: account?.kind === 'actor',
    ordinary: account?.automated === false,
    handle: typeof account?.handle === 'string' && account.handle.length > 0,
  };
  const failed = Object.entries(checks).find(([, ok]) => !ok);
  if (failed) {
    observation.account = 'unexpected';
    observation.mismatch = failed[0];
    throw new Error('Native fixture account did not match its current public identity');
  }
  observation.account = 'expected';
  return { accountId, email, handle: account.handle };
}

nativeBeforeAll(lifecycle, 600_000, async () => {
  source = await sourceRevision();
  await retain();
  try {
    stack = await startNativeWebStack({ localShowcaseBoardCreation: true });
    setup = 'native Auth Pages';
    auth = await startAuthStack(stack);
    origins = {
      web: new URL(stack.web).origin,
      kernel: stack.kernelOrigin,
      native: stack.authIssuer,
      issuer: auth.origin,
    };
    setup = 'current fixture identities';
    const [owner, outsider] = await Promise.all([activePersona('alice'), activePersona('bob')]);
    if (owner.accountId === outsider.accountId) throw new Error('Community fixture actors were not distinct');
    setup = 'governor grants';
    await grantOrdinaryOwnerActions({
      accountId: owner.accountId,
      actions: communityOwnerActions,
      async post({ path, body, idempotencyKey }) {
        const observation = observeSetup(`grant ${body.actions[0]}`, 'POST');
        const response = await stack.kernel(
          path,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(idempotencyKey) },
            body: JSON.stringify(body),
          },
          'governor',
        );
        observation.status = response.status;
        if (response.status >= 400 && response.headers.get('content-type')?.startsWith('application/problem+json'))
          observeStatus(observation, response.status, await response.json().catch(() => null));
        else await response.body?.cancel();
        return { status: response.status, text: '' };
      },
    });
    setup = 'scoped creator credential';
    const credential = observeSetup('reissue Alice creator authorization');
    const creator = await stack.authPersona('alice', ownerScopes);
    credential.account = creator.accountId === owner.accountId ? 'expected' : 'unexpected';
    if (creator.accountId !== owner.accountId) throw new Error('Native Auth changed the community creator');
    setup = 'native community entities';
    seed = {
      owner,
      outsider,
      ...(await seedCommunityEntities(
        async (method, path, options) => {
          const action = seedActions[`${method} ${path.split('/')[2]}`] ?? 'other native seed request';
          const observation = observeSetup(action, method);
          const result = await communityKernel(origins, method, path, options);
          observeStatus(observation, result.status, result.value);
          return result;
        },
        bearer(creator),
        owner.accountId,
      )),
    };
    setup = 'sign-in readiness';
    signIn = await probeSignIn(origins);
    if (!signIn.ok) throw new Error('Native community sign-in prerequisites unavailable');
    setup = 'ready';
  } catch {
    throw new Error(`Native community setup stopped at ${setup}. See retained community evidence.`);
  } finally {
    await retain();
  }
});
nativeAfterAll(lifecycle, 240_000);

for (const id of selected) {
  nativeTest(
    id === 'W29' ? 'W29 creates and verifies the exact mounted reply' : 'W31 adds the exact Realm member',
    300_000,
    async () => {
      const started = performance.now();
      let anonymous: BrowserContext | undefined;
      try {
        anonymous = await auth.newContext('anonymous');
        const page = await anonymous.newPage();
        page.setDefaultTimeout(60_000);
        const evidence = await walkCommunityPath(id, {
          stack: origins,
          seed,
          page,
          signIn,
          community: {
            async ownerContext() {
              await anonymous?.close();
              anonymous = undefined;
              return auth.newContext('alice');
            },
            submitOwnerSignIn: (page) => auth.submitSignIn(page, 'alice'),
            async observeRosterRead(realmId) {
              if (
                !(await settledWithin(
                  stack.syncKernelRequests().then(() => true),
                  5_000,
                ))
              )
                return null;
              return stack
                .kernelRequests()
                .filter(
                  (request) =>
                    !request.fixtureRequest &&
                    request.method === 'GET' &&
                    request.url.split('?')[0] === `/v1/realms/${realmId}/members`,
                )
                .slice(0, 6)
                .map(({ responseStatus }) => responseStatus ?? null);
            },
            async observeSelectedRoster(realmId, accountId) {
              const owner = await stack.authPersona('alice', rosterScopes);
              const query = new URLSearchParams({ accountId });
              const response = await stack.kernel(
                `/v1/realms/${realmId}/members?${query}`,
                { headers: { authorization: owner.authorization }, signal: AbortSignal.timeout(2_000) },
                'alice',
              );
              const value = (await response.json().catch(() => null)) as {
                state?: unknown;
                selected?: { accountId?: unknown; membership?: unknown };
              } | null;
              return {
                status: response.status,
                state: value?.state === 'ready' || value?.state === 'preparing' ? value.state : 'other',
                exactAccount: value?.selected?.accountId === accountId,
                membership:
                  value?.selected?.membership === 'member' || value?.selected?.membership === 'none'
                    ? value.selected.membership
                    : 'other',
              };
            },
            async freshOutsider() {
              const outsider = await stack.authPersona('bob', rosterScopes);
              return { accountId: outsider.accountId, bearer: bearer(outsider) };
            },
          },
        });
        results[id] = {
          status: 'PASS',
          elapsedMs: Math.round(performance.now() - started),
          evidence: publicFields(evidence),
        };
      } catch (error) {
        const { stage, observed } = (error ?? {}) as { stage?: unknown; observed?: unknown };
        results[id] = {
          status: 'FAIL',
          elapsedMs: Math.round(performance.now() - started),
          stage: typeof stage === 'string' ? stage.slice(0, 120) : 'anonymous or mounted boundary',
          evidence: publicFields(observed),
        };
        throw new Error(`${id} failed at ${results[id]?.stage}. See retained community evidence.`);
      } finally {
        try {
          await anonymous?.close();
        } finally {
          await retain();
        }
      }
    },
    lifecycle,
  );
}
