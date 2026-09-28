import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, createGzip } from 'node:zlib';

// A local stand-in for Cloudflare's edge in front of `wrangler dev`, so lab
// numbers reflect production delivery rather than the local server's:
// - HTTP/2 over TLS, so a page's many module chunks share one connection
//   instead of queueing six at a time on HTTP/1.1;
// - streaming gzip that flushes every chunk the Worker writes. Miniflare
//   compresses with a buffering encoder, which holds a streamed page's shell
//   until its slowest Suspense boundary resolves; the edge does not.
// Sign in against the Worker directly: cookies are scoped to the host, not the
// port, so the session carries over to this origin.

const compressible = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
const hopByHop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection',
  'content-encoding', 'content-length', 'host']);

export interface PerfEdge { origin: string; close(): Promise<void> }

/** Start the edge on a random loopback port in front of `upstream`. Needs `openssl` for a throwaway certificate. */
export async function startPerfEdge(upstream: string): Promise<PerfEdge> {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-perf-edge-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem')], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr}`);
  const key = readFileSync(join(directory, 'key.pem'));
  const cert = readFileSync(join(directory, 'cert.pem'));
  rmSync(directory, { recursive: true, force: true });
  const server = createSecureServer({ key, cert, allowHTTP1: true },
    (request, response) => void forward(upstream, request, response));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { origin: `https://127.0.0.1:${port}`,
    close: () => new Promise<void>(done => server.close(() => done())) };
}

async function forward(upstream: string, request: Http2ServerRequest, response: Http2ServerResponse) {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.startsWith(':') || hopByHop.has(name) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('accept-encoding', 'identity');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    const answer = await fetch(new URL(request.url, upstream), { method: request.method, headers, body,
      redirect: 'manual' });
    const gzip = answer.body && compressible.test(answer.headers.get('content-type') ?? '')
      && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
    const out: Record<string, string | string[]> = {};
    answer.headers.forEach((value, name) => { if (!hopByHop.has(name) && name !== 'set-cookie') out[name] = value; });
    const cookies = answer.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    const location = answer.headers.get('location');
    if (location?.startsWith(upstream)) out.location = location.slice(upstream.length) || '/';
    if (gzip) out['content-encoding'] = 'gzip';
    response.writeHead(answer.status, out);
    if (!answer.body) { response.end(); return; }
    // Flush after every upstream chunk so streamed HTML reaches the browser as the Worker writes it.
    const encoder = gzip ? createGzip({ level: 6 }) : null;
    encoder?.pipe(response);
    const reader = answer.body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      if (!encoder) { response.write(read.value); continue; }
      encoder.write(read.value);
      await new Promise<void>(done => encoder.flush(constants.Z_SYNC_FLUSH, () => done()));
    }
    if (encoder) encoder.end();
    else response.end();
  } catch (error) {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(String(error));
  }
}
