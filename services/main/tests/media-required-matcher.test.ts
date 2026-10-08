import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import {
  requiredMatcherMode,
  requiredSafetyMatcher,
  LocalRequiredSafetyMatcher,
  UnavailableRequiredSafetyMatcher,
} from '../src/modules/media-screen/required-matcher.ts';
import { RequiredMediaMatchWorker } from '../src/modules/media-screen/required-match-worker.ts';
import type {
  RequiredMediaMatchStore,
  RequiredMatchLease,
} from '../src/modules/media-screen/required-match-store.ts';
import { mainConfig } from '../src/config.ts';
import { checkProductionEnv } from '../../../scripts/ops/production-env.ts';
import { productionExample } from '../../../scripts/ops/tests/g-722-fixture.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');

test('local required matching reads the current exact corpus; missing, corrupt and aborted providers never clear media', async () => {
  const directory = `.temp/media-matcher-unit-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/corpus.json`;
  const matcher = new LocalRequiredSafetyMatcher(path);
  const signal = new AbortController().signal;
  try {
    await expect(matcher.match(bytes, 'image/png', signal)).rejects.toThrow();
    await Bun.write(path, '[]');
    expect(await matcher.match(bytes, 'image/png', signal)).toBe('clear');
    await Bun.write(path, JSON.stringify([digest]));
    expect(await matcher.match(bytes, 'image/png', signal)).toBe('blocked');
    await Bun.write(path, '["invalid"]');
    await expect(matcher.match(bytes, 'image/png', signal)).rejects.toThrow('corpus is invalid');
    await Bun.write(path, '[]');
    await expect(matcher.match(bytes, 'image/png', AbortSignal.abort())).rejects.toThrow();
    await expect(matcher.match(new Uint8Array(), 'image/png', signal)).rejects.toThrow(
      'byte bound',
    );
    await expect(new UnavailableRequiredSafetyMatcher().match()).rejects.toThrow('not configured');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('required matcher worker fences integrity failures, deadlines and late provider answers without issuing clearance', async () => {
  const lease: RequiredMatchLease = {
    job: randomUUID(),
    asset: randomUUID(),
    source: randomUUID(),
    token: randomUUID(),
    epoch: '0',
    digest,
    namespace: 'media/asset/',
    mediaType: 'image/png',
  };
  let settled = 0;
  let matched = 0;
  const store = {
    leaseNext: async () => lease,
    settle: async () => {
      settled++;
      return true;
    },
  } as unknown as RequiredMediaMatchStore;
  const objects = (returned: Uint8Array) => () =>
    ({ get: async () => returned }) as unknown as ImmutableObjects;
  await new RequiredMediaMatchWorker(
    store,
    {
      match: async () => {
        matched++;
        return 'clear';
      },
    },
    objects(new Uint8Array([9])),
    10,
  ).tick();
  expect(matched).toBe(0);
  expect(settled).toBe(0);
  let answer: ((value: 'clear') => void) | undefined;
  let providerSignal: AbortSignal | undefined;
  await new RequiredMediaMatchWorker(
    store,
    {
      match: (_bytes, _mediaType, signal) => {
        providerSignal = signal;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    },
    objects(bytes),
    10,
  ).tick();
  expect(providerSignal?.aborted).toBe(true);
  answer!('clear');
  await Bun.sleep(1);
  expect(settled).toBe(0);
  await new RequiredMediaMatchWorker(
    store,
    { match: async () => 'clear' },
    objects(bytes),
    10,
  ).tick();
  expect(settled).toBe(1);
});

test('matcher configuration defaults to none in every environment and production refuses local corpora', async () => {
  const env = productionExample();
  delete env.MAIN_REQUIRED_MEDIA_MATCHER;
  for (const NODE_ENV of [undefined, 'development', 'test', 'production']) {
    const config = mainConfig({ ...env, NODE_ENV });
    expect(config.MAIN_REQUIRED_MEDIA_MATCHER).toBe('none');
    expect(
      requiredSafetyMatcher(requiredMatcherMode(config.MAIN_REQUIRED_MEDIA_MATCHER)),
    ).toBeUndefined();
  }
  expect(checkProductionEnv(env).MAIN_REQUIRED_MEDIA_MATCHER).toBe('none');
  expect(
    checkProductionEnv({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: 'provider' })
      .MAIN_REQUIRED_MEDIA_MATCHER,
  ).toBe('provider');
  const local = 'local:.temp/test-owned-corpus.json';
  expect(
    mainConfig({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: local, NODE_ENV: 'test' })
      .MAIN_REQUIRED_MEDIA_MATCHER,
  ).toBe(local);
  expect(requiredMatcherMode(local)).toEqual({
    kind: 'local',
    path: '.temp/test-owned-corpus.json',
  });
  expect(() =>
    mainConfig({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: local, NODE_ENV: 'production' }),
  ).toThrow('Production forbids local');
  // Main processes media, so a role set that includes it refuses a local corpus.
  // A web-only role has no matcher duty.
  expect(() =>
    checkProductionEnv({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: local }, ['main']),
  ).toThrow('Production forbids local');
  expect(
    checkProductionEnv({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: local }, ['web']).isProduction,
  ).toBe(true);
  expect(() => checkProductionEnv({ ...env, MAIN_REQUIRED_MEDIA_MATCHER: 'unexpected' })).toThrow(
    'must be none',
  );
  for (const value of ['', 'local', 'local:', 'local:   ', 'NONE', 'provider:fixture']) {
    expect(() => requiredMatcherMode(value)).toThrow('must be none');
  }
  const provider = requiredSafetyMatcher(requiredMatcherMode('provider', true))!;
  await expect(provider.match(bytes, 'image/png', new AbortController().signal)).rejects.toThrow(
    'not configured',
  );
});

test('ops:env-check prints the matcher mode and rejects local before opening owners', async () => {
  const directory = `.temp/media-matcher-env-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  try {
    const path = `${directory}/production.env`;
    for (const mode of [undefined, 'provider', 'local:.temp/no-corpus.json']) {
      await Bun.write(path, mode ? `MAIN_REQUIRED_MEDIA_MATCHER=${mode}\n` : '# default mode\n');
      const child = Bun.spawn(['task', 'ops:env-check', '--', path], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stdout).toContain(`Required media matcher mode: ${mode ?? 'none'}`);
      // The incomplete environment fails validation without reaching any database.
      expect(code).not.toBe(0);
      expect(stderr).toContain(
        mode?.startsWith('local:')
          ? 'Production forbids local'
          : 'Invalid production configuration',
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
