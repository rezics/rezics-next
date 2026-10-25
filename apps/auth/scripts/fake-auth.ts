const accountId = 'screenshot-account';
const now = Date.now();

export type FakeAuthRequest = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
};

type FakeAuthOptions = {
  onRequest?: (request: FakeAuthRequest) => void | Promise<void>;
};

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

      if (url.pathname === '/signin' && request.method === 'POST')
        return Response.json({ error: 'authentication_denied' }, { status: 401, headers });

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

      if (url.pathname === '/session' && request.method === 'GET')
        return Response.json({ account_id: accountId }, { headers });

      if (url.pathname === '/sessions' && request.method === 'GET') return Response.json({ sessions }, { headers });

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
