import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { nativeFixture, password } from './support/erasure-native.ts';

let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

test('Minimize actual terminal Auth source proof payload', async () => {
  const key = randomUUID();
  const handle = `minimal_${key.replaceAll('-', '')}`;
  const email = `${key}@consumer.test`;
  const activate = f.bindings.workflowPorts.activate;
  let observed: Awaited<ReturnType<typeof activate>> | undefined;
  let original: Parameters<typeof activate>[0] | undefined;
  f.bindings.workflowPorts.activate = async (input) => {
    const result = await activate(input);
    original = input;
    observed = result;
    return result;
  };
  let registered;
  try {
    registered = await f.host.workflows.register({ key, handle, email, password });
  } finally {
    f.bindings.workflowPorts.activate = activate;
  }
  expect(observed).toBeDefined();
  expect(registered.accountId).toBe(observed!.value.accountId);
  const stage = (
    await f.pool.query('SELECT * FROM auth_registration_stage WHERE account_id=$1', [registered.accountId])
  ).rows[0]!;
  const read = async () =>
    (
      await f.pool.query(
        "SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1",
        [stage.registration_id],
      )
    ).rows[0]!;
  // Before retirement the real stage still consumes the exact reservation and
  // handle binding. A direct attempt to minimize under that reader is refused.
  const full = await read();
  expect(full.binding).toEqual([
    stage.registration_id,
    stage.consumer_workflow_id,
    stage.activation_key,
    stage.account_id,
    stage.handle,
    stage.reservation_id,
    stage.erasure_operator_id,
    stage.operator_reservation_id,
  ]);
  expect(full.result).toEqual({ outcome: 'activated', sourceResult: observed!.value });
  await expect(
    f.pool.query(
      "UPDATE auth_native_consumer_proof SET binding='null',result=jsonb_build_object('outcome','activated') WHERE store='registration' AND key=$1",
      [stage.registration_id],
    ),
  ).rejects.toThrow('Native consumer terminal proof is immutable');
  const subject = await f.login({ accountId: registered.accountId, email });
  expect((await f.delete(subject)).status).toBe(200);
  expect(
    (await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id]))
      .rowCount,
  ).toBe(0);
  const minimal = await read();
  // Keep the last actual activation result and its original command identity:
  // no expired-evidence committed-result reader is exported by Access yet.
  expect(minimal).toEqual({
    binding: [stage.registration_id, stage.consumer_workflow_id, original!.key, registered.accountId],
    result: { outcome: 'activated', sourceResult: observed!.value },
  });
  expect(JSON.stringify(minimal)).not.toContain(handle);
  await expect(
    f.pool.query(
      'INSERT INTO auth_registration_stage SELECT (jsonb_populate_record(NULL::auth_registration_stage,$1::jsonb)).*',
      [JSON.stringify(stage)],
    ),
  ).rejects.toThrow('Native registration consumer is terminal');
  await expect(activate(original!)).rejects.toThrow();
  await f.host.workflows.redriveNativeErasure();
  expect(await read()).toEqual(minimal);
}, 240_000);
