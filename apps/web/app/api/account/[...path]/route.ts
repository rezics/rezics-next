import { sameOriginWrite, serviceOrigin } from '../../../../features/api/origins.ts';

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path.length || path.length > 8 || path.some(item => !/^[A-Za-z0-9_-]+$/.test(item))) {
    return Response.json({ error: 'unknown Account path' }, { status: 404 });
  }
  if (request.method !== 'GET' && !sameOriginWrite(request)) {
    return Response.json({ error: 'origin mismatch' }, { status: 403 });
  }
  const input = new URL(request.url);
  const target = new URL(`/api/auth/${path.join('/')}${input.search}`, serviceOrigin('ACCOUNT_ORIGIN'));
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (request.method !== 'GET') headers.set('origin', serviceOrigin('ACCOUNT_ORIGIN'));
  const response = await fetch(target, { method: request.method, headers,
    body: request.method === 'GET' ? undefined : request.body, duplex: 'half',
    redirect: 'manual', cache: 'no-store' } as RequestInit);
  const outgoing = new Headers(response.headers);
  outgoing.delete('content-encoding');
  outgoing.delete('content-length');
  outgoing.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: outgoing });
}

export const GET = proxy;
export const POST = proxy;
