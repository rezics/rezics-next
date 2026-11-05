import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccountTokenProvider, CredentialDeniedError, IMPORTER_SCOPES } from '../src/credentials.ts';

// Local crypto/file-boundary proof. The frozen kernel journey supplies native Auth/Access acceptance.
test('reopening credentials reads the rotated key at the same private path and preserves the six scopes', async () => {
  const directory = await mkdtemp('/dev/shm/importer-key-rotation-unit-');
  try {
    const path = join(directory, 'account.jwk');
    const account = randomUUID();
    const client = 'rotation-unit';
    const authOrigin = 'https://auth.rotation.test';
    const generate = async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const kid = randomUUID();
      return {
        kid,
        publicKey: pair.publicKey,
        jwk: { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'ES256', kid },
      };
    };
    const old = await generate();
    const fresh = await generate();
    const active = new Map([[old.kid, old.publicKey]]);
    const signIns: { kid: string; account: string; client: string; scopes: string[]; status: number }[] = [];
    let minted = 0;
    const upstream = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe(authOrigin);
      if (url.pathname === '/signin/key') {
        const body = await request.json();
        const [header, payload, signature] = body.assertion.split('.') as [string, string, string];
        const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        expect(claims.sub).toBe(account);
        expect(claims.aud).toBe(`${authOrigin}/token`);
        const publicKey = active.get(kid);
        const valid =
          publicKey &&
          (await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            publicKey,
            Buffer.from(signature, 'base64url'),
            Buffer.from(`${header}.${payload}`),
          ));
        const status = valid ? 200 : 401;
        signIns.push({ kid, account: body.account_id, client: body.client_id, scopes: body.scope, status });
        return Response.json(
          {},
          { status, ...(valid ? { headers: { 'set-cookie': 'unit-session=private; HttpOnly; Secure' } } : {}) },
        );
      }
      expect(url.pathname).toBe('/token');
      expect(request.headers.get('cookie')).toBe('unit-session=private');
      return Response.json({ access_token: `unit-token-${++minted}`, token_type: 'Bearer', expires_in: 300 });
    }) as typeof fetch;
    const options = { accountKeyPath: path, account, client, authOrigin, fetch: upstream };
    await writeFile(path, JSON.stringify(old.jwk), { mode: 0o600 });
    const oldProvider = await createAccountTokenProvider(options);
    const originalToken = await oldProvider();
    active.set(fresh.kid, fresh.publicKey);
    await writeFile(path, JSON.stringify(fresh.jwk), { mode: 0o600 });
    active.delete(old.kid);
    // Retiring a signing key does not itself revoke a previously issued bearer.
    expect(await oldProvider()).toBe(originalToken);
    await expect(oldProvider(true)).rejects.toBeInstanceOf(CredentialDeniedError);
    const newProvider = await createAccountTokenProvider(options);
    expect(await newProvider()).not.toBe(originalToken);
    expect(signIns.map(({ kid, status }) => ({ kid, status }))).toEqual([
      { kid: old.kid, status: 200 },
      { kid: old.kid, status: 401 },
      { kid: fresh.kid, status: 200 },
    ]);
    for (const observed of signIns) {
      expect(observed.account).toBe(account);
      expect(observed.client).toBe(client);
      expect(observed.scopes).toEqual([...IMPORTER_SCOPES]);
      expect(observed.scopes).not.toContain('media:complete');
    }
    expect(minted).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
