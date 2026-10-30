import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { createAccountTokenProvider, CredentialServiceError } from '../src/credentials.ts';

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'imports-auth-cancel-'));
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = join(dir, 'account.jwk');
  await writeFile(
    key,
    JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'ES256', kid: 'fixture' }),
    { mode: 0o600 },
  );
  const dump = join(dir, 'source.jsonl');
  await writeFile(dump, '{"id":1,"type":1,"name":"Book"}\n');
  const account = '00000000-0000-4000-8000-000000000001';
  const authOrigin = 'https://auth.rezics.test';
  const args = [
    '--source',
    'bangumi',
    '--dump',
    dump,
    '--state',
    join(dir, 'state.sqlite'),
    '--api',
    'https://api.rezics.test',
    '--account-key',
    key,
    '--account',
    account,
    '--client',
    'rezics-importer',
    '--auth',
    authOrigin,
  ];
  return { dir, key, account, authOrigin, args };
}

test('ordinary CLI interruption aborts its real Auth request without a later token exchange', async () => {
  const f = await world();
  const controller = new AbortController();
  const paths: string[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let held: Request | undefined;
  let finish!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    paths.push(new URL(request.url).pathname);
    if (paths.length !== 1) throw new Error('Unexpected successor request');
    held = request;
    started();
    return waiting;
  }) as typeof fetch;
  const run = runImportCli(f.args, { fetch: fetcher, signal: controller.signal });
  try {
    await ready;
    controller.abort(new DOMException('Operator stop', 'AbortError'));
    const result = await run;
    expect(result.code).toBe(130);
    expect(result.openHandles).toBe(0);
    expect(held!.signal.aborted).toBe(true);
    expect(paths).toEqual(['/signin/key']);
  } finally {
    controller.abort();
    finish(new Response('{}', { status: 503 }));
    await run;
    await rm(f.dir, { recursive: true, force: true });
  }
}, 10000);

test('oversized account-key Auth body is cancelled and never supplies a token', async () => {
  const f = await world();
  let cancellations = 0;
  let requests = 0;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancellations++;
    },
  });
  try {
    const token = await createAccountTokenProvider({
      accountKeyPath: f.key,
      account: f.account,
      client: 'rezics-importer',
      authOrigin: f.authOrigin,
      fetch: (async (_input: RequestInfo | URL) => {
        requests++;
        return new Response(body, { status: 200, headers: { 'set-cookie': 'fixture=session; Secure; HttpOnly' } });
      }) as typeof fetch,
    });
    await expect(token()).rejects.toBeInstanceOf(CredentialServiceError);
    expect(requests).toBe(1);
    expect(cancellations).toBe(1);
  } finally {
    if (!body.locked) await body.cancel().catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  }
}, 10000);
