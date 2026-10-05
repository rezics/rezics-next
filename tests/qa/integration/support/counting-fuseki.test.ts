import { expect, spyOn, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { FusekiClient } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { RealmDirectoryIndex } from '../../../../services/main/src/modules/realm-directory/index.ts';
import { RealmDirectoryWorker } from '../../../../services/main/src/modules/realm-directory/worker.ts';
import type { MainWorkDependencies } from '../../../../services/main/src/routes/dependencies.ts';
import { attributeDirectoryRefreshQueries, CountingFuseki } from './counting-fuseki.ts';

test('operation query counts exclude concurrent refresh descendants and retain failed foreground calls', async () => {
  const query = spyOn(FusekiClient.prototype, 'query').mockImplementation(async sparql => {
    await delay(1);
    if (sparql === 'failed') throw new Error('query failed');
    return { boolean: true };
  });
  try {
    const fuseki = new CountingFuseki('http://fuseki.test/');
    const other = new CountingFuseki('http://other-fuseki.test/');
    const background = fuseki.runBackground(async () => {
      await delay(5);
      expect(fuseki.isBackgroundContext).toBe(true);
      expect(other.isBackgroundContext).toBe(true);
      await fuseki.query('background', 4096);
      await Promise.all([fuseki.query('background child'), other.query('other background')]);
    });
    const before = fuseki.queries;
    expect(fuseki.isBackgroundContext).toBe(false);
    await Promise.all([background, fuseki.query('operation'), fuseki.query('operation child'),
      other.query('other operation')]);
    expect(fuseki.queries - before).toBe(2);
    expect(other.queries).toBe(1);
    expect(query).toHaveBeenCalledWith('background', 4096);
    await expect(fuseki.runBackground(() => fuseki.query('failed'))).rejects.toThrow('query failed');
    expect(fuseki.queries).toBe(2);
    await expect(fuseki.query('failed')).rejects.toThrow('query failed');
    expect(fuseki.queries).toBe(3);
    fuseki.queries = 0;
    await fuseki.query('after reset');
    expect(fuseki.queries).toBe(1);
  } finally { query.mockRestore(); }
});

test('directory startup, interval, request nudges and follow-up ticks preserve operation counts', async () => {
  const query = spyOn(FusekiClient.prototype, 'query').mockResolvedValue({ boolean: true });
  const fuseki = new CountingFuseki('http://fuseki.test/');
  const index = new RealmDirectoryIndex({ ending: false, ended: false } as Pool);
  const worker = new RealmDirectoryWorker({ access: { realmDirectory: index } } as MainWorkDependencies);
  let ticks = 0;
  let completed!: () => void;
  let checkpoint = new Promise<void>(resolve => { completed = resolve; });
  worker.tick = async () => {
    await delay(1);
    await fuseki.query('directory refresh');
    ticks++;
    if (ticks % 2 === 0) completed();
    return ticks % 2 === 0;
  };
  try {
    attributeDirectoryRefreshQueries();
    attributeDirectoryRefreshQueries(); // Repeated fixture startup must not stack wrappers.
    // Startup can happen on a foreground request after app construction.
    worker.start();
    await checkpoint;
    expect(ticks).toBe(2);
    expect(fuseki.queries).toBe(0);

    checkpoint = new Promise<void>(resolve => { completed = resolve; });
    await checkpoint;
    await worker.stop();
    expect(ticks).toBe(4);
    expect(fuseki.queries).toBe(0);

    checkpoint = new Promise<void>(resolve => { completed = resolve; });
    // A request can restart a stopped scheduler through a foreground nudge.
    worker.nudge();
    await Promise.all([checkpoint, fuseki.query('request operation')]);
    await worker.stop();
    expect(ticks).toBe(6);
    expect(fuseki.queries).toBe(1);

    await worker.tick();
    expect(fuseki.queries).toBe(2);
  } finally {
    await worker.stop();
    query.mockRestore();
  }
});
