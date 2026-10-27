const accountId = 'screenshot-account';
const now = Date.now();

export const fakePrivacyContactUrl = 'mailto:privacy@example.test';

export type FakeAuthRequest = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
};

type FakeAuthOptions = {
  onRequest?: (request: FakeAuthRequest) => void | Promise<void>;
  state?: FakeAuthState;
};

export type FakeAuthState = {
  signedOut: boolean;
  sessionFresh: boolean;
  signInSucceeds: boolean;
  organizationsOpen: boolean;
  denyAccountOperation: boolean;
  dropFirstExecuteResponse: boolean;
  sessionCount: number;
  organizationCount: number;
};

export function createFakeAuthState(overrides: Partial<FakeAuthState> = {}): FakeAuthState {
  return {
    signedOut: false,
    sessionFresh: true,
    signInSucceeds: false,
    organizationsOpen: true,
    denyAccountOperation: false,
    dropFirstExecuteResponse: false,
    sessionCount: 4,
    organizationCount: 1,
    ...overrides,
  };
}

const sessions = [
  {
    id: 'current-session',
    client_id: 'login',
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString(),
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    current: true,
  },
  {
    id: 'desktop-session',
    client_id: 'rezics-website',
    created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString(),
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    current: false,
  },
  {
    id: 'phone-session',
    client_id: 'reading-app',
    created_at: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    user_agent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    client_display_name: 'REZICS Reading Companion',
    current: false,
  },
  {
    id: 'unknown-session',
    client_id: 'unregistered-client',
    created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
    user_agent: 'Unrecognized Client/1.0',
    current: false,
  },
];

export function startFakeAuth(options: FakeAuthOptions = {}) {
  process.env.PRIVACY_CONTACT_URL ??= fakePrivacyContactUrl;
  const state = options.state ?? createFakeAuthState();
  const approvals = new Map<string, { operation: unknown; reference: string }>();
  const results = new Map<string, { operation: unknown; result: { accountId: string } }>();
  let droppedExecuteResponse = false;

  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers({ 'cache-control': 'no-store' });
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
      await options.onRequest?.({
        method: request.method,
        url: url.pathname + url.search,
        body,
        headers: Object.fromEntries(request.headers.entries()),
      });

      if (url.pathname === '/signin' && request.method === 'POST') {
        if (state.signInSucceeds) {
          state.signedOut = false;
          state.sessionFresh = true;
          headers.append('set-cookie', 'auth_session=fake-fresh-session; Path=/; HttpOnly; SameSite=Lax');
          return Response.json({ success: true }, { headers });
        }
        return Response.json({ error: 'authentication_denied' }, { status: 401, headers });
      }

      if (url.pathname === '/consent/screenshot-client' && request.method === 'GET')
        return Response.json(
          {
            client_id: 'screenshot-client',
            display_name: 'REZICS Reading Companion',
            scopes: ['openid', 'offline_access'],
            granted: ['openid'],
          },
          { headers },
        );

      if (url.pathname === '/session' && request.method === 'GET') {
        if (state.signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
        return Response.json(
          { account_id: accountId, holdings: { sessions: state.sessionCount, organizations: state.organizationCount } },
          { headers },
        );
      }

      if (url.pathname === '/sessions' && request.method === 'GET') {
        if (state.signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
        return Response.json(
          { sessions: sessions.slice(0, Math.min(sessions.length, state.sessionCount)) },
          { headers },
        );
      }

      if (url.pathname === '/account-operations/approve' && request.method === 'POST') {
        const payload = JSON.parse(body) as { operationKey?: string; operation?: unknown };
        const operationKey = payload.operationKey ?? '';
        const operation = payload.operation as { kind?: string } | undefined;
        if (state.signedOut) return Response.json({ error: 'authentication_required' }, { status: 401, headers });
        if (!state.sessionFresh)
          return Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401, headers });
        if (operation?.kind === 'organization' && !state.organizationsOpen)
          return Response.json({ error: 'platform_closed', effect_status: 'not_applied' }, { status: 403, headers });
        if (state.denyAccountOperation)
          return Response.json(
            { error: 'account_operation_denied', effect_status: 'not_applied' },
            { status: 409, headers },
          );
        const reference = `approval-${operationKey}`;
        approvals.set(operationKey, { operation: payload.operation, reference });
        return Response.json({ reference, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { headers });
      }

      if (url.pathname === '/account-operations/execute' && request.method === 'POST') {
        const payload = JSON.parse(body) as { operationKey?: string; operation?: unknown; reference?: string };
        const operationKey = payload.operationKey ?? '';
        const approved = approvals.get(operationKey);
        const previous = results.get(operationKey);
        if (!previous && (!approved || approved.reference !== payload.reference))
          return Response.json({ error: 'account_operation_denied' }, { status: 403, headers });
        const operation = payload.operation as { kind?: string; accountId?: string } | undefined;
        if (
          JSON.stringify(previous?.operation ?? approved?.operation) !== JSON.stringify(payload.operation) ||
          (approved && approved.reference !== payload.reference)
        )
          return Response.json({ error: 'account_operation_denied' }, { status: 403, headers });
        if (previous) {
          if (operation?.kind === 'delete') {
            state.signedOut = true;
            headers.append('set-cookie', 'auth_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
          }
          return Response.json(previous.result, { headers });
        }
        const result = {
          accountId: operation?.kind === 'delete' ? (operation.accountId ?? accountId) : 'created-account',
        };
        results.set(operationKey, { operation: payload.operation, result });
        if (operation?.kind === 'delete') state.signedOut = true;
        if (state.dropFirstExecuteResponse && !droppedExecuteResponse) {
          droppedExecuteResponse = true;
          return Response.json({ error: 'unavailable' }, { status: 503, headers });
        }
        if (operation?.kind === 'delete')
          headers.append('set-cookie', 'auth_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
        return Response.json(result, { headers });
      }

      if (url.pathname === '/sessions/revoke' && request.method === 'POST') {
        const payload = JSON.parse(body) as { session_id?: string };
        if (payload.session_id === 'current-session')
          headers.append('set-cookie', 'auth_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
        return Response.json({}, { headers });
      }

      return new Response('Not Found', { status: 404, headers });
    },
  });
}
