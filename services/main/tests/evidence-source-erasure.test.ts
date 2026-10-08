import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { claimRoutes } from '../src/routes/claims.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const canary = 'QUOTE-CANARY-ζ-evidence';
const digest = 'ab'.repeat(32);

function native(id: string = randomUUID()) { return `https://rezics.com/id/${id}`; }

function routes(reached: { store: boolean }) {
  const account = new AccountAssertionVerifier({
    issuer: 'https://accounts.example', audience: 'https://main.example',
    jwksUrl: 'https://accounts.example/jwks', introspectUrl: 'https://accounts.example/introspect',
    clientId: 'main', clientSecret: 'secret', timeoutMs: 1000,
  });
  const refuse = (label: string) => () => {
    reached.store = true;
    throw new Error(`${label} was reached`);
  };
  return claimRoutes({
    environment: { fuseki: { query: refuse('graph') } },
    verification: new VerificationStore({ query: refuse('evidence store'), connect: refuse('evidence store') } as unknown as Pool),
    account,
    access: { activePrincipalId: refuse('access owner') },
  } as unknown as MainWorkDependencies);
}

function postEvidence(app: ReturnType<typeof claimRoutes>, claim: string, key: string, body: unknown,
  authorization?: string) {
  return app.handle(new Request(`http://localhost/v1/claims/${claim}/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key,
      ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  }));
}

test('the evidence API denies an unsupported Account assertion and a closed content selector before any store write', async () => {
  const reached = { store: false };
  const app = routes(reached);
  const claim = randomUUID();
  const body = { profile: 'claim-evidence-v1', claimRevision: native(), expectedHead: null, items: [
    { stance: 'supports', contentRevision: randomUUID(), selector: { quote: canary, start: 4, digest },
      availability: 'available' }] };
  const missing = await postEvidence(app, claim, `missing-${randomUUID()}`, body);
  expect(missing.status).toBe(401);
  const bearer = await postEvidence(app, claim, `bearer-${randomUUID()}`, body, 'Bearer not-a-jwt');
  expect(bearer.status).toBe(401);
  const closed = await postEvidence(app, claim, `closed-${randomUUID()}`, { profile: 'claim-evidence-v1',
    claimRevision: native(), expectedHead: null, items: [{ stance: 'supports', contentRevision: randomUUID(),
      selector: { kind: 'whole' }, availability: 'available' }] });
  expect(closed.status).toBeGreaterThanOrEqual(400);
  expect(closed.status).not.toBe(201);
  expect(reached.store).toBe(false);
});
