import { expect, test } from 'bun:test';

async function scenario(mode: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/support/outcome-lifecycle-child.ts`, mode], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  await new Response(child.stderr).text();
  const result = output.split(/\r?\n/).findLast((line) => line.startsWith('RESULT:'));
  const failure = output.split(/\r?\n/).findLast((line) => line.startsWith('FAIL:'));
  expect(exitCode, failure ?? '').toBe(0);
  expect(result).toBeDefined();
  return JSON.parse(result!.slice('RESULT:'.length)) as Record<string, unknown>;
}

test('owned outcome lifecycle hands actual worker identity to an external runtime and drains before database cleanup', async () => {
  const result = await scenario('external-runtime');
  expect(result).toMatchObject({
    runtimeValidated: true,
    runtimeStoppedBeforeKernelDrop: true,
    realAuthAndAccessUsedDuringClose: true,
    externalProjectionRejected: true,
    ownershipAcknowledgedBeforeAllocation: true,
    ownedDatabasesRemoved: true,
  });
}, 180_000);

test('owned Auth cleanup awaits its host listener watcher and database without hiding failures', async () => {
  const result = { ...(await scenario('auth-cleanup')), ...(await scenario('cleanup-failure')) };
  expect(result).toMatchObject({
    closeIsShared: true,
    authCloseIsShared: true,
    listenerClosed: true,
    watcherAndAuthDatabaseDrained: true,
    setupErrorPreserved: true,
    cleanupFailureReported: true,
    laterCleanupAttempted: true,
  });
}, 180_000);

test('owned Auth cleanup closes its allocated pool when host construction fails before SDK launch', async () => {
  const result = await scenario('auth-construction-failure');
  expect(result).toMatchObject({
    configurationErrorPreserved: true,
    authPoolEndCompletions: 1,
    authPoolEndStage: 'before listener stop and watcher drain',
    listenerClosed: true,
    watcherDrained: true,
    ownedDatabasesRemoved: true,
  });
}, 180_000);

test('default semantic outcome callers retain owned link projection behavior', async () => {
  const result = await scenario('default-projection');
  expect(result).toMatchObject({
    defaultProjectionPausedAndResumed: true,
    cachedAuthOwnershipReplayed: true,
    ownedDatabasesRemoved: true,
  });
}, 180_000);
