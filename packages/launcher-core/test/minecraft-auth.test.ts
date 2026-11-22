import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinecraftAuth } from '../src/minecraft-auth.ts';

const protectedFixture = {
  encrypt: (plain: string) => Buffer.from(plain).toString('base64'),
  decrypt: (encrypted: string) => Buffer.from(encrypted, 'base64').toString(),
};

async function stored(file: string, record: object) {
  await writeFile(file, JSON.stringify({ encrypted: protectedFixture.encrypt(JSON.stringify(record)) }));
}

function provider() {
  const one = { id: 'primary', name: 'Primary' };
  const two = { id: 'secondary', name: 'Secondary' };
  const accounts = [one, two];
  let identity = two.id;
  let override:
    | ((route: string, request: RequestInit | undefined) => Response | Promise<Response> | undefined)
    | undefined;
  const calls: string[] = [];
  return {
    one,
    two,
    calls,
    signInAs: (id: string) => {
      identity = id;
    },
    override: (handler?: typeof override) => {
      override = handler;
    },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      const route = url.pathname.split('/').at(-1)!;
      calls.push(route);
      const replacement = override?.(route, init);
      if (replacement) return replacement;
      if (url.hostname === 'login.microsoftonline.com') {
        const fields = init?.body as URLSearchParams;
        expect(fields.get('client_id')).toBe('test-app');
        if (route === 'devicecode') {
          return Response.json({
            device_code: `device-secret:${identity}`,
            user_code: 'PUBLIC-CODE',
            verification_uri: 'https://www.microsoft.com/link',
            expires_in: 60,
            interval: 1,
          });
        }
        const source = fields.get('refresh_token') ?? fields.get('device_code');
        const id = source?.split(':').at(-1);
        return Response.json({ access_token: `ms-secret:${id}`, refresh_token: `rotated-secret:${id}` });
      }
      const body = init?.body && JSON.parse(String(init.body));
      if (route === 'authenticate')
        return Response.json({ Token: `xbl-secret:${body.Properties.RpsTicket.split(':').at(-1)}` });
      if (route === 'authorize') {
        return Response.json({
          Token: `xsts-secret:${body.Properties.UserTokens[0].split(':').at(-1)}`,
          DisplayClaims: { xui: [{ uhs: 'hash' }] },
        });
      }
      if (route === 'login_with_xbox') {
        return Response.json({ access_token: `game-secret:${body.identityToken.split(':').at(-1)}`, expires_in: 3600 });
      }
      if (route === 'mcstore') return Response.json({ items: [{ name: 'product_minecraft' }] });
      const id = new Headers(init?.headers).get('authorization')?.split(':').at(-1);
      if (route === 'profile') return Response.json(accounts.find((item) => item.id === id));
      throw new Error('Unexpected fixture request');
    }) as typeof fetch,
  };
}

async function temporaryAuth(test: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rezics-account-test-'));
  try {
    await test(join(directory, 'account.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function settledSignIn(auth: MinecraftAuth) {
  const result = Promise.withResolvers<ReturnType<MinecraftAuth['readSignIn']>>();
  const inspect = () => {
    const status = auth.readSignIn();
    if (status.state === 'signed-in' || status.state === 'failed') result.resolve(status);
  };
  const stop = auth.subscribeSignIn(inspect);
  inspect();
  try {
    return await result.promise;
  } finally {
    stop();
  }
}

test('uses the configured application, checks Java entitlement, and stores only the encrypted account', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rezics-account-test-'));
  try {
    const file = join(home, 'account.json');
    const calls: string[] = [];
    let entitled = false;
    const fixtureFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const key = url.pathname.split('/').at(-1)!;
      calls.push(key);
      if (url.hostname === 'login.microsoftonline.com') {
        expect((init?.body as URLSearchParams).get('client_id')).toBe('test-app');
        if (key === 'devicecode') {
          return Response.json({
            device_code: 'oauth-device-secret',
            user_code: 'CODE-FOR-PLAYER',
            verification_uri: 'https://www.microsoft.com/link',
            expires_in: 45,
            interval: 1,
          });
        }
        return Response.json({ access_token: 'oauth-secret', refresh_token: 'refresh-secret' });
      }
      if (key === 'authenticate') return Response.json({ Token: 'xbl-secret' });
      if (key === 'authorize') return Response.json({ Token: 'xsts-secret', DisplayClaims: { xui: [{ uhs: 'u' }] } });
      if (key === 'login_with_xbox') return Response.json({ access_token: 'minecraft-secret', expires_in: 3_600 });
      if (key === 'profile') return Response.json({ id: 'profile-uuid', name: 'FixturePlayer' });
      if (key === 'mcstore') return Response.json({ items: entitled ? [{ name: 'game_minecraft' }] : [] });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const camouflage = {
      encrypt: (plain: string) => Buffer.from(plain).toString('base64'),
      decrypt: (encrypted: string) => Buffer.from(encrypted, 'base64').toString(),
    };
    const auth = new MinecraftAuth('test-app', file, camouflage, fixtureFetch);
    await auth.begin();
    const waiting = auth.readSignIn();
    expect(waiting).toMatchObject({
      state: 'waiting',
      device: { url: 'https://www.microsoft.com/link', code: 'CODE-FOR-PLAYER' },
    });
    expect(JSON.stringify(waiting)).not.toContain('oauth-device-secret');
    expect(await settledSignIn(auth)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('Java entitlement'),
    });
    expect(await auth.account()).toBeNull();

    entitled = true;
    await auth.begin();
    expect(await settledSignIn(auth)).toEqual({ state: 'signed-in' });
    const account = await auth.account();
    expect(account).toEqual({ id: 'profile-uuid', name: 'FixturePlayer' });
    expect(calls).toContain('mcstore');
    expect(await readFile(file, 'utf8')).not.toContain('minecraft-secret');
    const restarted = new MinecraftAuth('test-app', file, camouflage, fixtureFetch);
    expect(await restarted.account()).toEqual(account);
    await restarted.signOut();
    expect(await restarted.account()).toBeNull();
    await expect(readFile(file)).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('migrates a protected legacy account, selects exact profiles and permits an unexpired cache offline', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    await stored(file, {
      clientId: 'test-app',
      profile: service.one,
      token: 'cached-secret:primary',
      refresh: 'refresh-secret:primary',
      expiresAt: Date.now() + 20_000,
    });
    const auth = new MinecraftAuth('test-app', file, protectedFixture, service.fetch);
    const initial = await auth.accounts();
    expect(initial).toEqual({ activeId: 'primary', profiles: [{ ...service.one, state: 'ready' }], persistent: true });
    const encrypted = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(encrypted)).toEqual(['encrypted']);
    expect(JSON.parse(protectedFixture.decrypt(encrypted.encrypted))).toMatchObject({
      version: 2,
      activeId: 'primary',
    });

    await auth.begin();
    expect(auth.readSignIn()).toEqual({
      state: 'waiting',
      device: { url: 'https://www.microsoft.com/link', code: 'PUBLIC-CODE', expiresAt: expect.any(Number) },
    });
    expect(await settledSignIn(auth)).toEqual({ state: 'signed-in' });
    const profiles = await auth.accounts();
    expect(profiles).toEqual({
      activeId: 'secondary',
      profiles: [
        { ...service.one, state: 'ready' },
        { ...service.two, state: 'ready' },
      ],
      persistent: true,
    });
    expect(JSON.stringify(profiles)).not.toContain('secret');

    await auth.begin(service.one.id);
    expect(await settledSignIn(auth)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('same Minecraft profile'),
    });
    expect(await auth.accounts()).toEqual(profiles);

    await auth.select(service.one.id);
    await auth.begin(service.two.id);
    expect(await settledSignIn(auth)).toEqual({ state: 'signed-in' });
    expect((await auth.accounts()).activeId).toBe(service.one.id);

    service.override(() => {
      throw new Error('Provider unreachable and a private response');
    });
    const before = service.calls.length;
    const restarted = new MinecraftAuth('test-app', file, protectedFixture, service.fetch);
    expect((await restarted.select(service.one.id)).activeId).toBe(service.one.id);
    expect(await restarted.launchCredentials()).toEqual({ profile: service.one, token: 'cached-secret:primary' });
    expect(await restarted.launchCredentials(service.two.id)).toEqual({
      profile: service.two,
      token: 'game-secret:secondary',
    });
    expect(service.calls).toHaveLength(before);

    expect(await restarted.forget(service.one.id)).toEqual({
      activeId: null,
      profiles: [{ ...service.two, state: 'ready' }],
      persistent: true,
    });
    await expect(restarted.launchCredentials()).rejects.toThrow('Select or sign in');
    await expect(restarted.launchCredentials(service.one.id)).rejects.toThrow('profile for this instance');
    expect((await restarted.launchCredentials(service.two.id)).profile).toEqual(service.two);

    const changedApp = new MinecraftAuth('another-app', file, protectedFixture, service.fetch);
    expect((await changedApp.accounts()).profiles).toEqual([{ ...service.two, state: 'needs-sign-in' }]);
    await expect(changedApp.launchCredentials(service.two.id)).rejects.toThrow('expired');
    expect(service.calls).toHaveLength(before);

    service.override();
    await restarted.begin(service.two.id);
    expect(await settledSignIn(restarted)).toEqual({ state: 'signed-in' });
    expect((await restarted.accounts()).activeId).toBeNull();
  });
}, 7000);

test('refreshes an expired selection online, distinguishes denial and recovers the same profile', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    const expired = {
      version: 2,
      clientId: 'test-app',
      activeId: service.one.id,
      profiles: [
        {
          profile: service.one,
          token: 'expired-secret:primary',
          refresh: 'refresh-secret:primary',
          expiresAt: Date.now() - 1000,
        },
      ],
    };
    await stored(file, expired);
    const auth = new MinecraftAuth('test-app', file, protectedFixture, service.fetch);
    service.override(() => {
      throw new Error('https://fixture.invalid/?token=private-network-secret');
    });
    await expect(auth.launchCredentials()).rejects.toThrow('could not be reached');
    expect((await auth.accounts()).profiles[0]?.state).toBe('ready');

    service.override();
    const before = service.calls.filter((route) => route === 'token').length;
    const [launch, joined] = await Promise.all([auth.launchCredentials(), auth.launchCredentials()]);
    expect(launch).toEqual({ profile: service.one, token: 'game-secret:primary' });
    expect(joined).toEqual(launch);
    expect(service.calls.filter((route) => route === 'token')).toHaveLength(before + 1);

    await stored(file, expired);
    const restarted = new MinecraftAuth('test-app', file, protectedFixture, service.fetch);
    service.override((route) =>
      route === 'token'
        ? Response.json({ error: 'invalid_grant', error_description: 'private-denial-secret' }, { status: 400 })
        : undefined,
    );
    await expect(restarted.launchCredentials()).rejects.toThrow('expired');
    expect(await restarted.accounts()).toEqual({
      activeId: service.one.id,
      profiles: [{ ...service.one, state: 'needs-sign-in' }],
      persistent: true,
    });
    const denied = service.calls.length;
    await expect(restarted.launchCredentials()).rejects.toThrow('expired');
    expect(service.calls).toHaveLength(denied);

    service.override();
    service.signInAs(service.one.id);
    await restarted.begin(service.one.id);
    expect(await settledSignIn(restarted)).toEqual({ state: 'signed-in' });
    expect((await restarted.accounts()).profiles[0]?.state).toBe('ready');
  });
});

test('cancels a pending login and keeps accounts in memory when protected storage is unavailable', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    const auth = new MinecraftAuth('test-app', file, undefined, service.fetch);
    const states: string[] = [];
    const stop = auth.subscribeSignIn(() => states.push(auth.readSignIn().state));
    await auth.begin();
    await expect(auth.begin()).rejects.toThrow('already in progress');
    await auth.cancelSignIn();
    expect(auth.readSignIn()).toEqual({ state: 'idle' });
    expect(await auth.accounts()).toEqual({ activeId: null, profiles: [], persistent: false });
    expect(service.calls).toEqual(['devicecode']);

    await auth.begin();
    expect(await settledSignIn(auth)).toEqual({ state: 'signed-in' });
    stop();
    expect(states).toEqual(['requesting', 'waiting', 'idle', 'requesting', 'waiting', 'saving', 'signed-in']);
    expect(await auth.accounts()).toEqual({
      activeId: service.two.id,
      profiles: [{ ...service.two, state: 'ready' }],
      persistent: false,
    });
    await expect(readFile(file)).rejects.toThrow();
    expect((await new MinecraftAuth('test-app', file, undefined, service.fetch).accounts()).profiles).toEqual([]);
  });
});

test('ignores a cancelled device response even when a new sign-in is waiting', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    const entered = Promise.withResolvers<AbortSignal>();
    const response = Promise.withResolvers<Response>();
    service.override((route, init) => {
      if (route !== 'token') return;
      entered.resolve(init!.signal!);
      return response.promise;
    });
    const auth = new MinecraftAuth('test-app', file, undefined, service.fetch);
    await auth.begin();
    const signal = await entered.promise;
    await auth.cancelSignIn();
    expect(signal.aborted).toBe(true);

    service.override();
    await auth.begin();
    response.resolve(Response.json({ error: 'authorization_declined' }, { status: 400 }));
    expect(await settledSignIn(auth)).toEqual({ state: 'signed-in' });
    expect(await auth.account()).toEqual(service.two);
    expect(service.calls.filter((name) => name === 'profile')).toHaveLength(1);
  });
});

test('forgetting a profile aborts its online refresh and prevents its return to storage', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    await stored(file, {
      clientId: 'test-app',
      profile: service.one,
      token: 'expired-secret:primary',
      refresh: 'refresh-secret:primary',
      expiresAt: Date.now() - 1,
    });
    const entered = Promise.withResolvers<void>();
    service.override((route, request) =>
      route === 'token'
        ? new Promise((_resolve, reject) => {
            request!.signal!.addEventListener('abort', () => reject(new Error('private transfer was aborted')), {
              once: true,
            });
            entered.resolve();
          })
        : undefined,
    );
    const auth = new MinecraftAuth('test-app', file, protectedFixture, service.fetch);
    const launch = auth.launchCredentials().catch((error: unknown) => error);
    await entered.promise;
    expect(await auth.forget(service.one.id)).toEqual({ activeId: null, profiles: [], persistent: true });
    const changed = await launch;
    expect(changed).toBeInstanceOf(Error);
    expect((changed as Error).message).toContain('profile changed');
    await expect(readFile(file)).rejects.toThrow();
  });
});

test('gives distinct safe errors for application, Xbox, profile, authorization and connectivity failures', async () => {
  await temporaryAuth(async (file) => {
    const service = provider();
    const auth = new MinecraftAuth('test-app', file, undefined, service.fetch);
    const approvalMissing = new MinecraftAuth(undefined, file, undefined, service.fetch);
    await approvalMissing.begin();
    expect(approvalMissing.readSignIn()).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('approved REZICS Microsoft application'),
    });
    const cases = [
      {
        route: 'login_with_xbox',
        status: 403,
        error: 'ForbiddenOperationException',
        message: /denied the REZICS application/u,
      },
      { route: 'authorize', status: 401, error: 'Xbox failure', message: /Xbox could not authorize/u },
      { route: 'profile', status: 404, error: 'NOT_FOUND', message: /no Minecraft Java player profile/u },
      { route: 'token', status: 400, error: 'authorization_declined', message: /sign-in was denied/u },
      { route: 'mcstore', status: 503, error: 'Service unavailable', message: /could not be reached/u },
    ];
    const privateValue = 'https://fixture.invalid/raw-authorization-secret';
    for (const failure of cases) {
      service.override((route) =>
        route === failure.route
          ? Response.json({ error: failure.error, error_description: privateValue }, { status: failure.status })
          : undefined,
      );
      await auth.begin();
      const status = await settledSignIn(auth);
      expect(status).toMatchObject({ state: 'failed', message: expect.stringMatching(failure.message) });
      expect(JSON.stringify(status)).not.toContain(privateValue);
    }
    expect((await auth.accounts()).profiles).toEqual([]);
  });
}, 9000);
