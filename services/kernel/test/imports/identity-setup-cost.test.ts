import { expect, test } from 'bun:test';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport, type ImportIdentity } from './identity-fixture.ts';

type SetupCounters = {
  authMigrationCalls: number;
  baselineWorkflowCalls: {
    registrations: number;
    keyInstalls: number;
  };
};

const counters = (fixture: ImportIdentity) =>
  (identitySupport(fixture) as ReturnType<typeof identitySupport> & { counters?: SetupCounters }).counters;

test('a second import identity applies no Auth migration', async () => {
  const driver = createImportIdentityDriver();
  try {
    await driver.open({ clock: () => new Date() });
    const second = await driver.open({ clock: () => new Date() });

    expect(counters(second)?.authMigrationCalls).toBe(0);
  } finally {
    await driver.close();
  }
}, 600_000);

test('baseline seeding makes the same number of native workflow calls at any count', async () => {
  const driver = createImportIdentityDriver();
  try {
    const small = await driver.open({ clock: () => new Date() });
    await identitySupport(small).seedBaseline(16);
    const smallCalls = counters(small)?.baselineWorkflowCalls;

    const large = await driver.open({ clock: () => new Date() });
    await identitySupport(large).seedBaseline(64);
    const largeCalls = counters(large)?.baselineWorkflowCalls;

    expect(smallCalls).toBeDefined();
    expect(largeCalls).toBeDefined();
    expect(smallCalls?.registrations).toBe(largeCalls?.registrations);
    expect(smallCalls?.keyInstalls).toBe(largeCalls?.keyInstalls);
  } finally {
    await driver.close();
  }
}, 600_000);
