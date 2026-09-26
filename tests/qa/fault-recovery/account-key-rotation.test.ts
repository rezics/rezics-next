import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { symmetricDecrypt } from 'better-auth/crypto';
import { importJWK, SignJWT } from 'jose';
import { Pool } from 'pg';
import { AccountAssertionDenied, AccountAssertionVerifier }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { countStatements, databaseName, decodeHeader, decodePayload, mainWithAccount, qaEnvironment,
  representAgents, startAccount } from '../integration/account-boundary-fixture.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
type Generation = { kid: string; generation: string; state: string; retiredReason: string | null;
  verifyUntil: string | null };

test('OPS07: signing keys rotate and retire while sessions and jobs run; retired keys, audience and validity stay enforced', async () => {
  const env = qaEnvironment();
  const databases = await cloneQaAccountAccessDatabases(env.runId);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const account = await startAccount({ pool: { connectionString: databases.urls.account, max: 12 },
    secret: env.secret, resource: env.resource });
  const workers: Promise<void>[] = [];
  let running = true;
  try {
    // The operator root procedure, run against the same owner database.
    const cli = (...args: string[]) => {
      const run = spawnSync('bun', ['services/account/src/signing-keys-cli.ts', ...args], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ACCOUNT_BASE_URL: account.base, ACCOUNT_SECRET: env.secret,
          ACCOUNT_MAIN_RESOURCE: env.resource, ACCOUNT_DATABASE_URL: databases.urls.account } });
      return { ok: run.status === 0, output: `${run.status} ${run.signal} ${run.stdout}${run.stderr}`,
        json: run.status === 0 ? JSON.parse(run.stdout) : undefined };
    };
    const jwks = async () => ((await (await fetch(`${account.local}/api/auth/jwks`)).json()) as {
      keys: Array<{ kid: string; d?: string }> }).keys;
    const scope = 'openid work:create offline_access';
    const verifierClient = await account.workloadApp('Main verifier', ['work:create']);
    const product = await account.nativeApp('Session product', scope, true);
    const job = await account.workloadApp('Rotation job', ['work:create']);
    const member = await account.signUp('member');
    const { agents: [agent] } = await representAgents(accessPool, account.issuer, member.id, 1);
    const verifier = new AccountAssertionVerifier(account.verifierConfig(verifierClient));
    const { discover, check } = mainWithAccount(env, accessPool, verifier);
    const act = async (token: string) => {
      const found = await discover(token);
      return found.status === 200 ? (await check(token, agent!, found.body.authorityEpoch)).status : found.status;
    };
    const verify = (token: string) => verifier.verify(new Request(`${env.resource}/v1/works`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } }), ['work:create']);
    const mint = async () => {
      const response = await account.clientCredentials(job, 'work:create');
      expect(response.status).toBe(200);
      return (await response.json() as { access_token: string }).access_token;
    };

    // The first issuance mints generation 1 through the keyring.
    let session = await account.issue(product.client_id, member, scope, false);
    const first = decodeHeader(session.access_token).kid as string;
    expect(cli('status').json).toMatchObject([{ kid: first, generation: '1', state: 'active' }]);
    expect((await jwks()).map(key => key.kid)).toEqual([first]);
    expect((await jwks()).every(key => key.d === undefined)).toBe(true);

    // A session holds its token until refused, then refreshes once; a job holds
    // a workload token until refused, then mints once. Neither may see Account
    // as unavailable or stay refused across any rotation step.
    const outcomes = { session: [] as string[], job: [] as string[] };
    workers.push((async () => {
      while (running) {
        let status = await act(session.access_token);
        if (status === 401) {
          const renewed = await account.refresh(product.client_id, session.refresh_token!);
          if (renewed.ok) {
            session = await renewed.json() as typeof session;
            status = await act(session.access_token);
            outcomes.session.push(status === 200 ? 'recovered' : `failed:${status}`);
          } else outcomes.session.push(`refresh:${renewed.status}`);
        } else outcomes.session.push(status === 200 ? 'ok' : `failed:${status}`);
        await Bun.sleep(20);
      }
    })());
    let jobToken = await mint();
    workers.push((async () => {
      while (running) {
        try { await verify(jobToken); outcomes.job.push('ok'); }
        catch (error) {
          if (!(error instanceof AccountAssertionDenied)) { outcomes.job.push('unavailable'); continue; }
          jobToken = await mint();
          try { await verify(jobToken); outcomes.job.push('recovered'); }
          catch { outcomes.job.push('failed'); }
        }
        await Bun.sleep(20);
      }
    })());
    // Each rotation step lets both workers complete at least two more rounds.
    let phases = 0;
    const progress = async () => {
      const seen = { session: outcomes.session.length, job: outcomes.job.length };
      while (running && (outcomes.session.length < seen.session + 2 || outcomes.job.length < seen.job + 2)) {
        await Bun.sleep(10);
      }
      phases++;
    };
    await progress();

    // Stage: published before it signs.
    const staged = cli('stage').json as Generation;
    expect(staged).toMatchObject({ generation: '2', state: 'staged' });
    expect(cli('stage').json).toMatchObject({ kid: staged.kid, state: 'staged' });
    expect((await jwks()).map(key => key.kid)).toEqual([first, staged.kid]);
    expect(decodeHeader(await mint()).kid).toBe(first);
    const beforeActivation = await mint();
    await progress();

    // Activation waits for verifier JWKS caches unless the operator shortens it.
    const early = cli('activate');
    expect(early.ok).toBe(false);
    expect(early.output).toContain('not yet published long enough');
    expect(cli('activate', '0').json).toMatchObject({ kid: staged.kid, state: 'active' });
    const afterActivation = cli('status').json as Generation[];
    const superseded = afterActivation.find(key => key.kid === first)!;
    expect(superseded.state).toBe('retiring');
    expect(Date.parse(superseded.verifyUntil!) - Date.now()).toBeGreaterThan(290_000);
    expect((await account.pool.query('SELECT "privateKey" FROM jwks WHERE id = $1', [first]))
      .rows[0]).toEqual({ privateKey: 'destroyed' });
    const second = await mint();
    expect(decodeHeader(second).kid).toBe(staged.kid);
    expect((await verify(second)).subject).toBe(job.client_id);
    // A token the superseded key signed before activation verifies until expiry.
    expect((await verify(beforeActivation)).subject).toBe(job.client_id);
    await progress();

    // Fault fixture: tokens signed with real key material decrypted from the
    // owner database. The unmodified copy is admitted, so each refusal below
    // comes from the one claim or key it changes.
    const signer = async (kid: string) => {
      const row = (await account.pool.query<{ privateKey: string }>(
        'SELECT "privateKey" FROM jwks WHERE id = $1', [kid])).rows[0]!;
      return importJWK(JSON.parse(await symmetricDecrypt({ key: env.secret,
        data: JSON.parse(row.privateKey) })), 'EdDSA');
    };
    const template = decodePayload(second);
    const forge = async (kid: string, claims: Record<string, unknown>) =>
      new SignJWT({ ...template, jti: randomUUID(), ...claims })
        .setProtectedHeader({ alg: 'EdDSA', typ: decodeHeader(second).typ as string, kid })
        .sign(await signer(kid));
    const now = Math.floor(Date.now() / 1000);
    expect((await verify(await forge(staged.kid, {}))).subject).toBe(job.client_id);
    await expect(verify(await forge(staged.kid, { aud: 'https://other.rezics.test' })))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verify(await forge(staged.kid, { iat: now - 400, exp: now - 100 })))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verify(await forge(staged.kid, { iat: now - 120 })))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const successor = cli('stage').json as Generation;
    expect(successor.generation).toBe('3');
    const fromStaged = await forge(successor.kid, {});
    expect(await account.introspect(verifierClient, fromStaged)).toEqual({ active: false });
    await expect(verify(fromStaged)).rejects.toBeInstanceOf(AccountAssertionDenied);
    await progress();

    // Clock fixture: the superseded key's verification window has closed. Main
    // may still cache its JWKS; Account's introspection refuses it anyway.
    await account.pool.query(`UPDATE rezics_signing_key SET
        superseded_at = now() - interval '306 seconds', verify_until = now() - interval '1 second'
      WHERE id = $1`, [first]);
    expect((await jwks()).map(key => key.kid)).toEqual([staged.kid, successor.kid]);
    await expect(verify(beforeActivation)).rejects.toBeInstanceOf(AccountAssertionDenied);
    expect((cli('status').json as Generation[]).find(key => key.kid === first))
      .toMatchObject({ state: 'retired', retiredReason: 'expired' });
    await progress();

    // Compromise: the successor signs at once and every token of the retired
    // key is refused, while browser sessions and refresh families continue.
    const exposed = await mint();
    expect(decodeHeader(exposed).kid).toBe(staged.kid);
    expect((await verify(exposed)).subject).toBe(job.client_id);
    const compromised = cli('retire', staged.kid);
    expect(compromised.ok, compromised.output).toBe(true);
    expect(compromised.json).toMatchObject({ kid: staged.kid, state: 'retired',
      retiredReason: 'compromised' });
    expect((cli('status').json as Generation[]).find(key => key.kid === successor.kid)!.state)
      .toBe('active');
    await expect(verify(exposed)).rejects.toBeInstanceOf(AccountAssertionDenied);
    expect(await account.introspect(verifierClient, exposed)).toEqual({ active: false });
    expect((await jwks()).map(key => key.kid)).toEqual([successor.kid]);
    expect((await account.pool.query('SELECT "privateKey" FROM jwks WHERE id = $1', [staged.kid]))
      .rows[0]).toEqual({ privateKey: 'destroyed' });
    const browser = await fetch(`${account.local}/api/auth/get-session`,
      { headers: { cookie: member.cookie } });
    expect((await browser.json() as { user: { id: string } }).user.id).toBe(member.id);
    await progress();
    await progress();

    const retireActive = cli('retire', successor.kid);
    expect(retireActive.ok).toBe(false);
    expect(retireActive.output).toContain('stage a successor');
    expect(cli('retire', randomUUID()).ok).toBe(false);

    running = false;
    await Promise.all(workers);
    for (const [name, seen] of Object.entries(outcomes)) {
      expect(seen.length, name).toBeGreaterThanOrEqual(2 * phases);
      expect(seen.filter(outcome => outcome !== 'ok' && outcome !== 'recovered'), name).toEqual([]);
      expect(seen.filter(outcome => outcome === 'recovered').length, name).toBeGreaterThanOrEqual(1);
    }
    expect(decodeHeader(session.access_token).kid).toBe(successor.kid);
    expect(decodeHeader(jobToken).kid).toBe(successor.kid);

    // Cost: signing, publication and introspection read only live generations.
    const measure = async (token: string) => {
      await account.introspect(verifierClient, token);
      const counter = countStatements(databaseName(databases.urls.account));
      try {
        expect(await account.introspect(verifierClient, token)).toMatchObject({ active: true });
        return counter.counts.calls;
      } finally { counter.restore(); }
    };
    const baseline = await measure(await mint());
    for (let rotation = 0; rotation < 8; rotation++) {
      expect(cli('stage').ok).toBe(true);
      expect(cli('activate', '0').ok).toBe(true);
    }
    expect((await jwks()).length).toBe(9);
    await account.pool.query(`UPDATE rezics_signing_key SET superseded_at = now() - interval '306 seconds',
      verify_until = now() - interval '1 second' WHERE state = 'retiring'`);
    expect((await jwks()).length).toBe(1);
    expect(await measure(await mint())).toBe(baseline);
    expect((cli('status').json as Generation[]).length).toBe(11);
    const client = await account.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const lookup = await client.query('EXPLAIN (FORMAT JSON) SELECT state FROM rezics_signing_key WHERE id = $1',
        [first]);
      expect(JSON.stringify(lookup.rows)).toContain('rezics_signing_key_pkey');
      const live = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM rezics_signing_key
        WHERE state <> 'retired' AND (state <> 'retiring' OR verify_until > now())`);
      expect(JSON.stringify(live.rows)).toContain('rezics_signing_key_live');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    running = false;
    await Promise.allSettled(workers);
    await account.stop();
    await accessPool.end();
    await databases.close();
  }
}, 120_000);
