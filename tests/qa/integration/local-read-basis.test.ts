import { expect, test } from 'bun:test';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';

// These destructive source fixtures run in separate test processes against
// this one disposable QA project. Reset and bootstrap before each child's
// projection starts; the first fixture deliberately leaves a graph sequence gap.
test('Local dependency and relay compatibility native fixtures', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run these destructive source fixtures through the isolated integration tier');
  }
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  for (const file of ['services/main/tests/local-read-basis.test.ts', 'services/main/tests/outbox.integration.test.ts']) {
    // A fresh epoch prevents retained SQL coverage or custody from aliasing the
    // graph positions reused by this disposable fixture.
    const dataEpoch = Bun.randomUUIDv7();
    await fuseki.resetDataset();
    await initializeFreshGraph(fuseki, { dataEpoch, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH });
    const child = Bun.spawn([process.execPath, 'test', file], { stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, MAIN_DATA_EPOCH: dataEpoch } });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ file, code, output: stdout + stderr }).toMatchObject({ code: 0 });
  }
}, 240_000);
