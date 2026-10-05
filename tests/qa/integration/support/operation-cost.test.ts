import { expect, spyOn, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  FusekiClient,
  type CommandEnvelope,
} from '../../../../services/main/src/infrastructure/fuseki.ts';
import { DiscoveryRefreshWorker } from '../../../../services/main/src/modules/discovery/refresh.ts';
import { RankingBuildWorker } from '../../../../services/main/src/modules/recommendation/build-worker.ts';
import { NotificationDigestWorker } from '../../../../services/main/src/modules/notification/digest.ts';
import { NotificationProducerWorker } from '../../../../services/main/src/modules/notification-producers/producer.ts';
import { CountingPool, isForegroundOperation, runBackgroundOperation } from './operation-cost.ts';
import { measureGraphResponses } from './graph-responses.ts';
import { ObservedFuseki } from './observed-fuseki.ts';

test('owner checkout and response observers share attribution across awaits, callbacks and failed calls', async () => {
  const client = { release() {} } as PoolClient;
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation((async (
    callback?: (error: Error | undefined, client: PoolClient, release: () => void) => void,
  ) => {
    await delay(1);
    callback?.(undefined, client, client.release);
    return client;
  }) as Pool['connect']);
  const query = spyOn(FusekiClient.prototype, 'query').mockImplementation(async (sparql) => {
    await delay(1);
    if (sparql === 'failed') throw new Error('query failed');
    return { results: { bindings: sparql === 'background' ? [{}, {}, {}] : [{}] } };
  });
  const access = new CountingPool(),
    content = new CountingPool();
  const fuseki = new FusekiClient('http://fuseki.test/');
  try {
    const measured = await measureGraphResponses(fuseki, async () => {
      const background = runBackgroundOperation(async () => {
        await delay(1);
        await access.connect();
        await content.connect();
        await fuseki.query('background');
        await expect(fuseki.query('failed')).rejects.toThrow('query failed');
      });
      await Promise.all([
        background,
        access.connect(),
        content.connect(),
        fuseki.query('foreground'),
      ]);
      await new Promise<void>((resolve, reject) =>
        access.connect((error, connected, release) => {
          if (error) return reject(error);
          expect(isForegroundOperation()).toBe(true);
          expect(connected).toBe(client);
          release();
          resolve();
        }),
      );
      await expect(fuseki.query('failed')).rejects.toThrow('query failed');
      return 'delivered';
    });
    expect(measured.value).toBe('delivered');
    expect(measured.cost).toEqual({ graphCalls: 2, graphRows: 1 });
    expect(access.checkouts).toBe(2);
    expect(content.checkouts).toBe(1);
    expect(connect).toHaveBeenCalledTimes(5);
    expect(query).toHaveBeenCalledTimes(4);
    connect.mockImplementationOnce((async () => {
      throw new Error('checkout failed');
    }) as Pool['connect']);
    await expect(access.connect()).rejects.toThrow('checkout failed');
    expect(access.checkouts).toBe(3);
    access.checkouts = 0;
    await access.connect();
    expect(access.checkouts).toBe(1);
  } finally {
    connect.mockRestore();
    query.mockRestore();
    await Promise.all([access.end(), content.end()]);
  }
});

test('discovery, co-reader, producer and digest scheduling excludes descendants while explicit ticks count', async () => {
  const query = spyOn(FusekiClient.prototype, 'query').mockResolvedValue({ boolean: true });
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation(
    (async () =>
      ({
        release() {},
      }) as PoolClient) as Pool['connect'],
  );
  const callbacks: Array<() => void> = [];
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    // Capture callbacks in the scheduling context, as a native timer does.
    const background = !isForegroundOperation();
    callbacks.push(() => (background ? runBackgroundOperation(callback) : callback()));
    return { unref() {} };
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const pool = new CountingPool();
  const fuseki = new FusekiClient('http://fuseki.test/');
  let foreground = 0,
    background = 0;
  const tick = async () => {
    await delay(1);
    if (isForegroundOperation()) foreground++;
    else background++;
    await pool.connect();
    await fuseki.query('tick');
  };
  // These tests exercise the real scheduling methods without requiring owner storage.
  const discovery = new DiscoveryRefreshWorker(
    ...([{}, {}, {}] as unknown as ConstructorParameters<typeof DiscoveryRefreshWorker>),
  );
  const ranking = new RankingBuildWorker(
    ...([{}, {}] as unknown as ConstructorParameters<typeof RankingBuildWorker>),
  );
  const digest = new NotificationDigestWorker(
    ...([{}, {}, '', '', ''] as unknown as ConstructorParameters<typeof NotificationDigestWorker>),
  );
  const producerOwner = {
    runRelationshipRecoveryOnce: tick,
    runAccessOnce: async () => {
      await tick();
      return 0;
    },
    runRelayOnce: async () => 0,
    runSavedViewsRelayOnce: async () => 0,
  };
  const producer = new NotificationProducerWorker(
    producerOwner as unknown as ConstructorParameters<typeof NotificationProducerWorker>[0],
  );
  discovery.tick = async () => {
    await tick();
    return 'idle';
  };
  ranking.tick = tick;
  digest.runOnce = async () => {
    await tick();
    return false;
  };
  try {
    discovery.start();
    ranking.start();
    digest.start();
    producer.start();
    for (const callback of callbacks) callback();
    await Promise.all([discovery.stop(), ranking.stop(), digest.stop(), producer.stop()]);
    expect(background).toBe(5);
    expect(foreground).toBe(0);
    expect(pool.checkouts).toBe(0);
    await discovery.tick();
    await ranking.tick();
    await digest.runOnce();
    expect(foreground).toBe(3);
    expect(pool.checkouts).toBe(3);
    expect(query).toHaveBeenCalledTimes(8);
    expect(connect).toHaveBeenCalledTimes(8);
  } finally {
    await Promise.all([
      discovery.stop(),
      ranking.stop(),
      digest.stop(),
      producer.stop(),
      pool.end(),
    ]);
    interval.mockRestore();
    clear.mockRestore();
    connect.mockRestore();
    query.mockRestore();
  }
});

test('query shapes, health fences and commands exclude background failures and count foreground failures', async () => {
  const query = spyOn(FusekiClient.prototype, 'query').mockResolvedValue({ boolean: true });
  const health = spyOn(FusekiClient.prototype, 'commandHealth').mockImplementation(async () => {
    await delay(1);
    throw new Error('health unavailable');
  });
  const command = spyOn(FusekiClient.prototype, 'commandWithReceipt').mockImplementation(
    async () => {
      await delay(1);
      throw new Error('command unavailable');
    },
  );
  const fuseki = new ObservedFuseki('http://fuseki.test/');
  const envelope = {} as CommandEnvelope;
  const operation = async (shape: string) => {
    await delay(1);
    await fuseki.query(shape, 4096);
    await expect(fuseki.commandHealth()).rejects.toThrow('health unavailable');
    await expect(fuseki.commandWithReceipt(envelope)).rejects.toThrow('command unavailable');
  };
  try {
    await Promise.all([
      runBackgroundOperation(() => operation('background')),
      operation('foreground'),
    ]);
    expect(fuseki.queries).toEqual(['foreground']);
    expect(fuseki.healthReads).toBe(1);
    expect(fuseki.commands).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith('foreground', 4096);
    expect(health).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledTimes(2);
  } finally {
    query.mockRestore();
    health.mockRestore();
    command.mockRestore();
  }
});
