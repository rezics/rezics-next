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
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { AccessPlatformAdministrators } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { joiningAuthFixture } from './joining-auth.ts';
import { outcomeResponse } from './outcome-response.ts';
import { provisionedAgent } from './provisioned-agent.ts';
import { personaProofActive } from './proof-phase.ts';
import { settledWrite } from './settled-write.ts';
import { personaRequests } from './request-watch.ts';

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
  options?: { headers?: Record<string, string>; bytes?: Uint8Array;
    /** Observe one raw API answer, including unavailable, without the preparation retry policy. */
    retry?: boolean;
    /** The caller may leave while the real server is still doing work. */
    signal?: AbortSignal;
    /** Inspect the first preparation answer when deliberately preparing pending work. */
    settle?: boolean }) => Promise<Response>;
export interface PersonaSession {
  /** Null only for the signed-out visitor. Commands supply this as actingSubject. */
  actingSubject: string | null;
  accountId: string | null;
  main: Call;
  account: Call;
  /** A captured bearer never renews, so expiry and revocation remain observable. */
  snapshot(): { expiresAt: number | null; main: Call };
}

/** Private fixture credentials, retained only in a mode-0600 source manifest.
 * Restoring signs in normally; it never restores or extends a bearer. */
export type RetainedPersonaIdentity = {
  email: string; password: string; accountId: string; actingSubject: string;
};
const retainedIdentities = new WeakMap<PersonaSession, RetainedPersonaIdentity>();
type RetainedPersonaAuth = {
  accountOrigin: string; clientId: string; redirectUris: string[]; scope: string;
  mainClientId: string; mainClientSecret: string;
};
const retainedAuths = new WeakMap<PersonaSession, RetainedPersonaAuth>();
export function retainedPersonaIdentity(person: PersonaSession): RetainedPersonaIdentity {
  const identity = retainedIdentities.get(person);
  if (!identity) throw new Error('Persona has no restorable Account identity');
  return { ...identity };
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

export function personaSession(
  main: string,
  account: string,
  accountId: string | null,
  cookie?: string,
  oauth?: LocalOAuthSession,
  observeMain?: PersonaOptions['observeMain'],
  persona = accountId ?? 'visitor',
  watch = personaRequests,
  observeAccount?: PersonaOptions['observeMain'],
  accountOrigin = account,
): PersonaSession {
  const sessionKey = randomUUID();
  const expiry = (token: string) => {
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number };
    if (!Number.isSafeInteger(claims.exp)) throw new Error('Persona bearer has no expiry');
    return claims.exp * 1000;
  };
  const call =
    (base: string, credentials: () => Promise<Headers>, renewExpired = false): Call =>
    async (method, path, body, key, options) => {
      const url = new URL(path, base);
      if (url.origin !== new URL(base).origin)
        throw new Error('A persona request must stay on its service origin');
      for (const name of Object.keys(options?.headers ?? {})) {
        if (['authorization', 'cookie', 'x-session-key'].includes(name.toLowerCase()))
          throw new Error('A persona request cannot replace its identity');
      }
      if (body !== undefined && options?.bytes) throw new Error('A request has one body');
      const read = ['GET', 'HEAD'].includes(method.toUpperCase());
      const prepare = base === main && !read && !personaProofActive() && options?.settle !== false;
      const commandKey = key ?? (!['GET', 'HEAD'].includes(method.toUpperCase()) ? randomUUID() : undefined);
      let renewed = false;
      const request = async (signal: AbortSignal) => {
        for (;;) {
          // Each read retry obtains current credentials. The command key and
          // session choice stay fixed across a bearer renewal.
          const headers = await credentials();
          for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value);
          if (body !== undefined) headers.set('content-type', 'application/json');
          if (commandKey !== undefined) headers.set('idempotency-key', commandKey);
          const requestStartedAt = Date.now();
          const finish = watch.start({ persona, service: base === main ? 'Main' : 'Account', method, url });
          let response: Response;
          try {
            response = await fetch(url, {
            method, headers, redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000), ...(options?.signal ? [options.signal] : [])]),
            ...(options?.bytes ? { body: new Blob([new Uint8Array(options.bytes)]) }
              : body === undefined ? {} : { body: JSON.stringify(body) }),
            });
          } catch (error) {
            finish();
            const observe = base === main ? observeMain : observeAccount;
            try {
              if (observe) await observe({ caller: person,
                request: { method, url: base === main ? url.href : url.origin + url.pathname,
                  path: url.pathname + (base === main ? url.search : ''),
                  body: base === main ? body ?? null : null, key: commandKey ?? null },
                // Zero denotes no HTTP answer, never a terminal product refusal.
                response: { status: 0, body: JSON.stringify({ transportFailure: error instanceof Error ? error.name : 'unknown' }) },
                requestStartedAt, answeredAt: Date.now() });
            } finally { throw error; }
          }
          finish(response);
          const observe = base === main ? observeMain : observeAccount;
          if (observe) {
            const raw = await response.clone().text(), answeredAt = Date.now();
            // Setup diagnostics never retain credentials, cookies or headers.
            await observe({ caller: person,
              request: { method, url: base === main ? url.href : url.origin + url.pathname,
                path: url.pathname + (base === main ? url.search : ''),
                body: base === main ? body ?? null : null, key: commandKey ?? null },
              response: { status: response.status, body: base === main ? raw : '' }, requestStartedAt, answeredAt });
          }
          const token = headers.get('authorization')?.slice('Bearer '.length);
          if (!renewExpired || renewed || !token || expiry(token) > Date.now()
            || ![401, 403].includes(response.status)) return response;
          const problem = await response.clone().json() as { code?: string };
          if (!['invalid_account_assertion', 'account_assertion_denied', 'authority_denied'].includes(problem.code ?? '')) return response;
          console.info('Persona bearer expired during request', { method, path: url.pathname,
            status: response.status, code: problem.code, expiresAt: new Date(expiry(token)).toISOString() });
          renewed = true;
          await response.body?.cancel();
        }
      };
      const send = () => base === main && options?.retry !== false
        ? outcomeResponse(request, read ? 45_000 : 30_000,
          { method, path: url.pathname + url.search, idempotencyKey: commandKey })
        : request(AbortSignal.timeout(read ? 45_000 : 30_000));
      const initial = await send();
      if (!prepare || !await reconcilingAnswer(initial)) return initial;
      console.info(`Persona preparation followed ${method} ${url.pathname + url.search}`);
      let first = true;
      return settledWrite(async () => {
        if (first) { first = false; return initial; }
        return send();
      }, method, path, body, commandKey);
    };
  const person: PersonaSession = {
    accountId,
    actingSubject: null,
    main: call(
      main,
      async () =>
        new Headers(
          oauth
            ? { authorization: `Bearer ${await oauth.current(Date.now(), 30_000)}`, 'x-session-key': sessionKey }
            : {},
        ),
      true,
    ),
    account: call(account, async () => new Headers(cookie ? { cookie, origin: accountOrigin }
      : accountOrigin !== account ? { origin: accountOrigin } : {})),
    snapshot() {
      const token = oauth?.accessToken;
      return { expiresAt: token ? expiry(token) : null,
        main: call(main, async () => new Headers(token
          ? { authorization: `Bearer ${token}`, 'x-session-key': sessionKey } : {})) };
    },
  };
  return person;
}

/** Other 202 protocols (including Agent provision) retain their first answer. */
async function reconcilingAnswer(response: Response): Promise<boolean> {
  if (response.status !== 202) return false;
  const pending = await response.clone().json().catch(() => null) as {
    operationId?: unknown; status?: unknown; phase?: unknown; result?: unknown;
    retry?: { allowed?: unknown; afterMs?: unknown };
  } | null;
  return pending?.status === 'reconciling' && pending.result === null
    && typeof pending.operationId === 'string' && pending.operationId.length > 0
    && typeof pending.phase === 'string' && pending.phase.length > 0
    && pending.retry?.allowed === true && typeof pending.retry.afterMs === 'number'
    && Number.isFinite(pending.retry.afterMs) && pending.retry.afterMs >= 0;
}

// The integration tier already owns storage, migrations and graph admission.
// Production applications and Main's lifecycle share this isolated storage.
let firstOperator:
  | { runId: string; email: string; password: string; actingSubject: string }
  | undefined;
interface PersonaOptions {
  /** Retained ranking sources keep bucket time across build and restore. */
  rankingAt?: string;
  /** Retained sources need authority to outlive build, admission and restores. */
  moderatorLifetimeMs?: number;
  /** Observe actual public Main setup attempts, including fixed-key provisioning.
   * A focused probe can end setup here before any joining command. */
  observeMain?: (answer: {
    caller: PersonaSession;
    request: { method: string; url: string; path: string; body: unknown; key: string | null };
    response: { status: number; body: string };
    requestStartedAt: number;
    answeredAt: number;
  }) => Promise<void>;
  /** External delivery service exercised over HTTP by the production adapter. */
  notificationProvider?: { url: string; token: string; callbackSecret: string };
  /** A transparent HTTP proxy may delay real storage responses for race proofs. */
  graphEndpoint?: string;
  /** Additional consent scopes for a fixture's public preparation commands. */
  extraScopes?: readonly string[];
  observeAccount?: PersonaOptions['observeMain'];
  retainedOperator?: RetainedPersonaIdentity;
  retainedAuth?: RetainedPersonaAuth;
}
async function applications(options: PersonaOptions) {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Persona sessions require the QA integration tier');
  if (Bun.env.REZICS_QA_BROWSER_OUTCOMES === '1') {
    // The browser stack already chose its first administrator. API proofs sign
    // in as that same fixture identity; they never designate a second holder.
    const file = Bun.env.REZICS_WEB_AUTH_PRIVATE_PATH;
    if (!file) throw new Error('Shared browser outcome requires its private fixture');
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
      member: { id: string; email: string; password: string }; actingSubject: string;
    };
    if (fixture.member?.id !== Bun.env.PLATFORM_FIRST_ADMIN_ACCOUNT
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(fixture.actingSubject))
      throw new Error('Shared browser outcome must retain the configured first administrator');
    firstOperator = { runId, email: fixture.member.email, password: fixture.member.password,
      actingSubject: fixture.actingSubject };
  }
  const auth = options.retainedAuth ? undefined : await joiningAuthFixture(runId, options.extraScopes);
  const authDirectory = auth ? dirname(auth.publicConfigPath) : undefined;
  const runtime = auth ? readEnv(auth.runtimeEnvPath) : {
    ACCOUNT_ISSUER: `${options.retainedAuth!.accountOrigin}/api/auth`,
    ACCOUNT_MAIN_CLIENT_ID: options.retainedAuth!.mainClientId,
    ACCOUNT_MAIN_CLIENT_SECRET: options.retainedAuth!.mainClientSecret,
  };
  const publicAuth = options.retainedAuth ?? JSON.parse(readFileSync(auth!.publicConfigPath, 'utf8')) as {
    clientId: string;
    redirectUris: string[];
    scope: string;
  };
  const accountBase = options.retainedAuth?.accountOrigin ?? Bun.env.ACCOUNT_BASE_URL!;
  const accountService = options.retainedAuth ? Bun.env.ACCOUNT_SERVICE_ORIGIN ?? accountBase : accountBase;
  const mainBase = `http://127.0.0.1:${Bun.env.MAIN_PORT}`;
  const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
  const compose = readEnv(resolve('.temp/stack', `rezics-qa-${runId}`, 'compose.env'));
  const config = mainConfig({ ...process.env, ...runtime, PLATFORM_FIRST_ADMIN_ACCOUNT: undefined,
    REZICS_STACK_PROFILE: compose.REZICS_STACK_PROFILE,
    ...(options.rankingAt === undefined ? {} : { REZICS_QA_RANKING_AT: options.rankingAt }),
    ...(options.notificationProvider ? {
      MAIN_NOTIFICATION_PROVIDER_URL: options.notificationProvider.url,
      MAIN_NOTIFICATION_PROVIDER_TOKEN: options.notificationProvider.token,
      MAIN_NOTIFICATION_CALLBACK_SECRET: options.notificationProvider.callbackSecret,
    } : {}),
  });
  const accountPool = boundedPool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = boundedPool({ connectionString: config.ACCESS_DATABASE_URL });
  const contentPool = boundedPool({ connectionString: config.CONTENT_DATABASE_URL });
  const relayUrl = config.MAIN_RELAY_DATABASE_URL;
  const relayPool = relayUrl ? boundedPool({ connectionString: relayUrl, max: 2,
    options: '-c default_transaction_read_only=on' }) : undefined;
  const erasureRelayUrl = relayUrl ?? config.ACCOUNT_RELAY_DATABASE_URL;
  const erasureRelayPool = erasureRelayUrl ? boundedPool({ connectionString: erasureRelayUrl, max: 2 }) : undefined;
  const ownerRelayUrl = config.OWNER_RELAY_DATABASE_URL ?? relayUrl;
  const ownerRelayPool = ownerRelayUrl ? boundedPool({ connectionString: ownerRelayUrl, max: 4 }) : undefined;
  const recommendationRelayUrl = config.ACCOUNT_RELAY_DATABASE_URL ?? relayUrl;
  const recommendationRelayPool = recommendationRelayUrl ? boundedPool({ connectionString: recommendationRelayUrl,
    max: 2, options: '-c default_transaction_read_only=on' }) : undefined;
  const pools = [accountPool, accessPool, contentPool, relayPool, erasureRelayPool,
    ownerRelayPool, recommendationRelayPool];
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
          const stoppingRelay = relay?.exitCode === null;
          if (stoppingRelay) relay!.kill('SIGTERM');
          const code = await relay?.exited;
          if (code !== undefined && code !== 0 && !(stoppingRelay && code === 143))
            throw new Error(`Main relay exited with ${code}`);
        } finally {
          await lifecycle?.stop();
        }
      } finally {
        await account?.stop(true);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool?.end()));
      if (authDirectory) rmSync(authDirectory, { recursive: true, force: true });
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
    // Content DDL has production's separate preparation lane, outside request bounds.
    const migrationPool = new Pool({ connectionString: config.CONTENT_DATABASE_URL, max: 1 });
    try { await migrateContent(migrationPool); } finally { await migrationPool.end(); }
    const relayEnvironment = { ...process.env, ...runtime };
    const relayStarted = performance.now();
    const initialization = Bun.spawn([process.execPath, 'services/main/src/relay-init.ts'], {
      env: relayEnvironment, stdout: 'inherit', stderr: 'inherit',
    });
    const initialized = await initialization.exited;
    if (initialized !== 0) throw new Error(`Main relay initialization exited with ${initialized}`);
    console.log(`Persona Main relay initialization: ${((performance.now() - relayStarted) / 1000).toFixed(2)}s`);
    const composed = await composeMain({
      config,
      fuseki: new FusekiClient(
        options.graphEndpoint ?? Bun.env.FUSEKI_URL!,
        Bun.env.FUSEKI_MAINTENANCE_TOKEN,
        Bun.env.FUSEKI_COMMAND_TOKEN,
      ),
      accessPool,
      contentPool,
      relayPool,
      erasureRelayPool,
      ownerRelayPool,
      recommendationRelayPool,
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
    const signup = async (name: string, retained?: RetainedPersonaIdentity): Promise<PersonaSession> => {
      const previous =
        retained ?? (name === 'operator' ? options.retainedOperator ??
          (firstOperator?.runId === runId ? firstOperator : undefined) : undefined);
      const emailAddress = previous?.email ?? `persona-${name}-${randomUUID()}@example.test`;
      const password = previous?.password ?? randomBytes(24).toString('base64url');
      const anonymous = personaSession(mainBase, accountService, null, undefined, undefined,
        options.observeMain, name, personaRequests, options.observeAccount, accountBase);
      const observeAccountFetch = async (input: string | URL, init?: RequestInit) => {
        const started = Date.now(), response = await fetch(input, init);
        if (options.observeAccount) {
          await response.clone().arrayBuffer();
          const url = new URL(input);
          await options.observeAccount({ caller: anonymous,
            request: { method: init?.method ?? 'GET', url: url.origin + url.pathname, path: url.pathname, body: null, key: null },
            response: { status: response.status, body: '' }, requestStartedAt: started, answeredAt: Date.now() });
        }
        return response;
      };
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
          observeAccountFetch(`${mailbox}/api/v1/search?query=${encodeURIComponent(`to:${emailAddress}`)}`),
        );
        if (!inbox.messages[0]) throw new Error(`No verification mail for ${name}`);
        const message = await json<{ Text: string }>(
          observeAccountFetch(`${mailbox}/api/v1/message/${inbox.messages[0].ID}`),
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
      anonymous.accountId = user.user.id;
      anonymous.actingSubject = previous?.actingSubject ?? null;
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      if (!cookie) throw new Error('Account sign-in returned no session cookie');
      const oauth = await signIn(
        {
          account: accountBase,
          service: accountService,
          ...(options.observeAccount ? { fetch: observeAccountFetch } : {}),
          clientId: publicAuth.clientId,
          redirectUri: publicAuth.redirectUris[0]!,
          scope: publicAuth.scope,
          resource,
        },
        cookie,
      );
      const expectedIdentity = retained ?? (name === 'operator' ? options.retainedOperator : undefined);
      if (expectedIdentity && user.user.id !== expectedIdentity.accountId)
        throw new Error('Restored sign-in selected a different Account');
      const person = personaSession(mainBase, accountService, user.user.id, cookie, oauth,
        options.observeMain, name, personaRequests, options.observeAccount, accountBase);
      person.actingSubject =
        previous?.actingSubject ?? (await provisionedAgent(person.main, `Outcome ${name}`));
      await json(
        person.main('PUT', '/v1/me/session-agent', {
          actingSubject: person.actingSubject,
          expectedRevision: null,
        }),
      );
      retainedIdentities.set(person, { email: emailAddress, password,
        accountId: user.user.id, actingSubject: person.actingSubject });
      retainedAuths.set(person, { accountOrigin: accountBase, ...publicAuth,
        mainClientId: runtime.ACCOUNT_MAIN_CLIENT_ID!, mainClientSecret: runtime.ACCOUNT_MAIN_CLIENT_SECRET! });
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
    const designation = options.retainedOperator ? undefined :
      await new AccessPlatformAdministrators(accessPool).designateFirst(`${accountBase}/api/auth`, operator.accountId!);
    const authority = await json<{ groups: string[] }>(
      operator.main('GET', '/v1/me/platform-access'),
    );
    if (designation?.status === 'unconfigured' || !authority.groups.includes('platform-admin'))
      throw new Error(
        'Persona stack must be fresh or retain this harness’s first platform administrator',
      );
    return { signup, operator, visitor: personaSession(mainBase, accountBase, null), close };
  } catch (error) {
    await close();
    throw error;
  }
}

let active: Promise<Awaited<ReturnType<typeof applications>>> | undefined;

/** A real independent Account/Agent without an unrelated Realm and role setup. */
export async function personaAccount(name: string): Promise<PersonaSession> {
  if (!active) throw new Error('Create a persona Realm before adding an independent Account');
  return (await active).signup(name);
}

export type RetainedPersonaRealm = {
  realm: string; space: string; zone: string; visibility: 'public' | 'private';
  identities: Record<Exclude<PersonaName, 'visitor'>, RetainedPersonaIdentity>;
  auth: RetainedPersonaAuth;
};

export function retainPersonaRealm(sessions: PersonaSessions): RetainedPersonaRealm {
  const auth = retainedAuths.get(sessions.owner);
  if (!auth) throw new Error('Persona Realm has no retained OAuth client');
  return { realm: sessions.realm, space: sessions.space, zone: sessions.zone, visibility: sessions.visibility, auth,
    identities: Object.fromEntries(personaNames.filter(name => name !== 'visitor')
      .map(name => [name, retainedPersonaIdentity(sessions[name])])) as RetainedPersonaRealm['identities'] };
}

/** Starts an independent application lifetime against the caller's isolated restored
 * environment. No Realm, membership, role or author is created during restoration. */
export async function restorePersonaRealms(records: readonly RetainedPersonaRealm[],
  options: Pick<PersonaOptions, 'rankingAt' | 'graphEndpoint' | 'observeMain'> = {}): Promise<PersonaSessions[]> {
  if (!records.length) throw new Error('Restored persona Realms are missing');
  const operator = records[0]!.identities.operator;
  if (records.some(record => record.identities.operator.accountId !== operator.accountId))
    throw new Error('Restored Realms must share their retained platform identity');
  if (records.some(record => JSON.stringify(record.auth) !== JSON.stringify(records[0]!.auth)))
    throw new Error('Restored Realms must share their retained Account issuer and OAuth clients');
  const started = performance.now(), stack = await applications({ ...options,
    retainedOperator: operator, retainedAuth: records[0]!.auth });
  try {
    const sessions: PersonaSessions[] = [];
    for (const record of records) {
      const people = new Map<string, PersonaSession>();
      await Promise.all(personaNames.filter(name => name !== 'visitor').map(async name => {
        const identity = record.identities[name];
        const person = name === 'operator' ? stack.operator : await stack.signup(name, identity);
        people.set(name, person);
      }));
      sessions.push({ ...record, visitor: stack.visitor,
        stranger: people.get('stranger')!, member: people.get('member')!, owner: people.get('owner')!,
        moderator: people.get('moderator')!, operator: stack.operator,
        elapsedSeconds: (performance.now() - started) / 1000, close: stack.close });
    }
    return sessions;
  } catch (error) { await stack.close(); throw error; }
}

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
      validUntil: new Date(Date.now() + (options.moderatorLifetimeMs ?? 3_600_000)).toISOString(),
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
