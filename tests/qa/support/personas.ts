import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn, type LocalOAuthSession } from '../../../scripts/lib/oauth-client.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { accountEmailQueue, smtpSender } from '../../../services/account/src/email.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { mainLifecycle } from '../../../services/main/src/lifecycle.ts';
import { mainConfig } from '../../../services/main/src/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { joiningAuthFixture } from './joining-auth.ts';
import { outcomeResponse } from './outcome-test.ts';

export const personaNames = [
  'visitor',
  'stranger',
  'member',
  'owner',
  'moderator',
  'operator',
] as const;
export type PersonaName = (typeof personaNames)[number];
type Call = (method: string, path: string, body?: unknown, key?: string,
  options?: { headers?: Record<string, string>; bytes?: Uint8Array }) => Promise<Response>;
export interface PersonaSession {
  /** Null only for the signed-out visitor. Commands supply this as actingSubject. */
  actingSubject: string | null;
  accountId: string | null;
  main: Call;
  account: Call;
}
export interface PersonaSessions extends Record<PersonaName, PersonaSession> {
  realm: string;
  space: string;
  zone: string;
  visibility: 'public' | 'private';
  /** Actual wall time for this call, including application setup on the first call. */
  elapsedSeconds: number;
  /** Closes this test file's shared HTTP apps; all its persona sessions then expire. */
  close(): Promise<void>;
}

async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Persona setup expected HTTP ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

function session(
  main: string,
  account: string,
  accountId: string | null,
  cookie?: string,
  oauth?: LocalOAuthSession,
): PersonaSession {
  const sessionKey = randomUUID();
  const call =
    (base: string, credentials: () => Promise<Headers>): Call =>
    async (method, path, body, key, options) => {
      const url = new URL(path, base);
      if (url.origin !== new URL(base).origin)
        throw new Error('A persona request must stay on its service origin');
      const headers = await credentials();
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        if (['authorization', 'cookie', 'x-session-key'].includes(name.toLowerCase()))
          throw new Error('A persona request cannot replace its identity');
        headers.set(name, value);
      }
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (body !== undefined && options?.bytes) throw new Error('A request has one body');
      if (key !== undefined || !['GET', 'HEAD'].includes(method.toUpperCase()))
        headers.set('idempotency-key', key ?? randomUUID());
      const request = (signal: AbortSignal) => fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ...(options?.bytes ? { body: new Blob([new Uint8Array(options.bytes)]) }
          : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return ['GET', 'HEAD'].includes(method.toUpperCase())
        ? outcomeResponse(request)
        : request(AbortSignal.timeout(30_000));
    };
  return {
    accountId,
    actingSubject: null,
    main: call(
      main,
      async () =>
        new Headers(
          oauth
            ? { authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey }
            : {},
        ),
    ),
    account: call(account, async () => new Headers(cookie ? { cookie, origin: account } : {})),
  };
}

// The integration tier already owns storage, migrations and graph admission.
// Production applications and Main's lifecycle share this isolated storage.
let firstOperator:
  | { runId: string; email: string; password: string; actingSubject: string }
  | undefined;
interface PersonaOptions {
  /** External delivery service exercised over HTTP by the production adapter. */
  notificationProvider?: { url: string; token: string; callbackSecret: string };
  /** A transparent HTTP proxy may delay real storage responses for race proofs. */
  graphEndpoint?: string;
}
async function applications(options: PersonaOptions) {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Persona sessions require the QA integration tier');
  const auth = await joiningAuthFixture(runId);
  const authDirectory = dirname(auth.publicConfigPath);
  const runtime = readEnv(auth.runtimeEnvPath);
  const publicAuth = JSON.parse(readFileSync(auth.publicConfigPath, 'utf8')) as {
    clientId: string;
    redirectUris: string[];
    scope: string;
  };
  const accountBase = Bun.env.ACCOUNT_BASE_URL!;
  const mainBase = `http://127.0.0.1:${Bun.env.MAIN_PORT}`;
  const compose = readEnv(resolve('.temp/stack', `rezics-qa-${runId}`, 'compose.env'));
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const pools = [accountPool, accessPool, contentPool, relayPool];
  const email = accountEmailQueue(
    accountPool,
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
    accountBase,
  );
  let account: ReturnType<typeof createAccountApp> | undefined;
  let main: Awaited<ReturnType<typeof composeMain>>['app'] | undefined;
  let lifecycle: ReturnType<typeof mainLifecycle> | undefined;
  let relay: ReturnType<typeof Bun.spawn> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    active = undefined;
    try {
      try {
        try {
          if (relay?.exitCode === null) relay.kill('SIGTERM');
          const code = await relay?.exited;
          if (code !== undefined && code !== 0) throw new Error(`Main relay exited with ${code}`);
        } finally {
          await lifecycle?.stop();
        }
      } finally {
        await account?.stop(true);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      rmSync(authDirectory, { recursive: true, force: true });
    }
  };
  try {
    account = createAccountApp(
      createAccountAuth({
        baseURL: accountBase,
        secret: Bun.env.ACCOUNT_SECRET!,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
        pool: accountPool,
        email,
        requireEmailVerification: true,
        operatorUserIds: new Set(),
      }),
      accountPool,
    ).listen({ hostname: '127.0.0.1', port: Number(Bun.env.ACCOUNT_PORT) });
    await migrateContent(contentPool);
    const relayEnvironment = { ...process.env, ...runtime };
    const relayStarted = performance.now();
    const initialization = Bun.spawn([process.execPath, 'services/main/src/relay-init.ts'], {
      env: relayEnvironment, stdout: 'inherit', stderr: 'inherit',
    });
    const initialized = await initialization.exited;
    if (initialized !== 0) throw new Error(`Main relay initialization exited with ${initialized}`);
    console.log(`Persona Main relay initialization: ${((performance.now() - relayStarted) / 1000).toFixed(2)}s`);
    const composed = await composeMain({
      config: mainConfig({ ...process.env, ...runtime, PLATFORM_FIRST_ADMIN_ACCOUNT: undefined,
        ...(options.notificationProvider ? {
          MAIN_NOTIFICATION_PROVIDER_URL: options.notificationProvider.url,
          MAIN_NOTIFICATION_PROVIDER_TOKEN: options.notificationProvider.token,
          MAIN_NOTIFICATION_CALLBACK_SECRET: options.notificationProvider.callbackSecret,
        } : {}),
      }),
      fuseki: new FusekiClient(
        options.graphEndpoint ?? Bun.env.FUSEKI_URL!,
        Bun.env.FUSEKI_MAINTENANCE_TOKEN,
        Bun.env.FUSEKI_COMMAND_TOKEN,
      ),
      accessPool,
      contentPool,
      relayPool,
      erasureRelayPool: relayPool,
      ownerRelayPool: relayPool,
      recommendationRelayPool: relayPool,
    });
    main = composed.app;
    lifecycle = mainLifecycle(composed, () => {
      main!.listen({ hostname: '127.0.0.1', port: Number(Bun.env.MAIN_PORT) });
    }, () => main!.stop(true));
    await lifecycle.start();
    relay = Bun.spawn([process.execPath, '--preload', './services/main/src/relay-telemetry.ts',
      'services/main/src/relay.ts'], {
      env: relayEnvironment, stdout: 'inherit', stderr: 'inherit',
    });
    const signup = async (name: string): Promise<PersonaSession> => {
      const previous =
        name === 'operator' && firstOperator?.runId === runId ? firstOperator : undefined;
      const emailAddress = previous?.email ?? `persona-${name}-${randomUUID()}@example.test`;
      const password = previous?.password ?? randomBytes(24).toString('base64url');
      const anonymous = session(mainBase, accountBase, null);
      if (!previous) {
        await json(
          anonymous.account('POST', '/api/auth/sign-up/email', {
            ...signupPolicyFixture,
            name: `Outcome ${name}`,
            email: emailAddress,
            password,
          }),
        );
        // Read the person's delivered verification link, then follow it over HTTP.
        await email.drain();
        const mailbox = `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}`;
        const inbox = await json<{ messages: { ID: string }[] }>(
          fetch(`${mailbox}/api/v1/search?query=${encodeURIComponent(`to:${emailAddress}`)}`),
        );
        if (!inbox.messages[0]) throw new Error(`No verification mail for ${name}`);
        const message = await json<{ Text: string }>(
          fetch(`${mailbox}/api/v1/message/${inbox.messages[0].ID}`),
        );
        const link = message.Text.match(/https?:\/\/[^\s]+/)?.[0];
        if (!link) throw new Error(`No verification link for ${name}`);
        const verified = await anonymous.account('GET', link);
        if (verified.status !== 302 && verified.status !== 200)
          throw new Error(`Email verification failed: ${verified.status}`);
      }
      const login = await anonymous.account('POST', '/api/auth/sign-in/email', {
        email: emailAddress,
        password,
      });
      const user = await json<{ user: { id: string } }>(Promise.resolve(login));
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookie) throw new Error('Account sign-in returned no session cookie');
      const oauth = await signIn(
        {
          account: accountBase,
          clientId: publicAuth.clientId,
          redirectUri: publicAuth.redirectUris[0]!,
          scope: publicAuth.scope,
          resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        },
        cookie,
      );
      const person = session(mainBase, accountBase, user.user.id, cookie, oauth);
      person.actingSubject =
        previous?.actingSubject ??
        (
          await json<{ agent: string }>(
            person.main('POST', '/v1/agents', {
              profile: 'agent-provision-v1',
              kind: 'person',
              displayName: `Outcome ${name}`,
            }),
            201,
          )
        ).agent;
      await json(
        person.main('PUT', '/v1/me/session-agent', {
          actingSubject: person.actingSubject,
          expectedRevision: null,
        }),
      );
      if (name === 'operator')
        firstOperator = {
          runId,
          email: emailAddress,
          password,
          actingSubject: person.actingSubject,
        };
      return person;
    };
    const operator = await signup('operator');
    // The first platform mandate is the existing deployment bootstrap, not an end-user command.
    const designation = await new AccessPlatformAdministrators(accessPool).designateFirst(
      `${accountBase}/api/auth`,
      operator.accountId!,
    );
    const authority = await json<{ groups: string[] }>(
      operator.main('GET', '/v1/me/platform-access'),
    );
    if (designation.status === 'unconfigured' || !authority.groups.includes('platform-admin'))
      throw new Error(
        'Persona stack must be fresh or retain this harness’s first platform administrator',
      );
    return { signup, operator, visitor: session(mainBase, accountBase, null), close };
  } catch (error) {
    await close();
    throw error;
  }
}

let active: Promise<Awaited<ReturnType<typeof applications>>> | undefined;

/** One call builds six HTTP sessions and a Realm with an attached Zone.
 * The first call includes OAuth/application setup; subsequent calls share those listeners.
 * Measured integration cost: about 7 seconds for the first call and 5 seconds thereafter.
 * elapsedSeconds reports the measured cost; close once after the file's proofs finish. */
export async function personaSessions(
  visibility: 'public' | 'private' = 'public',
  options: PersonaOptions = {},
): Promise<PersonaSessions> {
  const started = performance.now();
  const stack = await (active ??= applications(options));
  try {
    const owner = await stack.signup('owner');
    const stranger = await stack.signup('stranger');
    const member = await stack.signup('member');
    const moderator = await stack.signup('moderator');
    const created = await json<{ realm: string; space: string }>(
      owner.main('POST', '/v1/spaces', {
        profile: 'space-realm-v2',
        name: `Outcome ${visibility} Realm`,
        handle: `outcome-${randomUUID().slice(0, 12)}`,
        language: 'en',
        capabilities: ['realm'],
        actingSubject: owner.actingSubject,
        initialSettings: {
          visibility,
          reviewRequired: false,
          reviewMode: 'open',
          whoMaySubmit: 'members',
          selfJoin: visibility === 'public',
          rules: [],
        },
      }),
      201,
    );
    const root = `/v1/realms/${created.realm.slice(-36)}`;
    await json(owner.main('POST', `${root}/management`, { actingSubject: owner.actingSubject }));
    for (const person of [member, moderator]) {
      if (visibility === 'public') {
        const policy = await json<{
          membershipGeneration: string;
          policyRevision: string;
          termsRevision: string;
        }>(
          person.main(
            'GET',
            `${root}/joining?actingSubject=${encodeURIComponent(person.actingSubject!)}`,
          ),
        );
        await json(
          person.main('POST', `${root}/join`, {
            actingSubject: person.actingSubject,
            expectedMembershipGeneration: policy.membershipGeneration,
            expectedPolicyRevision: policy.policyRevision,
            termsRevision: policy.termsRevision,
            listed: false,
          }),
        );
      } else {
        const invitation = await json<{ invitation: { id: string } }>(
          owner.main('POST', `${root}/invitations`, {
            actingSubject: owner.actingSubject,
            member: person.actingSubject,
            expiresInSeconds: 3600,
          }),
        );
        await json(
          person.main('POST', `${root}/invitations/${invitation.invitation.id}/response`, {
            actingSubject: person.actingSubject,
            action: 'accept',
            listed: false,
          }),
        );
      }
    }
    const rolesPath = `${root}/roles?actingSubject=${encodeURIComponent(owner.actingSubject!)}`;
    const changeRole = async (change: object) => {
      const roles = await json<{ generation: string }>(owner.main('GET', rolesPath));
      const command = {
        actingSubject: owner.actingSubject,
        expectedGeneration: roles.generation,
        reason: 'Set up the Realm moderation team',
        change,
      };
      const preview = await json<{ digest: string }>(
        owner.main('POST', `${root}/role-impact`, command),
      );
      await json(
        owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }),
        201,
      );
    };
    const roleId = randomUUID();
    await changeRole({
      kind: 'role',
      roleId,
      name: 'Moderators',
      permissions: ['governance.moderate'],
    });
    await changeRole({
      kind: 'assignment',
      roleId,
      member: moderator.actingSubject,
      assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const site = await json<{ zone: string; zoneRevision: string }>(
      owner.main('POST', '/v1/spaces', {
        profile: 'space-zone-v1',
        name: 'Outcome Realm site',
        language: 'en',
        capabilities: ['zone'],
        actingSubject: owner.actingSubject,
      }),
      201,
    );
    await json(
      owner.main('PUT', `/v1/zones/${site.zone.slice(-36)}/configuration`, {
        actingSubject: owner.actingSubject,
        expectedHead: site.zoneRevision,
        defaultRealm: created.realm,
      }),
    );
    return {
      ...created,
      zone: site.zone,
      visibility,
      visitor: stack.visitor,
      stranger,
      member,
      owner,
      moderator,
      operator: stack.operator,
      elapsedSeconds: (performance.now() - started) / 1000,
      close: stack.close,
    };
  } catch (error) {
    await stack.close();
    throw error;
  }
}
