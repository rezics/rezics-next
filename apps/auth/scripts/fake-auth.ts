const accountId = 'screenshot-account';
const now = Date.now();

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
    current: false,
  },
];

export function startFakeAuth() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers({ 'cache-control': 'no-store' });

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

      return new Response('Not Found', { status: 404, headers });
    },
  });
}
