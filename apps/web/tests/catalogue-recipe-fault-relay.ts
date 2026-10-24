import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mainBodyRead } from '../features/api/main-read-operation.ts';

type Phase = 'healthy' | 'network' | 'unavailable' | 'recovered';
export interface RecipeFaultRead {
  sequence: number;
  phase: Phase;
  method: 'GET';
  pathname: string;
  search: string;
  outcome: 'forwarded' | 'connection-destroyed' | '503' | 'upstream-error';
  status: number | null;
  bytes: number;
  sha256: string | null;
}

/**
 * Proposed C31 SSR transport adapter; importing it starts nothing. The selected
 * runner owns its lifetime and gives only its isolated frontend this MAIN_ORIGIN.
 * See catalogue-browser-recovery-qualification.md before adapting the frozen test.
 * Successful answers are streamed from the retained Main without substitution.
 */
export async function startCatalogueRecipeFaultRelay(upstreamOrigin: string, recipeId: string) {
  const upstream = new URL(upstreamOrigin);
  assert(upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1' &&
    upstream.pathname === '/' && !upstream.search && !upstream.hash && !upstream.username && !upstream.password,
  'Use the admitted isolated loopback Main origin');
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(recipeId), 'Use the retained native Recipe UUID');
  const pathname = `/v1/recipes/works/${recipeId}`;
  const reads: RecipeFaultRead[] = [];
  let phase: Phase = 'healthy';
  let sequence = 0;
  let pending = 0;
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://relay.invalid');
    // Preserve the owner's body-bearing reads too (for example adoptions via
    // POST /v1/query). A relay that blocks them would introduce sibling faults.
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && !mainBodyRead(url.pathname, incoming.method)) {
      outgoing.writeHead(405).end();
      return;
    }
    const selected = incoming.method === 'GET' && url.pathname === pathname;
    const currentPhase = phase;
    const currentSequence = selected ? ++sequence : 0;
    if (selected) pending++;
    let finished = false;
    const finish = (outcome: RecipeFaultRead['outcome'], status: number | null, bytes = 0, sha256: string | null = null) => {
      if (!selected || finished) return;
      finished = true;
      pending--;
      reads.push({ sequence: currentSequence, phase: currentPhase, method: 'GET', pathname: url.pathname,
        search: url.search, outcome, status, bytes, sha256 });
    };
    if (selected && currentPhase === 'network') {
      // A real server-to-Main HTTP request reached this socket. Fail delivery;
      // do not increment a counter from a browser action or a synthetic request.
      incoming.socket.destroy();
      finish('connection-destroyed', null);
      return;
    }
    if (selected && currentPhase === 'unavailable') {
      const body = JSON.stringify({ error: 'work_read_unavailable', message: 'Temporarily unavailable' });
      outgoing.writeHead(503, { 'content-type': 'application/json' }).end(body);
      finish('503', 503, Buffer.byteLength(body));
      return;
    }
    const destination = new URL(upstream);
    destination.pathname = url.pathname;
    destination.search = url.search;
    const forwarded = request(destination, { method: incoming.method, headers: { ...incoming.headers, host: upstream.host } }, remote => {
      outgoing.writeHead(remote.statusCode ?? 502, remote.headers);
      let bytes = 0;
      const digest = createHash('sha256');
      remote.on('data', (chunk: Buffer) => {
        if (selected) { bytes += chunk.length; digest.update(chunk); }
      });
      remote.once('end', () => finish('forwarded', remote.statusCode ?? 502, bytes, selected ? digest.digest('hex') : null));
      remote.once('error', () => { finish('upstream-error', remote.statusCode ?? null, bytes); outgoing.destroy(); });
      remote.pipe(outgoing);
    });
    forwarded.once('error', () => {
      finish('upstream-error', null);
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    });
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) { finish('upstream-error', null); forwarded.destroy(); }
    });
    incoming.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    pathname,
    arm(transport: 'network' | 'unavailable') {
      assert(phase === 'healthy' && pending === 0, 'Arm only after the healthy render has settled');
      assert(reads.some(read => read.phase === 'healthy' && read.outcome === 'forwarded' && read.status === 200),
        'The genuine initial Recipe read must have traversed this relay successfully');
      phase = transport;
    },
    recover() {
      assert((phase === 'network' || phase === 'unavailable') && pending === 0);
      assert(reads.some(read => read.phase === phase &&
        (read.outcome === 'connection-destroyed' || read.outcome === '503')), 'Observe the actual fault before allowing Retry');
      phase = 'recovered';
    },
    evidence(): RecipeFaultRead[] { return reads.map(read => ({ ...read })); },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
