import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { readIdentityMappings } from '../../src/semantic/identity-epoch-read.ts';
import { routeOf } from '../../src/route/route.ts';
import { home, identityEpochDatabase, seedLegacyRoot } from './support/identity-epoch.ts';

test('native retained bootstrap maps a historical cross-home chain to its actual terminal', async () => {
  const deployment = await identityEpochDatabase();
  try {
    const original = await seedLegacyRoot(deployment, 0x6110);
    const middle = await seedLegacyRoot(deployment, 0x6220);
    const terminal = await seedLegacyRoot(deployment, 0x6330);
    // Historical input predates installation. No mapping, ready bit, receiving
    // receipt or source ACK is supplied by the fixture.
    for (const [source, target] of [
      [original, middle],
      [middle, terminal],
    ]) {
      await deployment.admin.query(
        `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
         VALUES ($1,$2,1,$3,$4)`,
        [routeOf(source!), source, target, randomUUID()],
      );
    }
    expect((await installIdentityEpochBootstrap(deployment.pool)).mode).toBe('legacy');
    let observed = (await readIdentityMappings(deployment.pool, [original]))[0];
    for (let round = 0; round < 32 && observed?.state !== 'mapped'; round++) {
      for (const id of [terminal, middle, original]) {
        const progress = await stepIdentityEpochBootstrap(deployment.pool, home(id));
        expect(progress.work.rows).toBeLessThanOrEqual(100);
        expect(progress.native.partition).toBe(home(id));
      }
      observed = (await readIdentityMappings(deployment.pool, [original]))[0];
    }
    expect(observed).toMatchObject({ state: 'mapped', original, terminal });
    if (observed?.state === 'mapped') expect(observed.epoch).toBeGreaterThan(0n);
  } finally {
    await deployment.close();
  }
});
