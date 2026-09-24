import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

test('OPS01/IAM01 partial: shared QA stack serves Main, Account and Fuseki', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through scripts/qa/cli.ts');
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const account = createAccountApp(createAccountAuth({
    baseURL: Bun.env.ACCOUNT_BASE_URL!, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: new Set(),
  }), pool);
  const main = createMainApp(new FusekiClient(Bun.env.FUSEKI_URL!));
  try {
    const [accountReady, discovery, mainReady, graph] = await Promise.all([
      account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/health/ready`)),
      account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/.well-known/openid-configuration`)),
      main.handle(new Request('http://localhost/health/ready')),
      new FusekiClient(Bun.env.FUSEKI_URL!).query('ASK {}'),
    ]);
    expect(accountReady.status).toBe(200);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    expect(metadata.issuer).toBe(`${Bun.env.ACCOUNT_BASE_URL}/api/auth`);
    expect(metadata.jwks_uri).toBeTruthy();
    expect(mainReady.status).toBe(200);
    expect(graph.boolean).toBe(true);
    const signup = await account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: Bun.env.ACCOUNT_BASE_URL! },
      body: JSON.stringify({ name: 'QA Smoke', email: `${Bun.env.REZICS_QA_RUN_ID}@example.test`,
        password: 'correct horse battery staple' }),
    }));
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const session = await account.handle(new Request(`${Bun.env.ACCOUNT_BASE_URL}/api/auth/get-session`, {
      headers: { cookie: cookie! },
    }));
    expect(session.status).toBe(200);
    expect((await session.json() as { user?: { email?: string } }).user?.email)
      .toBe(`${Bun.env.REZICS_QA_RUN_ID}@example.test`);
  } finally { await pool.end(); }
});
