import { expect, test } from 'bun:test';
import {
  createNativeDriver, createReferenceDriver, retained, removed,
  type ConsentIssuanceDriver, type Evidence,
} from './consent-issuance-outcomes-driver.ts';

// The default is the actual native reproduction. Only the verifier selects a
// synthetic control; those runs establish assertion sensitivity, not product facts.
function driver(max = 4): Promise<ConsentIssuanceDriver> {
  const behavior = process.env.CONSENT_OUTCOME_REFERENCE;
  if (!behavior) return createNativeDriver(max);
  if (!['correct', 'stale', 'deny-all', 'bad-order'].includes(behavior)) throw new Error('Unknown reference behavior');
  return Promise.resolve(createReferenceDriver(behavior as Parameters<typeof createReferenceDriver>[0]));
}

function gapEvidence(gap: Evidence) {
  expect(gap.proof.reference).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.operationKey).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.receiptId).toBeNull();
  expect(gap.receipt.receiptId.length).toBeGreaterThan(0);
  expect(gap.receipt.accountId).toBe(gap.account.accountId);
  expect(gap.receipt.minimumAuthnEpoch).toBe(String(gap.proof.previousEpoch + 1));
  expect(gap.account.minimumAuthnEpoch).toBe(gap.receipt.minimumAuthnEpoch);
  expect(gap.account.fenced).toBe(false);
  expect(gap.consent.scopes).toEqual([retained, removed]);
  expect(gap.events).toEqual(['committed-auth-proof', 'committed-access-receipt', 'paused-before-consent-cas']);
}

function completedEvidence(gap: Evidence, end: Evidence, mode: 'resume' | 'restart') {
  expect(end.proof).toEqual({ ...gap.proof, receiptId: gap.receipt.receiptId });
  expect(end.receipt).toEqual(gap.receipt);
  expect(end.account).toEqual(gap.account);
  expect(end.consent).toEqual({ revision: String(BigInt(gap.consent.revision) + 1n), scopes: [retained] });
  const first = (event: string) => end.events.indexOf(event);
  expect(first('committed-auth-proof')).toBe(0);
  expect(first('committed-access-receipt')).toBeGreaterThan(first('committed-auth-proof'));
  expect(first('paused-before-consent-cas')).toBeGreaterThan(first('committed-access-receipt'));
  expect(first('signin-http-start')).toBeGreaterThan(first('paused-before-consent-cas'));
  expect(first('signin-http-complete')).toBeGreaterThan(first('signin-http-start'));
  expect(first('token-http-complete')).toBeGreaterThan(first('signin-http-complete'));
  expect(first('consent-http-complete')).toBeGreaterThan(first('paused-before-consent-cas'));
  if (mode === 'restart') {
    expect(first('auth-instance-restarted')).toBeGreaterThan(first('paused-before-consent-cas'));
    expect(first('auth-instance-restarted')).toBeLessThan(first('consent-http-complete'));
  }
}

for (const mode of ['resume', 'restart'] as const) {
  test(`removed scope is never usable after reduction when establishment races (${mode})`, async () => {
    const d = await driver();
    try {
      const gap = await d.startReduction();
      gapEvidence(gap);
      const pending = d.beginAttempt('target', [retained, removed]);
      const scheduling = await d.atGap(pending);
      let gapUse;
      if (scheduling === 'completed') {
        const issued = await pending.result;
        if (issued.jwt) gapUse = await d.use(issued.jwt, removed);
      }
      expect((await d.finish(mode)).status).toBe(200);
      const issued = await pending.result;
      const end = await d.inspect();
      expect(end.consent.scopes).toEqual([retained]);
      expect(end.account.minimumAuthnEpoch).toBe(gap.receipt.minimumAuthnEpoch);
      const after = issued.jwt ? await d.use(issued.jwt, removed) : { authenticated: false, allowed: false, epoch: null };
      // Deliberately report only nonsecret facts, never cookies or JWT material.
      if (!process.env.CONSENT_OUTCOME_REFERENCE) console.info('Native consent outcome', {
        mode, scheduling, signin: issued.signin.status, token: issued.token?.status, gapUse, after, gap, end,
      });
      expect(after.allowed, 'removed scope remained usable after completed consent reduction').toBe(false);
      // A retained scope is allowed to survive; the contract does not require
      // wholesale JWT invalidation if Access enforces the effective scope set.
      const fresh = await d.beginAttempt('target', [retained]).result;
      expect(fresh.jwt).not.toBeNull();
      expect((await d.use(fresh.jwt!, retained)).allowed).toBe(true);
      const forbidden = await d.beginAttempt('target', [removed]).result;
      if (forbidden.jwt) expect((await d.use(forbidden.jwt, removed)).allowed).toBe(false);
    } finally { await d.close(); }
  }, 60_000);
}

for (const identity of ['other-account', 'other-client'] as const) {
  test(`unaffected ${identity} makes progress during the exact consent gap`, async () => {
    const d = await driver();
    try {
      gapEvidence(await d.startReduction());
      const pending = d.beginAttempt(identity, [retained, removed]);
      expect(await d.atGap(pending), 'unaffected identity was serialized behind personal consent').toBe('completed');
      const issued = await pending.result;
      expect(issued.signin.status).toBe(200);
      expect(issued.token?.status).toBe(200);
      expect(issued.jwt).not.toBeNull();
      expect((await d.use(issued.jwt!, removed)).allowed).toBe(true);
      expect((await d.finish('resume')).status).toBe(200);
      expect((await d.use(issued.jwt!, removed)).allowed).toBe(true);
    } finally { await d.close(); }
  }, 60_000);
}

test('HTTP and durable evidence order matches the exact native receipt', async () => {
  const d = await driver();
  try {
    const gap = await d.startReduction();
    gapEvidence(gap);
    const pending = d.beginAttempt('other-account', [retained, removed]);
    expect(await d.atGap(pending)).toBe('completed');
    const issued = await pending.result;
    expect(issued.signin.status).toBe(200);
    expect(issued.token?.status).toBe(200);
    expect(issued.jwt).not.toBeNull();
    expect((await d.use(issued.jwt!, removed)).allowed).toBe(true);
    expect((await d.finish('restart')).status).toBe(200);
    completedEvidence(gap, await d.inspect(), 'restart');
  } finally { await d.close(); }
}, 60_000);

test('native max=1 Auth pool progresses through held-connection proxy', async () => {
  const d = await driver(1);
  try {
    // startReduction includes native /consent's nested database.connect(). Its
    // success with one slot exercises the actual AsyncLocalStorage proxy.
    gapEvidence(await d.startReduction());
    expect((await d.finish('resume')).status).toBe(200);
    const issued = await d.beginAttempt('target', [retained]).result;
    expect(issued.signin.status).toBe(200);
    expect(issued.token?.status).toBe(200);
    expect(issued.jwt).not.toBeNull();
    expect((await d.use(issued.jwt!, retained)).allowed).toBe(true);
  } finally { await d.close(); }
}, 60_000);
