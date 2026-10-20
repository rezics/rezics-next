import { expect, spyOn, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { FusekiClient, fusekiReadBudget, FusekiReadDeadlineExceeded, withFusekiReadRequest }
  from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, AccountAssertionVerifier,
  verifyCommandAccount, verifyRequestAccount, type VerifiedAccountAssertion }
  from '../src/modules/account/verify-assertion.ts';
import { workRead, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const limits = { calls: 160, bytes: 4 * 1024 * 1024, deadlineMs: 2000 };
const issuer = 'https://account.test', audience = 'https://main.test';
const material = (async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'active', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'active' })
    .setIssuer(issuer).setAudience(audience).setSubject('reader').setIssuedAt()
    .setExpirationTime('5m').sign(privateKey);
  return { key, token };
})();

function gate() {
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { release, enter, held, entered };
}

const promptly = <T>(pending: Promise<T>) => Promise.race([pending,
  delay(500).then(() => { throw new Error('Account waiter did not settle within 500 ms'); })]);

/** Real Main budget, verifier, signed JWT and HTTP clients; graph/SQL fixtures
 * provide only a stable position and an authority-recheck hook. No QA stack. */
async function fixture(holdKeys = false) {
  const { key, token } = await material;
  const keys = gate();
  const holds: ReturnType<typeof gate>[] = [];
  let introspectionHold: ReturnType<typeof gate> | undefined;
  let onAuthority: (() => Promise<void>) | undefined;
  const state = { keyCalls: 0, keyAborts: 0, introspections: 0, introspectionAborts: 0,
    graphCalls: 0, admissions: 0, authorityChecks: 0, active: true, scope: 'work:read' };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/jwks') {
      state.keyCalls++; keys.enter();
      request.signal.addEventListener('abort', () => { state.keyAborts++; }, { once: true });
      if (holdKeys) await keys.held;
      return Response.json({ keys: [key] });
    }
    if (path === '/introspect') {
      state.introspections++;
      const hold = introspectionHold;
      let abort!: () => void;
      const stopped = new Promise<void>(resolve => {
        abort = () => { state.introspectionAborts++; resolve(); };
        request.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        hold?.enter();
        if (hold) await Promise.race([hold.held, stopped]);
        return Response.json({ active: state.active, iss: issuer, sub: 'reader', aud: audience,
          scope: state.scope, exp: Math.floor(Date.now() / 1000) + 300 });
      } finally { request.signal.removeEventListener('abort', abort); }
    }
    state.graphCalls++;
    return Response.json({ results: { bindings: [{ epoch: { type: 'literal', value: 'epoch' },
      sequence: { type: 'literal', value: '1' } }] } });
  } });
  const verifier = new AccountAssertionVerifier({ issuer, audience,
    jwksUrl: new URL('/jwks', server.url).href, introspectUrl: new URL('/introspect', server.url).href,
    clientId: 'main', clientSecret: 'fixture-secret' });
  const graph = new FusekiClient(new URL('/graph', server.url).href);
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    account: verifier,
    access: { assertRecoveryOpen: async () => {}, activePrincipalId: async () => {
      state.authorityChecks++;
      if (state.authorityChecks > 1) await onAuthority?.();
      return 'reader';
    } },
  } as unknown as MainWorkDependencies;
  const request = (deadline?: string | number, signal?: AbortSignal) => new Request(`${audience}/v1/works`, {
    signal, headers: { authorization: `Bearer ${token}`,
      ...(deadline === undefined ? {} : { 'x-rezics-server-deadline': String(deadline) }) },
  });
  const read = (input: Request) => withFusekiReadRequest(input, limits, async () => {
    state.admissions++;
    const principal = await verifyRequestAccount(verifier, input, ['work:read']);
    await graph.query('ASK {}');
    return principal;
  });
  return { state, keys, verifier, graph, deps, request, read,
    holdIntrospection() { introspectionHold = gate(); holds.push(introspectionHold); return introspectionHold; },
    recheck(operation: () => Promise<void>) { onAuthority = operation; },
    async stop() { keys.release(); holds.forEach(hold => hold.release()); await server.stop(true); },
  };
}

test('an expired Main deadline starts no Account admission, introspection or graph work', async () => {
  const f = await fixture();
  try {
    await expect(f.read(f.request(Date.now() - 1))).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.state).toMatchObject({ admissions: 0, keyCalls: 0, introspections: 0, graphCalls: 0 });
  } finally { await f.stop(); }
});

test.each(['deadline', 'caller'] as const)(
  '%s releases a shared-key waiter without cancelling another reader or starting later work', async mode => {
    const f = await fixture(true);
    const signatures = spyOn(crypto.subtle, 'verify');
    const controller = new AbortController();
    const reason = new DOMException('Reader left admission', 'AbortError');
    try {
      const abandoned = f.read(f.request(mode === 'deadline' ? Date.now() + 80 : undefined, controller.signal))
        .catch(error => error);
      let completed = false;
      const unaffected = f.read(f.request()).catch(error => error).finally(() => { completed = true; });
      await f.keys.entered;
      if (mode === 'caller') controller.abort(reason);
      const error = await promptly(abandoned);
      if (mode === 'deadline') expect(error).toBeInstanceOf(FusekiReadDeadlineExceeded);
      else expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(AccountAssertionDenied);
      expect(completed).toBe(false);
      expect(signatures).not.toHaveBeenCalled();
      expect(f.state).toMatchObject({ keyCalls: 1, keyAborts: 0, introspections: 0, graphCalls: 0 });
      f.keys.release();
      expect(await unaffected).toMatchObject({ issuer, subject: 'reader', accountScopes: ['work:read'] });
      await delay(30);
      expect(f.state).toMatchObject({ keyCalls: 1, keyAborts: 0, introspections: 1, graphCalls: 1 });
      expect(signatures).toHaveBeenCalledTimes(1);
      expect(await f.read(f.request())).toMatchObject({ subject: 'reader' });
      expect(f.state).toMatchObject({ keyCalls: 1, introspections: 2, graphCalls: 2 });
      expect(signatures).toHaveBeenCalledTimes(2);
    } finally { signatures.mockRestore(); await f.stop(); }
  });

test.each(['deadline', 'caller'] as const)(
  '%s cancels active Account introspection before its default timeout and admits a fresh retry', async mode => {
    const f = await fixture();
    const hold = f.holdIntrospection();
    const controller = new AbortController();
    const reason = new DOMException('Reader left introspection', 'AbortError');
    try {
      const pending = f.read(f.request(mode === 'deadline' ? Date.now() + 100 : undefined, controller.signal))
        .catch(error => error);
      await hold.entered;
      if (mode === 'caller') controller.abort(reason);
      const error = await promptly(pending);
      if (mode === 'deadline') expect(error).toBeInstanceOf(FusekiReadDeadlineExceeded);
      else expect(error).toBe(reason);
      expect(error).not.toBeInstanceOf(AccountAssertionDenied);
      await promptly((async () => { while (!f.state.introspectionAborts) await delay(5); })());
      expect(f.state).toMatchObject({ keyCalls: 1, introspections: 1, introspectionAborts: 1, graphCalls: 0 });
      hold.release();
      expect(await f.read(f.request())).toMatchObject({ subject: 'reader' });
      expect(f.state).toMatchObject({ keyCalls: 1, introspections: 2, graphCalls: 1 });
    } finally { await f.stop(); }
  });

test('a tighter ambient Main deadline also bounds Account waiting without a forwarded header', async () => {
  const f = await fixture(true);
  const deadline = performance.now() + 80;
  try {
    await expect(promptly(fusekiReadBudget.run({ signal: new AbortController().signal,
      deadline, callsLeft: 160, bytesLeft: 4096 }, () => f.read(f.request()))))
      .rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.state).toMatchObject({ keyCalls: 1, introspections: 0, graphCalls: 0 });
    f.keys.release();
    expect(await f.read(f.request('malformed'))).toMatchObject({ subject: 'reader' });
    expect(f.state).toMatchObject({ keyCalls: 1, introspections: 1, graphCalls: 1 });
  } finally { await f.stop(); }
});

test('Account expiry retains the Work admission phase, typed cause and attempt diagnostics', async () => {
  const f = await fixture(true);
  const input = f.request(Date.now() + 100);
  try {
    const error = await promptly(withFusekiReadRequest(input, limits, () => workRead(f.deps, input,
      { actingSubject: 'reader' }, async () => { throw new Error('Read started after expired admission'); })))
      .catch(error => error);
    expect(error).toBeInstanceOf(WorkReadUnavailable);
    expect(error).toMatchObject({ code: 'work_read_deadline_exceeded', phase: 'admission' });
    expect(error.cause).toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(error.diagnostics.active).toEqual([]);
    expect(error.diagnostics.history).toEqual([expect.objectContaining({ attempt: 1, status: 'complete' })]);
    expect(f.state).toMatchObject({ keyCalls: 1, introspections: 0, graphCalls: 1 });
    f.keys.release();
    await delay(30);
    expect(f.state.introspections).toBe(0);
  } finally { await f.stop(); }
});

test.each(['deadline', 'caller'] as const)(
  '%s bounds current-assertion authority rechecks without turning expiry into a denial', async mode => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new DOMException('Reader left authority fence', 'AbortError');
    const input = f.request(mode === 'deadline' ? Date.now() + 180 : undefined, controller.signal);
    const rechecking = gate();
    let hold: ReturnType<typeof gate> | undefined;
    f.recheck(async () => {
      hold = f.holdIntrospection();
      rechecking.enter();
      await principal!.currentAssertion!();
    });
    let principal: VerifiedAccountAssertion | undefined;
    try {
      const pending = withFusekiReadRequest(input, limits, () => workRead(f.deps, input,
        { actingSubject: 'reader' }, async session => {
          expect(session.request).toBe(input);
          principal = session.principal as VerifiedAccountAssertion;
          return 'selected';
        })).catch(error => error);
      await rechecking.entered;
      await hold!.entered;
      if (mode === 'caller') controller.abort(reason);
      const error = await promptly(pending);
      expect(error).toBeInstanceOf(WorkReadUnavailable);
      expect(error).toMatchObject({ phase: 'authority-fence',
        code: mode === 'caller' ? 'work_read_cancelled' : 'work_read_deadline_exceeded' });
      if (mode === 'deadline') expect(error.cause).toBeInstanceOf(FusekiReadDeadlineExceeded);
      else expect(error.cause).toBe(reason);
      expect(error.diagnostics.active).toEqual([]);
      expect(error.diagnostics.history.every((call: { attempt: number }) => call.attempt === 1)).toBe(true);
      await promptly((async () => { while (!f.state.introspectionAborts) await delay(5); })());
      expect(f.state).toMatchObject({ keyCalls: 1, introspections: 2, graphCalls: 2 });
      hold!.release();
      expect(await f.read(f.request())).toMatchObject({ subject: 'reader' });
      expect(f.state.introspections).toBe(3);
    } finally { await f.stop(); }
  });

test('admission handoff keeps Request identity and cannot reuse a cached grant after cancellation', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new DOMException('Reader left cached admission', 'AbortError');
  const input = f.request(undefined, controller.signal);
  try {
    await expect(withFusekiReadRequest(input, limits, async () => {
      const principal = await verifyCommandAccount(f.verifier, input, ['work:read']);
      expect(await verifyRequestAccount(f.verifier, input, [])).toBe(principal);
      expect(await verifyRequestAccount(f.verifier, input, ['work:read'])).toBe(principal);
      expect(f.state.introspections).toBe(1);
      // Install another command handoff, then cancel before its consumption.
      await verifyCommandAccount(f.verifier, input, ['work:read']);
      controller.abort(reason);
      await expect(verifyRequestAccount(f.verifier, input, ['work:read'])).rejects.toBe(reason);
      await expect(verifyCommandAccount(f.verifier, input, ['work:read'])).rejects.toBe(reason);
      expect(f.state.introspections).toBe(2);
    })).rejects.toBe(reason);
    expect(await f.read(f.request())).toMatchObject({ subject: 'reader' });
  } finally { await f.stop(); }
});

test('an authority assertion cannot escape its completed Main operation', async () => {
  const f = await fixture();
  try {
    const principal = await withFusekiReadRequest(f.request(), limits, () => f.verifier.verify(f.request(), ['work:read']));
    await expect(principal.currentAssertion!()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.state.introspections).toBe(1);
    expect(await f.read(f.request())).toMatchObject({ subject: 'reader' });
  } finally { await f.stop(); }
});

test('current-session revocation and insufficient consent remain denials, with no graph disclosure', async () => {
  const f = await fixture();
  try {
    const principal = await withFusekiReadRequest(f.request(), limits, async () => {
      const current = await f.verifier.verify(f.request(), ['work:read']);
      f.state.active = false;
      await expect(current.currentAssertion!()).rejects.toBeInstanceOf(AccountAssertionDenied);
      return current;
    });
    expect(principal.accountScopes).toEqual(['work:read']);
    f.state.active = true; f.state.scope = 'profile:read';
    await expect(f.read(f.request())).rejects.toBeInstanceOf(AccountAssertionInsufficientScope);
    expect(f.state.graphCalls).toBe(0);
  } finally { await f.stop(); }
});
