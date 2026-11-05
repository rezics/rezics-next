import { expect, test } from 'bun:test';
import {
  createNativeDriver,
  createReferenceDriver,
  removed,
  retained,
  type ConsentIssuanceDriver,
  type Evidence,
  type PendingAttempt,
} from './consent-issuance-outcomes-driver.ts';

// Outcome specification for a personal consent reduction racing a fresh
// establishment. The default driver is the native composition; only the spec
// verifier selects a synthetic control, which proves assertion sensitivity only.
const references = ['correct', 'stale', 'deny-all', 'bad-order'] as const;
const failing = test;
function driver(max = 4): Promise<ConsentIssuanceDriver> {
  const behavior = process.env.CONSENT_OUTCOME_REFERENCE;
  if (!behavior) return createNativeDriver(max);
  if (!references.includes(behavior as (typeof references)[number])) throw new Error('Unknown reference behavior');
  return Promise.resolve(createReferenceDriver(behavior as (typeof references)[number]));
}

function gapEvidence(gap: Evidence) {
  expect(gap.proof.reference).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.operationKey).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(gap.proof.applied).toBe(false);
  expect(gap.receipt.receiptId.length).toBeGreaterThan(0);
  expect(gap.receipt.accountId).toBe(gap.account.accountId);
  expect(gap.receipt.minimumAuthnEpoch).toBe(String(gap.proof.previousEpoch + 1));
  expect(gap.account).toMatchObject({
    minimumAuthnEpoch: gap.receipt.minimumAuthnEpoch,
    receiptId: gap.receipt.receiptId,
    fenced: true,
  });
  expect(gap.applied).toBeNull();
  expect(gap.consent.scopes).toEqual([retained, removed]);
  expect(gap.events).toEqual(['committed-auth-proof', 'committed-access-receipt', 'paused-before-consent-cas']);
}

// The reducing account is fenced exactly as it is in a recovery gap: sign-in is refused with no token.
async function refused(attempt: PendingAttempt) {
  const result = await attempt.result;
  expect(result.signin.status).toBe(401);
  expect(await result.signin.clone().json()).toEqual({ error: 'authentication_denied' });
  expect(result.token).toBeNull();
  expect(result.jwt).toBeNull();
}

function completedEvidence(gap: Evidence, end: Evidence, mode: 'resume' | 'restart') {
  expect(end.proof).toEqual({ ...gap.proof, applied: true });
  expect(end.receipt).toEqual(gap.receipt);
  // Auth completed the barrier with its receipt: the fence is clear, the receipt and floor stay.
  expect(end.account).toEqual({ ...gap.account, fenced: false });
  expect(end.applied).toEqual({
    receiptId: gap.receipt.receiptId,
    purpose: 'consent-reduction',
    minimumAuthnEpoch: Number(gap.receipt.minimumAuthnEpoch),
  });
  expect(end.consent).toEqual({ revision: String(BigInt(gap.consent.revision) + 1n), scopes: [retained] });
  expect(end.events).not.toContain('auth-proof-not-visible');
  expect(end.events).not.toContain('access-receipt-not-durable');
  const first = (event: string) => end.events.indexOf(event);
  expect(first('committed-auth-proof')).toBe(0);
  expect(first('committed-access-receipt')).toBeGreaterThan(first('committed-auth-proof'));
  expect(first('paused-before-consent-cas')).toBeGreaterThan(first('committed-access-receipt'));
  expect(first('signin-http-start')).toBeGreaterThan(first('paused-before-consent-cas'));
  expect(first('signin-http-complete')).toBeGreaterThan(first('signin-http-start'));
  expect(first('token-http-complete')).toBeGreaterThan(first('signin-http-complete'));
  expect(first('consent-http-complete')).toBeGreaterThan(first('token-http-complete'));
  expect(end.events.indexOf('consent-http-complete')).toBe(end.events.length - 1);
  if (mode === 'restart') {
    expect(first('acknowledgement-lost')).toBeGreaterThan(first('paused-before-consent-cas'));
    expect(first('auth-instance-restarted')).toBeGreaterThan(first('acknowledgement-lost'));
    // The restarted instance re-presents the same committed proof and Access replays its receipt.
    expect(end.events.lastIndexOf('committed-auth-proof')).toBeGreaterThan(first('auth-instance-restarted'));
    expect(end.events.lastIndexOf('committed-access-receipt')).toBeGreaterThan(
      end.events.lastIndexOf('committed-auth-proof'),
    );
  } else {
    expect(end.events).not.toContain('acknowledgement-lost');
    expect(end.events).not.toContain('auth-instance-restarted');
  }
}

for (const mode of ['resume', 'restart'] as const) {
  failing(
    `removed scope is never usable after reduction when establishment races (${mode})`,
    async () => {
      const d = await driver();
      try {
        const gap = await d.startReduction();
        gapEvidence(gap);
        const pending = d.beginAttempt('target', [retained, removed]);
        const scheduling = await d.atGap(pending);
        // The account is fenced in the gap, so no token can carry the removed scope out of it.
        expect(scheduling).toBe('completed');
        await refused(pending);
        expect((await d.finish(mode)).status).toBe(200);
        const end = await d.inspect();
        expect(end.consent.scopes).toEqual([retained]);
        expect(end.account.minimumAuthnEpoch).toBe(gap.receipt.minimumAuthnEpoch);
        expect(end.account.fenced).toBe(false);
        // Report nonsecret facts only, never cookies or JWT material.
        if (!process.env.CONSENT_OUTCOME_REFERENCE)
          console.info('Native consent race outcome', {
            mode,
            scheduling,
            floor: { before: gap.proof.previousEpoch, after: end.account.minimumAuthnEpoch },
            consent: end.consent,
          });
        // A retained scope may survive: the contract never requires wholesale invalidation.
        // After the barrier completes, a fresh sign-in succeeds at the new floor.
        const fresh = await d.beginAttempt('target', [retained]).result;
        expect(fresh.signin.status).toBe(200);
        expect(fresh.jwt).not.toBeNull();
        expect((await d.use(fresh.jwt!, retained)).allowed).toBe(true);
        const forbidden = await d.beginAttempt('target', [removed]).result;
        if (forbidden.jwt)
          expect(
            (await d.use(forbidden.jwt, removed)).allowed,
            'removed scope remained usable after completed consent reduction',
          ).toBe(false);
      } finally {
        await d.close();
      }
    },
    90_000,
  );
}

for (const identity of ['other-account', 'other-client'] as const) {
  test(`unaffected ${identity} makes progress around the exact consent gap`, async () => {
    const d = await driver();
    try {
      gapEvidence(await d.startReduction());
      const pending = d.beginAttempt(identity, [retained, removed]);
      expect(await d.atGap(pending), 'unaffected identity was serialized behind personal consent').toBe('completed');
      let issued;
      if (identity === 'other-account') {
        // Another account is not fenced: it signs in inside the gap.
        issued = await pending.result;
      } else {
        // The reducing account is fenced for every client until Auth completes the barrier.
        await refused(pending);
      }
      if (issued) {
        expect(issued.signin.status).toBe(200);
        expect(issued.token?.status).toBe(200);
        expect(issued.jwt).not.toBeNull();
        expect((await d.use(issued.jwt!, removed)).allowed).toBe(true);
      }
      expect((await d.finish('resume')).status).toBe(200);
      if (!issued) {
        // The other client's consent is untouched, so its fresh sign-in keeps the unreduced scope.
        issued = await d.beginAttempt(identity, [retained, removed]).result;
        expect(issued.signin.status).toBe(200);
        expect(issued.token?.status).toBe(200);
        expect(issued.jwt).not.toBeNull();
      }
      expect((await d.use(issued.jwt!, removed)).allowed, 'unaffected identity lost an unreduced scope').toBe(true);
    } finally {
      await d.close();
    }
  }, 90_000);
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
    expect((await d.finish('restart')).status).toBe(200);
    completedEvidence(gap, await d.inspect(), 'restart');
  } finally {
    await d.close();
  }
}, 90_000);

failing(
  'native max=1 Auth pool progresses through held-connection proxy',
  async () => {
    const d = await driver(1);
    try {
      // Native /consent nests database.connect() inside its issuance hold and calls
      // Access, whose Auth evidence verifier shares this one-connection pool.
      gapEvidence(await d.startReduction());
      expect((await d.finish('resume')).status).toBe(200);
      const issued = await d.beginAttempt('target', [retained]).result;
      expect(issued.signin.status).toBe(200);
      expect(issued.token?.status).toBe(200);
      expect(issued.jwt).not.toBeNull();
      expect((await d.use(issued.jwt!, retained)).allowed).toBe(true);
    } finally {
      await d.close();
    }
  },
  90_000,
);
