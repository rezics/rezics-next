import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../dev/config.ts';
import { SeedApi, type SeedEndpoints } from '../dev/seed/api.ts';
import { people } from '../dev/seed/plan.ts';
import {
  ensureDatasetAdminAccount,
  ensureDatasetAdminAccess,
  datasetStackMarker,
  inspectDatasetBulkOwnerStatus,
  type DatasetBulkOwnerStatus,
} from './bootstrap.ts';
import { atomicJson, repository, sha256 } from './store.ts';

export interface DatasetApi {
  /** Transport tests may advance retry scheduling without real sleeps. */
  wait?: (milliseconds: number) => Promise<void>;
  /** Dedicated local administrator only: immutable owner-terminal recovery. */
  bulkStatus?: (key: string) => Promise<DatasetBulkOwnerStatus>;
  request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}
export interface DatasetSession {
  api: DatasetApi;
  mainOrigin: string;
  webOrigin: string;
  actingSubject: string;
}
export class DatasetApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: Record<string, unknown>,
  ) {
    super(
      `${method} ${path}: HTTP ${status} ${typeof detail.code === 'string' ? detail.code : ''}`,
    );
  }
}
function local(origin: string): string {
  const url = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Dataset import requires explicit loopback API origins');
  }
  return url.origin;
}

async function datasetToken(endpoints: SeedEndpoints, cookie: string): Promise<string> {
  const { account, clientId, redirectUri, scope, resource } = endpoints;
  const service = endpoints.accountService ?? account;
  const policiesResponse = await fetch(`${service}/api/account/policies`, { headers: { cookie } });
  if (!policiesResponse.ok)
    throw new Error(`Dataset operator policies: HTTP ${policiesResponse.status}`);
  const policies = (await policiesResponse.json()) as {
    acceptanceRequired: boolean;
    policies: { policyId: string; versionDigest: string }[];
  };
  if (policies.acceptanceRequired) {
    const accepted = await fetch(`${service}/api/account/policies/acceptance`, {
      method: 'POST',
      headers: { cookie, origin: account, 'content-type': 'application/json' },
      body: JSON.stringify({
        acceptedPolicies: policies.policies.map(({ policyId, versionDigest }) => ({
          policyId,
          versionDigest,
        })),
      }),
    });
    if (!accepted.ok)
      throw new Error(`Dataset operator policy acceptance: HTTP ${accepted.status}`);
    await accepted.body?.cancel();
  }
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${service}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    resource,
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    authorize.searchParams.set(key, value);
  const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  if (authorized.status !== 302 || !authorized.headers.get('location')) {
    throw new Error(`Public dataset OAuth authorization: HTTP ${authorized.status}`);
  }
  let location = new URL(authorized.headers.get('location')!, account);
  const query =
    location.searchParams.get('oauth_query') ??
    (location.searchParams.has('sig') ? location.search.slice(1) : null);
  if (query) {
    const consent = await fetch(`${service}/api/account/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, origin: account, 'content-type': 'application/json' },
      body: JSON.stringify({ oauth_query: query, accept: true, scope }),
    });
    if (consent.headers.get('location'))
      location = new URL(consent.headers.get('location')!, account);
    else {
      if (!consent.ok) throw new Error(`Public dataset OAuth consent: HTTP ${consent.status}`);
      const decision = (await consent.json()) as { url?: string; redirect_uri?: string };
      if (!(decision.url ?? decision.redirect_uri))
        throw new Error('Dataset OAuth consent returned no callback');
      location = new URL((decision.url ?? decision.redirect_uri)!, account);
    }
  }
  const code = location.searchParams.get('code');
  if (!code) throw new Error('Public dataset OAuth authorization returned no code');
  const exchanged = await fetch(`${service}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  if (!exchanged.ok) throw new Error(`Public dataset OAuth exchange: HTTP ${exchanged.status}`);
  const result = (await exchanged.json()) as { access_token?: string };
  if (!result.access_token) throw new Error('Dataset OAuth token response has no access token');
  return result.access_token;
}

/** Uses public sign-in, audited OAuth registration and PKCE only; no owner-store access. */
export async function localDatasetSession(
  stack = process.env.REZICS_DATASET_STACK ?? join(repository, '.temp/stack/rezics-dev'),
  identity = process.env.REZICS_DATASET_IDENTITY ?? 'admin',
): Promise<DatasetSession> {
  if (!['admin', 'operator', 'mei'].includes(identity))
    throw new Error(
      'Dataset identity must be admin, operator or the existing mei development fixture',
    );
  const env = readEnv(join(stack, 'dev.env'));
  const publicConfig = JSON.parse(readFileSync(join(stack, 'web-auth/public.json'), 'utf8')) as {
    clientId: string;
    redirectUris: string[];
    resource: string;
    actingSubject?: string;
  };
  const privateConfig = JSON.parse(readFileSync(join(stack, 'web-auth/private.json'), 'utf8')) as {
    operator?: { id: string; email: string; password: string };
    actingSubject?: string;
  };
  if (!privateConfig.operator)
    throw new Error('Local dataset import needs the existing development operator credentials');
  const resetMarker = datasetStackMarker(env.MAIN_DATA_EPOCH, privateConfig.operator.id);
  const main = local(process.env.REZICS_DATASET_MAIN_ORIGIN ?? env.MAIN_ORIGIN!);
  const account = local(env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!);
  const accountService = local(env.ACCOUNT_SERVICE_ORIGIN ?? account);
  const webOrigin = local(process.env.REZICS_DATASET_WEB_ORIGIN ?? 'http://127.0.0.1:3000');
  const scope =
    'openid agent:create work:create work:edit work:read source:intake source:read classification:define classification:decide statement:write semantic:read';
  const redirectUri = publicConfig.redirectUris[0];
  if (!redirectUri) throw new Error('Local dataset import lacks its OAuth callback');
  const endpoints: SeedEndpoints = {
    main,
    account,
    accountService,
    mailpit: 'http://127.0.0.1:8025',
    clientId: publicConfig.clientId,
    redirectUri,
    resource: publicConfig.resource,
    scope,
    enrollmentToken: env.ACCOUNT_ENROLLMENT_TOKEN,
  };
  const dedicated = identity === 'admin' ? await ensureDatasetAdminAccount(stack, endpoints) : null;
  const credentials = dedicated?.credentials ?? privateConfig.operator;
  const signed = await new SeedApi(endpoints).signInOrUp(credentials);
  if (signed.id !== credentials.id) throw new Error('Dataset operator identity changed');
  const clientPath = join(
    repository,
    '.temp/datasets',
    `oauth-${sha256(`${account}:${signed.id}:${scope}:${resetMarker}`)}.json`,
  );
  let clientId: string | undefined;
  let retainedActor: string | undefined;
  if (existsSync(clientPath)) {
    const retained = JSON.parse(readFileSync(clientPath, 'utf8')) as {
      clientId: string;
      actingSubject?: string;
      stackMarker?: string;
    };
    if (retained.stackMarker !== resetMarker)
      throw new Error('Dataset OAuth metadata belongs to another local stack reset marker');
    clientId = retained.clientId;
    retainedActor = retained.actingSubject;
  }
  if (!clientId) {
    const response = await fetch(`${accountService}/api/auth/oauth2/create-client`, {
      method: 'POST',
      headers: {
        cookie: signed.cookie,
        origin: account,
        'content-type': 'application/json',
        'x-account-reason': 'Register the explicit local real-data development importer',
      },
      body: JSON.stringify({
        client_name: 'Local real datasets',
        application_type: 'native',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        scope,
      }),
    });
    if (!response.ok) throw new Error(`Public dataset OAuth registration: HTTP ${response.status}`);
    const registered = (await response.json()) as { client_id?: string };
    clientId = registered.client_id;
    if (!clientId) throw new Error('Dataset OAuth registration returned no client');
    atomicJson(clientPath, { clientId, stackMarker: resetMarker });
  }
  const installation = await fetch(
    `${accountService}/api/account/installations/${encodeURIComponent(clientId)}`,
    {
      headers: { cookie: signed.cookie, origin: account },
    },
  );
  if (installation.status === 404) {
    await installation.body?.cancel();
    const installed = await fetch(`${accountService}/api/account/installation-changes`, {
      method: 'POST',
      headers: { cookie: signed.cookie, origin: account, 'content-type': 'application/json' },
      body: JSON.stringify({
        change: 'install',
        clientId,
        scopes: scope.split(' '),
        changeKey: `dataset-client:${clientId}`,
      }),
    });
    if (!installed.ok)
      throw new Error(`Public dataset OAuth installation: HTTP ${installed.status}`);
    await installed.body?.cancel();
  } else if (!installation.ok)
    throw new Error(`Public dataset OAuth installation read: HTTP ${installation.status}`);
  else {
    const installed = (await installation.json()) as { state: string; scopes: string[] };
    if (
      installed.state !== 'active' ||
      scope.split(' ').some((value) => !installed.scopes.includes(value))
    ) {
      throw new Error(
        'Dataset OAuth client installation is inactive or lacks the requested capabilities',
      );
    }
  }
  const tokenEndpoints = { ...endpoints, clientId };
  const fixture = people.find((person) => person.id === 'mei')!;
  // Registration/installation stay with the Account operator. An explicitly
  // selected existing fixture authorizes its own import token and controls only
  // the Agent identities returned by its public discovery API.
  const authenticated =
    identity !== 'mei'
      ? signed
      : await new SeedApi(endpoints).signInOrUp({
          email: fixture.email,
          password: fixture.password,
        });
  let token = await datasetToken(tokenEndpoints, authenticated.cookie);
  const api: DatasetApi = {
    ...(identity === 'admin'
      ? {
          bulkStatus: (key: string) =>
            inspectDatasetBulkOwnerStatus(stack, signed.id, actingSubject!, key),
        }
      : {}),
    async request(method, path, body, key) {
      const send = () =>
        fetch(`${main}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        token = await datasetToken(tokenEndpoints, authenticated.cookie);
        response = await send();
      }
      const data = (await response.json()) as Record<string, unknown>;
      return { status: response.status, body: data };
    },
  };
  let actingSubject =
    process.env.REZICS_DATASET_ACTING_SUBJECT ?? (identity !== 'mei' ? retainedActor : undefined);
  if (actingSubject && identity === 'admin' && !process.env.REZICS_DATASET_ACTING_SUBJECT) {
    const controlled = await api.request('GET', '/v1/me/agents');
    if (controlled.status !== 200)
      throw new DatasetApiError('GET', '/v1/me/agents', controlled.status, controlled.body);
    const items = controlled.body.items as { actingSubject: string }[];
    if (!items.some((item) => item.actingSubject === actingSubject)) actingSubject = undefined;
  }
  if (!actingSubject && identity === 'mei') {
    const discovery = await api.request('GET', '/v1/me/agents');
    if (discovery.status !== 200)
      throw new DatasetApiError('GET', '/v1/me/agents', discovery.status, discovery.body);
    const subjects = discovery.body.items as { actingSubject: string; handle: string | null }[];
    actingSubject = subjects.find((subject) => subject.handle === fixture.handle)?.actingSubject;
    if (!actingSubject)
      throw new Error('The selected development fixture has no existing controlled Person Agent');
  }
  if (!actingSubject) {
    let provision;
    for (let attempt = 0; attempt < 8; attempt++) {
      provision = await api.request(
        'POST',
        '/v1/agents',
        { profile: 'agent-provision-v1', kind: 'person', displayName: 'Local dataset operator' },
        `dataset-operator:${sha256(signed.id)}`,
      );
      if (provision.status !== 202 && provision.status !== 503) break;
      await Bun.sleep(250 * (attempt + 1));
    }
    if (!provision) throw new Error('Dataset operator provision did not return a receipt');
    if (
      provision.status === 202 ||
      provision.status >= 300 ||
      provision.body.state !== 'active' ||
      typeof provision.body.agent !== 'string'
    ) {
      throw new DatasetApiError('POST', '/v1/agents', provision.status, provision.body);
    }
    actingSubject = provision.body.agent;
    atomicJson(clientPath, { clientId, actingSubject, stackMarker: resetMarker });
  }
  if (identity === 'admin') await ensureDatasetAdminAccess(stack, signed.id, actingSubject);
  return { api, mainOrigin: main, webOrigin, actingSubject };
}

/** Exposes only endpoint/identity metadata; OAuth tokens and Account credentials stay private. */
export async function preflightDatasetImport(): Promise<{
  mainOrigin: string;
  webOrigin: string;
  actingSubject: string;
  dataEpoch: string;
  actingContexts: string[];
}> {
  const session = await localDatasetSession();
  const basis = await session.api.request('POST', '/v1/catalogue/candidates', {
    profile: 'catalogue-candidates-v1',
    originalTitle: { value: 'Local dataset preflight', language: 'en' },
    aliases: [],
    romanizations: [],
    creators: [],
    dates: [],
    identifiers: [],
  });
  if (basis.status !== 200)
    throw new DatasetApiError('POST', '/v1/catalogue/candidates', basis.status, basis.body);
  const epoch = (basis.body.sourcePosition as { dataEpoch?: unknown } | undefined)?.dataEpoch;
  if (typeof epoch !== 'string') throw new Error('Dataset preflight returned no product epoch');
  const discovery = await session.api.request('GET', '/v1/me/acting-contexts?task=work.create');
  if (discovery.status !== 200)
    throw new DatasetApiError('GET', '/v1/me/acting-contexts', discovery.status, discovery.body);
  const discovered = [
    ...((discovery.body.contexts as { actingSubject: string }[]) ?? []),
    ...((discovery.body.directContexts as { actingSubject: string }[]) ?? []),
  ];
  return {
    mainOrigin: session.mainOrigin,
    webOrigin: session.webOrigin,
    actingSubject: session.actingSubject,
    dataEpoch: epoch,
    actingContexts: discovered.map((context) => context.actingSubject),
  };
}
