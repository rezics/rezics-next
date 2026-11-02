import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchWriteRequest,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
} from '../services/kernel/test/support/growth-counters.ts';
import {
  exit,
  loadCliDriver,
  type CliDriver,
  type Command,
  type Execution,
  type Invocation,
  type Source,
} from './imports-cli-driver.ts';
import type { Entry } from './imports-vndb-tables-driver.ts';

const origin = 'http://127.0.0.1:43179';
const authOrigin = 'https://auth.importer.test';
const tokens = ['CLI_TOKEN_PRIVATE_ONE', 'CLI_TOKEN_PRIVATE_TWO'];
const accountKey = (() => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return JSON.stringify({
    ...pair.privateKey.export({ format: 'jwk' }),
    kid: 'imports-cli-key',
    alg: 'ES256',
    key_ops: ['sign'],
  });
})();
const markers = [...tokens, 'PRIVATE_SOURCE_MARKER', 'PRIVATE_USER_POST', 'UNLICENSED_DESCRIPTION_SENTINEL'];
const encode = (text: string) => new TextEncoder().encode(text);
async function* chunks(text: string, size = 17) {
  const bytes = encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
function record(source: Exclude<Source, 'vndb'>, title = 'CLI public title', key = 41) {
  const privateFields = { email: markers[2], posts: [markers[3]] };
  if (source === 'bangumi') return JSON.stringify({ id: key, type: 2, name: title, ...privateFields }) + '\n';
  if (source === 'wikidata')
    return (
      JSON.stringify({
        type: 'item',
        id: `Q${key}`,
        lastrevid: 7,
        labels: { en: { language: 'en', value: title } },
        claims: {
          P31: [
            {
              id: `Q${key}$00000000-0000-4000-8000-000000000001`,
              type: 'statement',
              rank: 'normal',
              mainsnak: {
                snaktype: 'value',
                property: 'P31',
                datatype: 'wikibase-item',
                datavalue: {
                  type: 'wikibase-entityid',
                  value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
                },
              },
            },
          ],
        },
        ...privateFields,
      }) + '\n'
    );
  return `/type/work\t/works/OL${key}W\t7\t2024-01-01\t${JSON.stringify({
    key: `/works/OL${key}W`,
    type: { key: '/type/work' },
    revision: 7,
    title,
    ...privateFields,
  })}\n`;
}
async function* vndbEntries(): AsyncGenerator<Entry> {
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    let text = await Bun.file(new URL(`fixtures/imports/vndb-tables/db/${name}`, import.meta.url)).text();
    if (!name.endsWith('.header'))
      text =
        text
          .split('\n')
          .filter((line) => line.startsWith('v123\t'))
          .join('\n') + '\n';
    yield { path: `db/${name}`, kind: 'file', declaredBytes: encode(text).length, bytes: chunks(text, 1) };
  }
}

/** Typed fake remote only: receipts and claim IDs model client responses, not API/Auth correctness. */
class Remote {
  commands: Command[] = [];
  requests: Request[] = [];
  effects = new Map<string, BatchWriteResult['results'][number]>();
  subjects = new Map<string, string>();
  sourceRecords = new Map<string, { record: Record<string, unknown>; revision: number }>();
  before: (request: Request) => Promise<Response | undefined> = async () => undefined;
  async fetch(request: Request): Promise<Response> {
    this.requests.push(request.clone());
    expect(new URL(request.url).origin).toBe(origin);
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toMatch(/^Bearer CLI_TOKEN_PRIVATE_(ONE|TWO)$/);
    const override = await this.before(request);
    if (override) return override;
    const path = new URL(request.url).pathname;
    if (path === '/v1/sourceFences:check') return Response.json({ fenced: false, securityRevision: null });
    if (path === '/v1/source-records:setMetadata') {
      const body = (await request.json()) as {
        source: string;
        external_id: string;
        metadata: Record<string, unknown>;
        expected_metadata_revision: number | null;
      };
      const owner = JSON.stringify([body.source, body.external_id]);
      const prior = this.sourceRecords.get(owner);
      const record =
        body.expected_metadata_revision === null && prior ? { ...prior.record, ...body.metadata } : body.metadata;
      const changed = !prior || JSON.stringify(prior.record) !== JSON.stringify(record);
      const revision = prior ? prior.revision + Number(changed) : 1;
      this.sourceRecords.set(owner, { record, revision });
      return Response.json(
        {
          record,
          metadata_revision: revision,
          effect: !prior
            ? 'filled'
            : changed
              ? body.expected_metadata_revision === null
                ? 'filled'
                : 'corrected'
              : 'noEffect',
        },
        { status: prior ? 200 : 201 },
      );
    }
    expect(path).toBe('/v1/subjects:batchWrite');
    const body: BatchWriteRequest = await request.json();
    expect(checkBatchWrite(body)).toEqual([]);
    for (const marker of markers) expect(JSON.stringify(body)).not.toContain(marker);
    expect(encode(JSON.stringify(body)).length).toBeLessThanOrEqual(65536);
    expect(body.commands.length).toBeLessThanOrEqual(100);
    const result: BatchWriteResult = {
      results: body.commands.map((command) => {
        this.commands.push(structuredClone(command));
        const cached = this.effects.get(command.key);
        if (cached) return cached;
        const home = JSON.stringify([command.source.source, command.source.external_id]);
        if (command.op === 'create' && !this.subjects.has(home)) this.subjects.set(home, randomUUID());
        if (command.op !== 'create') expect(command.subject).toBe(this.subjects.get(home)!);
        const value =
          command.op === 'create'
            ? { id: this.subjects.get(home)!, revision: 1 }
            : command.op === 'propose'
              ? { candidate: randomUUID(), revision: 1 }
              : { revision: 1 };
        const receipt = { key: command.key, status: 200 as const, value };
        this.effects.set(command.key, receipt);
        return receipt;
      }),
    };
    expect(checkBatchWriteResult(result)).toEqual([]);
    return Response.json(result);
  }
}
async function scenario(body: (h: Harness) => Promise<void>) {
  const create = await loadCliDriver(); // Each scenario must fail here without a production binding.
  const directory = await mkdtemp(join(tmpdir(), 'import-cli-'));
  const h = new Harness(directory);
  let driver: CliDriver | undefined;
  try {
    await writeFile(h.token, accountKey, { mode: 0o600 });
    await chmod(h.token, 0o600);
    driver = await create({
      directory,
      fetch: (request) => h.remote.fetch(request),
      clock: {
        now: () => h.now,
        sleep: async (ms) => {
          h.waits.push(ms);
          h.now += ms;
        },
      },
    });
    h.driver = driver;
    await body(h);
  } finally {
    try {
      await driver?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
class Harness {
  driver!: CliDriver;
  remote = new Remote();
  waits: number[] = [];
  now = 1000;
  token: string;
  state: string;
  constructor(readonly directory: string) {
    this.token = resolve(directory, 'bearer');
    this.state = resolve(directory, 'state.sqlite');
  }
  argv(source: Source = 'wikidata', dump = '-') {
    return [
      '--source',
      source,
      '--dump',
      dump,
      '--state',
      this.state,
      '--api',
      origin,
      '--account-key',
      this.token,
      '--account',
      '6b147e8d-1762-4717-9a65-aeb435cb843e',
      '--client',
      'importer-cli-test',
      '--auth',
      authOrigin,
    ];
  }
  async run(source: Source = 'wikidata', options: Invocation = {}) {
    return this.invoke(this.argv(source), {
      testOrigin: origin,
      ...(source === 'vndb' ? { entries: vndbEntries() } : { stdin: chunks(record(source)) }),
      ...options,
    });
  }
  async invoke(argv: string[], options: Invocation = {}) {
    const result = await this.driver.invoke(argv, options);
    expect(result.openHandles).toBe(0);
    expect(encode(result.stdout + result.stderr).length).toBeLessThanOrEqual(4096);
    for (const marker of markers) expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.counts).toEqual({
      'sqlite statements': result.sql.length,
      'sqlite returned rows': result.sql.reduce((sum, statement) => sum + statement.rows, 0),
    });
    for (const statement of result.sql) expect(statement.sql).not.toMatch(/\bCOUNT\s*\(|\bOFFSET\b/i);
    for (const request of result.requests) {
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.authorization).toMatch(/^Bearer CLI_TOKEN_PRIVATE_(ONE|TWO)$/);
      expect(request.bytes).toBeLessThanOrEqual(65536);
    }
    return result;
  }
  async snapshot(source = 'wikidata') {
    const view = await this.driver.inspect(this.state, source);
    for (const marker of markers) expect(JSON.stringify(view.normalized)).not.toContain(marker);
    return view;
  }
}
function noEffects(result: Execution) {
  expect(result.sql).toEqual([]);
  expect(result.fileWrites).toEqual([]);
  expect(result.tokenReads).toEqual([]);
  expect(result.requests).toEqual([]);
  expect(result.runners).toEqual([]);
}

test('help is bounded and touches no network state or token even with nonexistent paths', async () => {
  await scenario(async (h) => {
    const result = await h.invoke(['--help']);
    expect(result.code).toBe(exit.success);
    for (const flag of ['--source', '--dump', '--state', '--api', '--account-key', '--account', '--client', '--auth'])
      expect(result.stdout).toContain(flag);
    noEffects(result);
  });
});

test('configuration rejects unknown source extra option bad threshold missing paths and unsafe origins before effects', async () => {
  await scenario(async (h) => {
    const valid = h.argv();
    const replace = (flag: string, value: string) => valid.map((arg, i) => (valid[i - 1] === flag ? value : arg));
    const invalid = [
      replace('--source', 'unknown'),
      [...valid, '--extra'],
      ...['-1', '1.01', 'NaN'].map((value) => [...valid, '--disappearance-threshold', value]),
      ...['--source', '--dump', '--state', '--api', '--account-key', '--account', '--client', '--auth'].map((flag) =>
        valid.filter((_, i) => valid[i] !== flag && valid[i - 1] !== flag),
      ),
      ...[
        origin,
        'http://example.org',
        'https://user:pass@example.org',
        'https://example.org/path',
        'https://example.org?query=1',
        'https://example.org#fragment',
      ].map((value) => replace('--api', value)),
    ];
    for (const argv of invalid) {
      const result = await h.invoke(argv);
      expect(result.code).toBe(exit.input);
      expect(result.stderr.trim().length).toBeGreaterThan(0);
      noEffects(result);
    }
    expect(h.remote.requests).toEqual([]);
  });
});

test('missing dump and account key files reject before state writes and network access', async () => {
  await scenario(async (h) => {
    const missing = resolve(h.directory, 'does-not-exist');
    for (const flag of ['--dump', '--account-key']) {
      const argv = h.argv().map((arg, i, all) => (all[i - 1] === flag ? missing : arg));
      const result = await h.invoke(argv, { testOrigin: origin });
      expect(result.code).toBe(exit.input);
      expect(result.fileWrites).toEqual([]);
      expect(result.sql).toEqual([]);
      expect(result.requests).toEqual([]);
      expect(result.stderr.trim()).not.toBe('');
    }
  });
});

test('redirects cannot downgrade or disclose the bearer to another origin', async () => {
  await scenario(async (h) => {
    for (const location of [
      'http://other.invalid/v1/subjects:batchWrite',
      'https://other.invalid/v1/subjects:batchWrite',
    ]) {
      h.remote.before = async () => new Response(null, { status: 307, headers: { Location: location } });
      const result = await h.run();
      expect(result.code).not.toBe(0);
      expect(result.requests.length).toBe(1);
      expect((await h.snapshot()).baseline).toBeNull();
    }
    expect(h.remote.commands).toEqual([]);
  });
});

test('every native source runs its independent real converter decoder and durable state with bounded counters', async () => {
  await scenario(async (h) => {
    const modules = new Set<string>();
    const decoders = new Set<string>();
    for (const source of ['bangumi', 'vndb', 'openlibrary', 'wikidata'] as const) {
      const result = await h.run(source);
      expect(result.code).toBe(exit.success);
      expect(result.runners).toHaveLength(1);
      expect(result.runners[0]).toMatchObject({ source, sourceKind: source, state: h.state });
      expect(result.runners[0]!.converterModule).toContain('conversion');
      expect(result.runners[0]!.decoderModule).toContain('importer');
      modules.add(result.runners[0]!.converterModule);
      decoders.add(result.runners[0]!.decoderModule);
      expect(result.input.records).toBe(1);
      expect(result.stdout).toMatch(/\b1\b/);
      expect(result.stdout).not.toContain('CLI public title');
      expect(result.stdout).not.toContain('Sentinel Harbor');
      expect(result.stdout).not.toContain('"statement"');
      expect(
        h.remote.commands.some(
          (c) =>
            c.op === 'propose' &&
            c.source.source === source &&
            JSON.stringify(c).includes(source === 'vndb' ? 'Sentinel Harbor' : 'CLI public title'),
        ),
      ).toBe(true);
      expect((await h.snapshot(source)).baseline).not.toBeNull();
    }
    expect(modules.size).toBe(4);
    // A shared framed reader may dispatch native decoders; VNDB must use table staging.
    expect(decoders.size).toBeGreaterThanOrEqual(2);
  });
});

test('file input explicit source alias reopen and changed bytes use the real runner without duplicate effects', async () => {
  await scenario(async (h) => {
    const file = resolve(h.directory, 'dump.jsonl');
    const argv = [...h.argv('wikidata', file), '--source-alias', 'wikidata-local', '--disappearance-threshold', '0.2'];
    await writeFile(file, record('wikidata'));
    expect((await h.invoke(argv, { testOrigin: origin })).code).toBe(0);
    const before = h.remote.effects.size;
    expect(before).toBeGreaterThan(0);
    expect((await h.invoke(argv, { testOrigin: origin })).code).toBe(0);
    expect(h.remote.effects.size).toBe(before);
    await writeFile(file, record('wikidata', 'CLI updated title'));
    expect((await h.invoke(argv, { testOrigin: origin })).code).toBe(0);
    expect(h.remote.effects.size).toBeGreaterThan(before);
    expect(
      h.remote.commands.some(
        (c) =>
          c.op === 'propose' && c.source.source === 'wikidata-local' && JSON.stringify(c).includes('CLI updated title'),
      ),
    ).toBe(true);
    await h.snapshot('wikidata-local');
  });
});

test('late malformed and truncated streams publish no earlier proposals or checkpoint', async () => {
  await scenario(async (h) => {
    for (const tail of ['not-json\n', '{"id":"Q99"']) {
      const result = await h.run('wikidata', { stdin: chunks(record('wikidata') + tail, 1) });
      expect(result.code).toBe(exit.input);
      expect(h.remote.commands).toEqual([]);
      expect((await h.snapshot()).baseline).toBeNull();
    }
  });
});

test('mass disappearance has a dedicated nonzero exit and preserves the complete baseline', async () => {
  await scenario(async (h) => {
    expect((await h.run()).code).toBe(0);
    const before = await h.snapshot();
    const effects = h.remote.effects.size;
    expect((await h.run('wikidata', { stdin: chunks('') })).code).toBe(exit.mass);
    expect(await h.snapshot()).toEqual(before);
    expect(h.remote.effects.size).toBe(effects);
  });
});

test('401 and 403 fail safely without anonymous fallback and token rotation is read at request boundaries', async () => {
  await scenario(async (h) => {
    for (const status of [401, 403]) {
      h.remote.before = async () => new Response(tokens[0], { status });
      const start = h.remote.requests.length;
      const result = await h.run();
      expect(result.code).toBe(exit.denied);
      expect(result.stderr.trim()).not.toBe('');
      expect(h.remote.requests.length - start).toBe(1);
      expect((await h.snapshot()).baseline).toBeNull();
    }
    let rotated = false;
    h.remote.before = async () => {
      if (!rotated) {
        rotated = true;
        await writeFile(h.token, tokens[1]!);
      }
      return undefined;
    };
    const result = await h.run();
    expect(result.code).toBe(0);
    expect(result.requests.some((request) => request.authorization === `Bearer ${tokens[1]}`)).toBe(true);
    expect(result.tokenReads.length).toBeGreaterThan(0);
    expect(result.tokenReads.every((read) => read.path === h.token && read.bytes > 0 && read.bytes <= 4096)).toBe(true);
  });
});

test('429 follows production Retry-After and bounded retry exhaustion rather than silent acceptance', async () => {
  await scenario(async (h) => {
    let attempts = 0;
    h.remote.before = async () =>
      ++attempts === 1
        ? new Response('limited', {
            status: 429,
            headers: { 'Retry-After': '2' },
          })
        : undefined;
    expect((await h.run()).code).toBe(0);
    expect(h.waits).toContain(2000);
    h.remote.before = async () => new Response('limited', { status: 429, headers: { 'Retry-After': '2' } });
    const before = await h.snapshot();
    const result = await h.run('wikidata', { stdin: chunks(record('wikidata', 'changed')) });
    expect(result.code).not.toBe(0);
    expect(result.requests.length).toBe(3); // Actual import-fetch default maxAttempts.
    expect((await h.snapshot()).baseline).toBe(before.baseline);
  });
});

test('abort after durable preparation closes handles and replays original journal keys on rerun', async () => {
  await scenario(async (h) => {
    const abort = new AbortController();
    let attempted: string[] = [];
    h.remote.before = async (request) => {
      if (new URL(request.url).pathname === '/v1/subjects:batchWrite') {
        const body: BatchWriteRequest = await request.clone().json();
        attempted = body.commands.map((command) => command.key);
        abort.abort(new DOMException('SIGINT', 'AbortError'));
        throw abort.signal.reason;
      }
      return undefined;
    };
    expect((await h.run('wikidata', { signal: abort.signal })).code).toBe(exit.interrupted);
    expect(attempted.length).toBeGreaterThan(0);
    const pending = await h.snapshot();
    expect(pending.baseline).toBeNull();
    expect(pending.pendingKeys).toEqual(expect.arrayContaining(attempted));
    h.remote.before = async () => undefined;
    expect((await h.run()).code).toBe(0);
    expect(h.remote.commands.map((c) => c.key)).toEqual(expect.arrayContaining(attempted));
    expect((await h.snapshot()).pendingKeys).toEqual([]);
  });
});

test('overlapping same-source invocations report busy while a different source remains runnable', async () => {
  await scenario(async (h) => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    h.remote.before = async () => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return undefined;
    };
    const running = h.run();
    try {
      await ready;
      // Invoke directly: the first run legitimately still owns an open handle.
      const busy = await h.driver.invoke(h.argv(), { testOrigin: origin, stdin: chunks(record('wikidata')) });
      expect(busy.code).toBe(exit.busy);
      expect(busy.requests).toEqual([]);
      const other = await h.driver.invoke(h.argv('bangumi'), { testOrigin: origin, stdin: chunks(record('bangumi')) });
      expect(other.code).toBe(0);
    } finally {
      release();
      await running;
    }
  });
});

test('fixed changes retain indexed bounded costs across three state scales and streaming stays proportional to supplied bytes', async () => {
  await scenario(async (h) => {
    const fixedCheck: CountedCheck = {
      read: (result) => (result as Execution).counts,
      bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
      slack: {
        'sqlite statements': { absolute: 0, relative: 0 },
        'sqlite returned rows': { absolute: 2, relative: 0.1 },
      },
    };
    const streamingCheck: CountedCheck = {
      read: (result) => {
        const { input } = result as Execution;
        return { 'input bytes': input.bytes, 'input records': input.records };
      },
      bounds: { 'input bytes': 'linear', 'input records': 'linear' },
      slack: {
        'input bytes': { absolute: 2, relative: 0.1 },
        'input records': { absolute: 0, relative: 0 },
      },
    };
    const fixed: { scale: number; counted: CountedSample }[] = [];
    const streaming: { scale: number; counted: CountedSample }[] = [];
    for (const scale of [1, 8, 64]) {
      h.state = resolve(h.directory, `scale-${scale}.sqlite`);
      await h.driver.seed(h.state, scale);
      const result = await h.run();
      expect(result.code).toBe(0);
      expect(result.sql.length).toBeGreaterThan(0);
      for (const statement of result.sql) {
        expect(statement.plan.join('\n')).not.toMatch(/\bSCAN (?!CONSTANT ROW)|USE TEMP B-TREE|AUTOMATIC/i);
        for (const detail of statement.plan.filter((plan) => /\bSEARCH\b/i.test(plan))) {
          expect(detail).toMatch(
            /USING (?:COVERING )?(?:INDEX .+|INTEGER PRIMARY KEY|PRIMARY KEY)\s*\([^)]*[=<>][^)]*\)/i,
          );
        }
        if (/^\s*(?:SELECT|WITH|UPDATE|DELETE)\b/i.test(statement.sql)) {
          expect(statement.plan.length).toBeGreaterThan(0);
        }
      }
      fixed.push({ scale, counted: countedSample([fixedCheck.read(result, scale)]) });
      const text = Array.from({ length: scale }, (_, i) => record('wikidata', 'Streaming title', 100 + i)).join('');
      const stream = await h.run('wikidata', { stdin: chunks(text, scale) });
      // A disjoint snapshot intentionally trips mass protection after the streaming pass.
      expect(stream.code).toBe(exit.mass);
      expect(stream.input).toMatchObject({ bytes: encode(text).length, records: scale, passes: 1 });
      expect(stream.input.peakBufferedBytes).toBeLessThanOrEqual(65536 * 2);
      expect(stream.input.maxPageRecords).toBeLessThanOrEqual(100);
      streaming.push({ scale, counted: countedSample([streamingCheck.read(stream, scale)]) });
    }
    expect(countedViolations(fixedCheck, fixed)).toEqual([]);
    expect(countedViolations(streamingCheck, streaming)).toEqual([]);
  });
});
