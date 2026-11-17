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
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { startNativeWebStack } from './stack.ts';

const lifecycle = new NativeTestLifecycle('first-public native community');
const evidencePath = resolve(import.meta.dir, '../../../../.temp/goal/web/community-native-host/evidence.json');
const ownerScopes = ['subject:create', 'thread:create', ...communityOwnerActions];
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

let source: string;
let setup = 'native stack';
let auth: NativeAuthStack;
let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let origins: Origins;
let seed: CommunityFixture;
let signIn: Awaited<ReturnType<typeof probeSignIn>>;
const results: Partial<Record<Case, Result>> = {};

async function retain() {
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(
    evidencePath,
    `${JSON.stringify({ source, scope: 'community-native-host', selected, setup, results }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function bearer(persona: { authorization: string }): string {
  if (!persona.authorization.startsWith('Bearer ')) throw new Error('Native Auth returned an invalid credential');
  return persona.authorization.slice('Bearer '.length);
}

async function activePersona(persona: 'alice' | 'bob'): Promise<CommunityFixture['owner']> {
  const { accountId, email } = await stack.authPersona(persona);
  const { status, value } = await communityKernel(origins, 'GET', '/v1/accounts', { query: { ids: accountId } });
  const account = Array.isArray(value.accounts) && value.accounts.length === 1 ? value.accounts[0] : undefined;
  if (
    status !== 200 ||
    account?.id !== accountId ||
    account.state !== 'active' ||
    account.kind !== 'actor' ||
    account.automated !== false ||
    typeof account.handle !== 'string' ||
    !account.handle
  )
    throw new Error('Native fixture account did not match its current public identity');
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
    setup = 'ordinary community seed';
    const [owner, outsider] = await Promise.all([activePersona('alice'), activePersona('bob')]);
    if (owner.accountId === outsider.accountId) throw new Error('Community fixture actors were not distinct');
    await grantOrdinaryOwnerActions({
      accountId: owner.accountId,
      actions: communityOwnerActions,
      async post({ path, body, idempotencyKey }) {
        const response = await stack.kernel(
          path,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(idempotencyKey) },
            body: JSON.stringify(body),
          },
          'governor',
        );
        await response.body?.cancel();
        return { status: response.status, text: '' };
      },
    });
    const creator = await stack.authPersona('alice', ownerScopes);
    if (creator.accountId !== owner.accountId) throw new Error('Native Auth changed the community creator');
    seed = {
      owner,
      outsider,
      ...(await seedCommunityEntities(
        (method, path, options) => communityKernel(origins, method, path, options),
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
