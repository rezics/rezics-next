import { cookies } from 'next/headers';
import { sameOriginWrite, serviceOrigin } from '../../../../features/api/origins.ts';

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path[0] !== 'v1' || path.length > 8 || path.some(item => !/^[A-Za-z0-9_-]+$/.test(item))) {
    return Response.json({ error: 'unknown API path' }, { status: 404 });
  }
  if (request.method !== 'GET' && !sameOriginWrite(request)) {
    return Response.json({ error: 'origin mismatch' }, { status: 403 });
  }
  const input = new URL(request.url);
  const target = new URL(`/${path.join('/')}${input.search}`, serviceOrigin('MAIN_ORIGIN'));
  const token = (await cookies()).get('rezics_access')?.value;
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(target, { method: request.method, headers,
    body: request.method === 'GET' ? undefined : request.body, duplex: 'half',
    redirect: 'manual', cache: 'no-store' } as RequestInit);
  const outgoing = new Headers();
  for (const name of ['content-type', 'cache-control', 'retry-after', 'www-authenticate']) {
    const value = response.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: outgoing });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
