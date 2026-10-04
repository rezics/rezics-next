import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { bootstrapWebAuth } from '../../../scripts/dev/web-auth-bootstrap.ts';

/** The shard's Account persists across files; never borrow another fixture's operator or client. */
export async function joiningAuthFixture(runId: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  try {
    const base = Bun.env.ACCOUNT_BASE_URL!;
    const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool });
    const app = createAccountApp(auth, pool);
    const email = `joining-operator-${randomUUID()}@example.test`;
    const password = randomBytes(32).toString('base64url');
    const response = await app.handle(new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...signupPolicyFixture, name: 'Joining fixture operator', email, password }),
    }));
    const result = await response.json() as { user?: { id?: string } };
    if (response.status !== 200 || !result.user?.id) throw new Error(`Joining operator signup failed: ${response.status}`);
    const id = result.user.id;
    await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [id]);
    await pool.query("INSERT INTO rezics_account_operator(user_id,role) VALUES($1,'owner')", [id]);
    const name = `g-1005-auth-${randomUUID()}`;
    const fixture = await bootstrapWebAuth({ runId, redirectUris: ['http://localhost:3000/auth/callback'],
      fixture: { name, operator: { id, email, password } } });
    return { ...fixture, name, operatorId: id };
  } finally { await pool.end(); }
}
