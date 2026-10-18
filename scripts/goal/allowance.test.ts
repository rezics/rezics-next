import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectAllowance, allowanceCommand, type AllowanceTransport } from './allowance.ts';
import { testAccountSettings } from './fixtures/accounts.ts';

const NOW = 1792344566;
// Sanitized from the captured GetAccountRateLimitsResponse and codex-2 live read.
function captured(ordinaryUsageAllowed: boolean | null = true) {
  const limit = { limitId: 'codex', limitName: null, normalModelSlug: null,
    primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1792874437 }, secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: '62500.0000000000' },
    individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null };
  return { accountId: 'private-account-id', ordinaryUsageAllowed, rateLimits: limit,
    rateLimitsByLimitId: { codex: limit }, rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'private-card-later', resetType: 'codexRateLimits', status: 'available', grantedAt: 1791415117, expiresAt: 1794007117 },
      { id: 'private-card-earlier', resetType: 'codexRateLimits', status: 'available', grantedAt: 1790707539, expiresAt: 1793299539 },
    ] } };
}
type Rates = ReturnType<typeof captured>;

function fixture(policy: unknown = ['resetCards', 'credits']) {
  const parent = join(import.meta.dir, '../../.temp/allowance-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-'));
  const home = join(directory, 'home');
  mkdirSync(home);
  const settings = testAccountSettings(directory, [{ engine: 'sample-c', launcher: join(directory, 'launcher'), home,
    pastAllowance: policy as string[] }]);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let rates: unknown = captured();
  let consume: () => unknown | Promise<unknown> = () => { rates = captured(true); return { outcome: 'reset' }; };
  let closed = 0;
  let authenticated = true;
  const transport: AllowanceTransport = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return { codexHome: home, userAgent: 'fixture', platformFamily: 'unix', platformOs: 'linux' };
      if (method === 'account/read') return { account: authenticated ? { type: 'chatgpt', email: 'private@example.com', planType: 'pro' } : null,
        requiresOpenaiAuth: true };
      if (method === 'account/rateLimits/read') return structuredClone(rates);
      if (method === 'account/rateLimitResetCredit/consume') return consume();
      throw new Error('Unexpected request');
    },
    notify(method) { calls.push({ method, params: {} }); },
    async close() { closed++; },
  };
  return { directory, home, settings, calls, transport,
    options: { settings: { directory: settings }, connect: async () => transport,
      now: () => NOW * 1000, lockDirectory: join(directory, 'locks') },
    rates(value: unknown) { rates = value; }, consume(value: () => unknown | Promise<unknown>) { consume = value; },
    auth(value: boolean) { authenticated = value; }, get closed() { return closed; },
    cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}

test('fresh authenticated inspection reports quota, credits and authoritative card count without private fields', async () => {
  const f = fixture();
  try {
    const result = await inspectAllowance('sample-c', f.options);
    expect(result).toMatchObject({ status: 'included', canResume: true, ordinaryUsageAllowed: true,
      quota: { primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1792874437 } },
      credits: { hasCredits: true, balance: '62500.0000000000', authorized: true },
      resetCards: { availableCount: 2, eligibleInDetails: 2 }, redemption: null });
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
    expect(f.calls.at(-1)?.params).toEqual({ excludeResetCreditDetails: false, supportsLunaReserve: false });
    expect(JSON.stringify(result)).not.toMatch(/private|@|codexHome|creditId|accountId|idempotencyKey/);
    expect(f.closed).toBe(1);
  } finally { f.cleanup(); }
});

for (const permission of [true, null, undefined]) test(`continuation never redeems with included or unknown permission (${permission})`, async () => {
  const f = fixture();
  try {
    const rates = captured(permission ?? null);
    if (permission === undefined) delete (rates as Partial<Rates>).ordinaryUsageAllowed;
    rates.rateLimits.primary.usedPercent = 100;
    f.rates(rates);
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    expect(result.status).toBe(permission === true ? 'included' : 'permission-unknown');
    expect(result.canResume).toBe(permission === true);
    expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
  } finally { f.cleanup(); }
});

for (const policy of [[], null, false, ['credits'], ['unknown']]) test(`only explicit resetCards policy permits a redemption (${JSON.stringify(policy)})`, async () => {
  const f = fixture(policy);
  try {
    f.rates(captured(false));
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
    expect(result.canResume).toBe(Array.isArray(policy) && policy.includes('credits'));
  } finally { f.cleanup(); }
});

test('inspection of exhausted allowance never redeems, even with authorization', async () => {
  const f = fixture();
  try {
    f.rates(captured(false));
    expect((await inspectAllowance('sample-c', f.options)).canResume).toBe(false);
    expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
  } finally { f.cleanup(); }
});

test('continuation picks earliest expiry, uses the exact consume schema, and confirms recovery with a fresh read', async () => {
  const f = fixture();
  try {
    const rates = captured(false);
    rates.rateLimitResetCredits.credits.unshift({ ...rates.rateLimitResetCredits.credits[0]!, id: 'nonexpiring', expiresAt: null as unknown as number });
    f.rates(rates);
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    const consume = f.calls.find(call => call.method.endsWith('/consume'))!;
    expect(consume.params.creditId).toBe('private-card-earlier');
    expect(Object.keys(consume.params).sort()).toEqual(['creditId', 'idempotencyKey']);
    expect(consume.params.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ status: 'included', canResume: true, redemption: 'reset' });
    expect(f.calls.at(-1)?.method).toBe('account/rateLimits/read');
  } finally { f.cleanup(); }
});

for (const kind of ['expired', 'expires-now', 'redeeming', 'redeemed', 'unknown', 'wrong-type', 'missing-expiry', 'missing-details', 'count-zero']) {
  test(`ineligible reset cards are never consumed (${kind}); existing credits remain a reported fallback`, async () => {
    const f = fixture();
    try {
      const rates = captured(false);
      const cards = rates.rateLimitResetCredits.credits;
      for (const card of cards) {
        if (kind === 'expired') card.expiresAt = NOW - 1;
        if (kind === 'expires-now') card.expiresAt = NOW;
        if (['redeeming', 'redeemed', 'unknown'].includes(kind)) card.status = kind;
        if (kind === 'wrong-type') card.resetType = 'unknown';
        if (kind === 'missing-expiry') delete (card as Partial<typeof card>).expiresAt;
      }
      if (kind === 'missing-details') rates.rateLimitResetCredits.credits = null as unknown as typeof cards;
      if (kind === 'count-zero') rates.rateLimitResetCredits.availableCount = 0;
      f.rates(rates);
      const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
      expect(result).toMatchObject({ status: 'credits-available', canResume: true, next: 'resume-with-existing-credits', redemption: null });
      expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
    } finally { f.cleanup(); }
  });
}

test('no authorized existing balance means wait; it never buys credits or changes account or model', async () => {
  const f = fixture(['credits']);
  try {
    const rates = captured(false);
    rates.rateLimits.credits = { hasCredits: false, unlimited: false, balance: '0' };
    f.rates(rates);
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    expect(result).toMatchObject({ status: 'exhausted', canResume: false, next: 'wait-for-reset' });
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  } finally { f.cleanup(); }
});

test('concurrent continuations serialize a fresh read and consume only once after restoration', async () => {
  const f = fixture();
  try {
    f.rates(captured(false));
    let consumes = 0;
    f.consume(async () => { consumes++; await Bun.sleep(50); f.rates(captured(true)); return { outcome: 'reset' }; });
    const results = await Promise.all([inspectAllowance('sample-c', { ...f.options, continue: true }),
      inspectAllowance('sample-c', { ...f.options, continue: true })]);
    expect(results.every(result => result.canResume)).toBe(true);
    expect(consumes).toBe(1);
    expect(f.calls.filter(call => call.method === 'account/rateLimits/read')).toHaveLength(3);
    expect(f.closed).toBe(2);
  } finally { f.cleanup(); }
});

for (const outcome of ['nothingToReset', 'noCredit', 'alreadyRedeemed']) test(`redemption outcome ${outcome} is followed by a fresh status read, never another card`, async () => {
  const f = fixture(['resetCards']);
  try {
    f.rates(captured(false));
    f.consume(() => ({ outcome }));
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    expect(result).toMatchObject({ redemption: outcome, canResume: false });
    expect(f.calls.filter(call => call.method.endsWith('/consume'))).toHaveLength(1);
    expect(f.calls.at(-1)?.method).toBe('account/rateLimits/read');
  } finally { f.cleanup(); }
});

test('lost redemption response is not retried or exposed; fresh permission determines recovery', async () => {
  const f = fixture();
  try {
    f.rates(captured(false));
    f.consume(() => { f.rates(captured(true)); throw new Error('private-card-earlier private@example.com secret-token'); });
    const result = await inspectAllowance('sample-c', { ...f.options, continue: true });
    expect(result).toMatchObject({ redemption: 'unconfirmed', status: 'included', canResume: true });
    expect(f.calls.filter(call => call.method.endsWith('/consume'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  } finally { f.cleanup(); }
});

test('a failed confirmation read cannot authorize resume or another redemption', async () => {
  const f = fixture();
  try {
    f.rates(captured(false));
    f.consume(() => { f.rates(null); return { outcome: 'reset' }; });
    expect(await inspectAllowance('sample-c', { ...f.options, continue: true })).toMatchObject({
      status: 'unavailable', canResume: false, next: 'retry-status', redemption: 'reset', error: 'protocol',
    });
    expect(f.calls.filter(call => call.method.endsWith('/consume'))).toHaveLength(1);
  } finally { f.cleanup(); }
});

test('a continuation waiting for the lease honors revoked authorization', async () => {
  const f = fixture();
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const consuming = new Promise<void>(resolve => { started = resolve; });
  const runs: Array<Promise<Awaited<ReturnType<typeof inspectAllowance>>>> = [];
  try {
    f.rates(captured(false));
    f.consume(async () => { started(); await held; return { outcome: 'nothingToReset' }; });
    runs.push(inspectAllowance('sample-c', { ...f.options, continue: true }));
    await consuming;
    let connected!: () => void;
    const waiting = new Promise<void>(resolve => { connected = resolve; });
    runs.push(inspectAllowance('sample-c', { ...f.options, continue: true, connect: async () => { connected(); return f.transport; } }));
    await waiting;
    testAccountSettings(f.directory, [{ engine: 'sample-c', launcher: join(f.directory, 'launcher'), home: f.home, pastAllowance: [] }]);
    finish();
    const results = await Promise.all(runs);
    expect(results[1]).toMatchObject({ status: 'exhausted', canResume: false, credits: { authorized: false }, resetCards: { authorized: false } });
    expect(f.calls.filter(call => call.method.endsWith('/consume'))).toHaveLength(1);
  } finally { finish(); await Promise.allSettled(runs); f.cleanup(); }
});

for (const blocked of ['spend-control', 'workspace-limit']) test(`credits do not authorize resume through ${blocked}`, async () => {
  const f = fixture(['credits']);
  try {
    const rates = captured(false);
    if (blocked === 'spend-control') rates.rateLimits.spendControlReached = true;
    else rates.rateLimits.rateLimitReachedType = 'workspace_owner_usage_limit_reached' as unknown as null;
    f.rates(rates);
    expect(await inspectAllowance('sample-c', { ...f.options, continue: true })).toMatchObject({ status: 'exhausted', canResume: false });
    expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
  } finally { f.cleanup(); }
});

test('missing authentication and mismatched account homes cannot redeem', async () => {
  const f = fixture();
  try {
    f.auth(false);
    f.rates(captured(false));
    expect((await inspectAllowance('sample-c', { ...f.options, continue: true })).status).toBe('unauthenticated');
    expect(f.calls.some(call => call.method.endsWith('/consume'))).toBe(false);
    const original = f.transport.request;
    f.transport.request = async (method, params) => method === 'initialize' ? { codexHome: '/unconfigured-home' } : original(method, params);
    expect((await inspectAllowance('sample-c', { ...f.options, continue: true })).status).toBe('unavailable');
  } finally { f.cleanup(); }
});

test('CLI gives actionable exit codes and rejects unknown accounts and flags without connecting', async () => {
  const f = fixture([]);
  const output: string[] = [];
  try {
    f.rates(captured(false));
    expect(await allowanceCommand(['sample-c'], { ...f.options, print: line => output.push(line) })).toBe(0);
    expect(await allowanceCommand(['sample-c', '--continue'], { ...f.options, print: line => output.push(line) })).toBe(2);
    const callCount = f.calls.length;
    expect(await allowanceCommand(['other@example.com', '--continue'], { ...f.options, print: line => output.push(line) })).toBe(2);
    expect(await allowanceCommand(['sample-c', '--force'], { ...f.options, print: line => output.push(line) })).toBe(2);
    expect(f.calls).toHaveLength(callCount);
    expect(output.join('\n')).not.toMatch(/private|@|secret|creditId/);
  } finally { f.cleanup(); }
});

function launcher(f: ReturnType<typeof fixture>, mode = 'normal') {
  const path = join(f.directory, 'launcher');
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const directory = ${JSON.stringify(f.directory)};
const mode = ${JSON.stringify(mode)};
appendFileSync(directory + '/launches.jsonl', JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }) + '\\n');
if (process.argv.includes('mcp')) { console.log(JSON.stringify([{ name: 'inherited', enabled: true }])); process.exit(0); }
writeFileSync(directory + '/server.pid', String(process.pid));
if (mode === 'timeout') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else {
 let buffer = '';
 for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
   const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
   appendFileSync(directory + '/requests.jsonl', JSON.stringify(request) + '\\n');
   if (request.id === undefined) continue;
   if (mode === 'error') { console.log(JSON.stringify({ id: request.id, error: { message: 'private@example.com secret-token' } })); continue; }
   let result = {};
   if (request.method === 'initialize') result = { codexHome: process.env.CODEX_HOME };
   if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'private@example.com', planType: 'pro' } };
   if (request.method === 'account/rateLimits/read') {
    result = ${JSON.stringify(captured())};
    if (mode === 'concurrent') result.ordinaryUsageAllowed = existsSync(directory + '/restored');
   }
   if (request.method === 'account/rateLimitResetCredit/consume') {
    await Bun.sleep(50); writeFileSync(directory + '/restored', 'yes'); result = { outcome: 'reset' };
   }
   console.log(JSON.stringify({ method: 'account/updated', params: { email: 'private@example.com' } }));
   console.log(JSON.stringify({ id: request.id, result }));
  }
 }
}
`);
  chmodSync(path, 0o755);
}

for (const mode of ['normal', 'timeout', 'error']) test(`real stdio transport disables inherited MCP, bounds failures and cleans up (${mode})`, async () => {
  const f = fixture();
  try {
    launcher(f, mode);
    const result = await inspectAllowance('sample-c', { settings: f.options.settings,
      lockDirectory: f.options.lockDirectory, requestTimeoutMs: 100, now: f.options.now });
    expect(result.status).toBe(mode === 'normal' ? 'included' : 'unavailable');
    const launches = readFileSync(join(f.directory, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches).toHaveLength(2);
    expect(launches.every(launch => launch.home === f.home)).toBe(true);
    expect(launches[1].args).toContain('mcp_servers={"inherited"={enabled=false}}');
    const pid = Number(readFileSync(join(f.directory, 'server.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(JSON.stringify(result)).not.toMatch(/private|secret|@/);
    if (mode === 'normal') expect(existsSync(join(f.directory, 'requests.jsonl'))).toBe(true);
  } finally { f.cleanup(); }
}, 5000);

test('separate manager processes share the account lease and a concurrent retry consumes only one card', async () => {
  const f = fixture();
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
  try {
    launcher(f, 'concurrent');
    const source = `import { inspectAllowance } from ${JSON.stringify(join(import.meta.dir, 'allowance.ts'))};
      console.log(JSON.stringify(await inspectAllowance('sample-c', { continue: true,
        settings: { directory: ${JSON.stringify(f.settings)} }, lockDirectory: ${JSON.stringify(f.options.lockDirectory)} })));`;
    for (let index = 0; index < 2; index++) children.push(Bun.spawn([process.execPath, '-e', source], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async child => {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toEqual({ code: 0, errors: '' });
      return JSON.parse(output);
    }));
    expect(results.every(result => result.canResume && result.status === 'included')).toBe(true);
    const requests = readFileSync(join(f.directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'account/rateLimitResetCredit/consume')).toHaveLength(1);
    expect(requests.filter(request => request.method === 'account/rateLimits/read')).toHaveLength(3);
    expect(JSON.stringify(results)).not.toMatch(/private|secret|@|creditId/);
  } finally {
    for (const child of children) child.kill();
    await Promise.allSettled(children.map(child => child.exited));
    f.cleanup();
  }
}, 5000);
