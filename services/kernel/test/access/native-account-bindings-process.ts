import { Pool } from 'pg';
import { nativeFixture, password } from './native-account-bindings-fixture.ts';

// A separate Auth host process, deliberately killed by the parent at a committed
// native boundary. Configuration travels over stdin, never through workflow inputs.
const input = await Bun.stdin.json();
const pool = new Pool({ connectionString: input.kernelUrl });
const f = await nativeFixture(pool, undefined, {
  database: { url: input.authUrl, container: '', close() {} },
  privateKey: input.privateKey,
});
const pause = async (): Promise<never> => {
  process.stdout.write('NATIVE_CRASH_READY\n');
  return new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
if (input.phase === 'pending') f.proofs.recordPending = pause;
if (input.phase === 'operator') f.proofs.recordAutomatedPending = pause;
if (input.phase === 'credential') {
  const provision = f.host.service.internal.provisionPassword;
  f.host.service.internal.provisionPassword = async (...args) => {
    await provision(...args);
    return pause();
  };
}
if (input.phase === 'activation') {
  const activate = f.bindings.workflowPorts.activate;
  f.bindings.workflowPorts.activate = async (...args) => {
    await activate(...args);
    return pause();
  };
}
if (input.phase === 'operator') await f.automated(input.key, input.human);
else
  await f.host.workflows.register({
    key: input.key,
    handle: input.key.replaceAll('-', '_'),
    email: `${input.key}@ordinary.test`,
    password,
  });
throw new Error('Crash boundary was not reached');
