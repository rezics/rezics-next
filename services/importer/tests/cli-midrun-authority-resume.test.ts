import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { ImportSession } from '../src/import-session.ts';

// Local protocol proof only: the frozen kernel test owns real Auth/Access/worker acceptance.
test('CLI denial closes handles and retains prepared writes and baseline for a sealed resume', async () => {
  const directory = await mkdtemp('/dev/shm/import-cli-denial-unit-');
  try {
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'operator.jwk');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    await writeFile(
      keyPath,
      JSON.stringify({
        ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
        kid: 'local-unit',
        alg: 'ES256',
      }),
      { mode: 0o600 },
    );
    await writeFile(state, '', { mode: 0o600 });
    const argv = [
      '--source',
      'bangumi',
      '--dump',
      '-',
      '--state',
      state,
      '--api',
      'https://kernel.unit.test',
      '--auth',
      'https://auth.unit.test',
      '--account-key',
      keyPath,
      '--account',
      randomUUID(),
      '--client',
      'unit',
    ];
    const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
    let denied = false;
    const sent: { bytes: string; status: number }[] = [];
    const upstream = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === 'https://auth.unit.test') {
        if (url.pathname === '/signin/key')
          return Response.json(
            {},
            {
              headers: { 'set-cookie': 'unit-session=private; Secure; HttpOnly' },
            },
          );
        expect(url.pathname).toBe('/token');
        return Response.json({ access_token: 'unit-token', token_type: 'Bearer', expires_in: 300 });
      }
      if (url.pathname === '/v1/sourceFences:check') return Response.json({ fenced: false, securityRevision: null });
      expect(url.pathname).toBe('/v1/subjects:batchWrite');
      const bytes = await request.text();
      sent.push({ bytes, status: denied ? 403 : 200 });
      if (denied) return Response.json({ code: 'forbidden' }, { status: 403 });
      const body = JSON.parse(bytes) as BatchWriteRequest;
      return Response.json({
        results: body.commands.map((command) => {
          const prior = receipts.get(command.key);
          if (prior) {
            expect(JSON.stringify(command)).toBe(prior.bytes);
            return prior.result;
          }
          const result = {
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, { bytes: JSON.stringify(command), result });
          return result;
        }),
      });
    }) as typeof fetch;
    async function invoke(name: string) {
      let consumed = 0;
      const text = JSON.stringify({ id: 930001, type: 2, name }) + '\n';
      const result = await runImportCli(argv, {
        fetch: upstream,
        stdin: (async function* () {
          consumed += text.length;
          yield new TextEncoder().encode(text);
        })(),
      });
      expect(result.openHandles).toBe(0);
      return { ...result, consumed };
    }
    function inspect() {
      const session = new ImportSession(state);
      try {
        const active = session.store.activeRun('bangumi');
        return {
          active,
          source: session.store.source('bangumi'),
          baseline: session.store.key('bangumi', '930001').baseline,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          claim: session.bindings.claim({ source: 'bangumi', external_id: '930001' }),
        };
      } finally {
        session.close();
      }
    }
    expect((await invoke('Initial title')).code).toBe(0);
    const before = inspect();
    const originalReceipts = [...receipts.entries()];
    denied = true;
    const start = sent.length;
    expect((await invoke('Changed title')).code).toBe(4);
    const pending = inspect();
    expect(pending.baseline).toEqual(before.baseline);
    expect(pending.source).toEqual(before.source);
    expect(pending.pending).toHaveLength(1);
    expect(sent.slice(start)).toEqual([{ bytes: pending.pending[0]!.bytes, status: 403 }]);
    expect([...receipts.entries()]).toEqual(originalReceipts);
    denied = false;
    const replayStart = sent.length;
    const resumed = await invoke('Distinct successor');
    expect(resumed.code).toBe(0);
    expect(resumed.consumed).toBe(0);
    expect(sent.slice(replayStart).map((request) => request.bytes)).toEqual(pending.pending.map((row) => row.bytes));
    const recovered = inspect();
    expect(recovered.active).toBeNull();
    expect(recovered.claim).toEqual(before.claim);
    expect(recovered.baseline!.digest).not.toBe(before.baseline!.digest);
    expect((await invoke('Distinct successor')).code).toBe(0);
    expect(inspect().baseline!.digest).not.toBe(recovered.baseline!.digest);
    for (const [key, receipt] of originalReceipts) expect(receipts.get(key)).toEqual(receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
