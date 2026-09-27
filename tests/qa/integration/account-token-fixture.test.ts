import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

test('IAM02: separate local Account issuers keep each newly issued assertion active', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the QA integration tier');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  try {
    for (let issuer = 0; issuer < 12; issuer++) {
      const scopes = issuer % 2 === 0 ? 'openid access:manage work:create'
        : 'openid context:write context:select context:read statement:write statement:decide work:edit work:read';
      const apps = { ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>;
      const account = await ratingAccount(apps, scopes);
      try {
        for (const [name, token, subject] of [
          ['a', account.tokenA, account.a.id],
          ['b', account.tokenB, account.b.id],
          ['no-scope', account.noScope, account.a.id],
        ] as const) {
          const request = new Request('http://main.local/v1/me', {
            headers: { authorization: `Bearer ${token}` },
          });
          let actual;
          try { actual = await account.verifier.verify(request, name === 'no-scope' ? []
            : [issuer % 2 === 0 ? 'access:manage' : 'context:write']); }
          catch (error) {
            throw new Error(`Account issuer ${issuer} assertion ${name}: ${String(error)}`, { cause: error });
          }
          expect(actual).toMatchObject({ issuer: account.issuer, subject });
        }
      } finally { await account.close(); }
    }
    // The provider records iat before asking its adapter for a signing key.
    // A first issuance that crosses a second boundary must remain valid, but
    // a token dated outside the bounded signing interval is still refused.
    const account = await ratingAccount({ ...Bun.env,
      ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>);
    const pool = new Pool({ connectionString: databases.urls.account });
    try {
      const token = account.tokenA;
      const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { iat: number };
      const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { kid: string };
      const request = new Request('http://main.local/v1/me', {
        headers: { authorization: `Bearer ${token}` },
      });
      await pool.query('UPDATE public.rezics_signing_key SET activated_at = to_timestamp($2) WHERE id = $1',
        [header.kid, claims.iat + 1]);
      expect((await account.verifier.verify(request, [])).subject).toBe(account.a.id);
      await pool.query('UPDATE public.rezics_signing_key SET activated_at = to_timestamp($2) WHERE id = $1',
        [header.kid, claims.iat + 6]);
      await expect(account.verifier.verify(request, [])).rejects.toBeInstanceOf(AccountAssertionDenied);
    } finally { await pool.end(); await account.close(); }
  } finally { await databases.close(); }
}, 120_000);
