import { expect, test } from 'bun:test';
import { NativeFixtureLifecycleError, nativeFixture } from './support/erasure-native.ts';

test('failed fixture setup settles its host, attempts every release after teardown failure, and admits a successor', async () => {
  const setupFailure = new Error('injected fixture setup failure');
  const teardownFailure = new Error('injected fixture teardown failure');
  const failure = await nativeFixture({
    async startHost(host) {
      const stop = host.stop.bind(host);
      host.stop = async () => {
        await stop();
        throw teardownFailure;
      };
      // Leave the generation's startup promise owned by stop() when setup fails.
      void host.start().catch(() => {});
      throw setupFailure;
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(NativeFixtureLifecycleError);
  expect(failure).toMatchObject({
    phase: 'Auth host startup',
    cause: setupFailure,
    releaseFailures: [expect.objectContaining({ phase: 'Auth workflow host', cause: teardownFailure })],
  });

  const successor = await nativeFixture();
  await successor.close();
});
