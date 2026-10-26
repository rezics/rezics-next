import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createNativeCredentialEffectDriver } from './credential-effect-outcome-driver.ts';

let driver: Awaited<ReturnType<typeof createNativeCredentialEffectDriver>>;
beforeAll(async () => {
  driver = await createNativeCredentialEffectDriver();
});
afterAll(async () => driver?.close());

for (const mode of ['human-operator', 'own-human'] as const) {
  test(`${mode} credential approval survives the evidence read window`, async () => {
    const fixture = await driver.seed(mode);
    const operation = await driver.stage(fixture.caller, {
      key: randomUUID(),
      subjectId: fixture.subjectId,
      credential: fixture.newKey,
    });
    expect(operation.response.status).toBe(200);
    const approval = await driver.approve(fixture.caller, operation.value!);
    expect(approval.response.status).toBe(200);
    const binding = await driver.binding(approval.value!.reference);
    expect(Date.parse(binding.expiresAt) - Date.parse(binding.createdAt)).toBe(60_000);
    driver.advanceClock(3000);
    const applied = await driver.apply(fixture.caller, approval.value!.reference, operation.value!);
    expect(applied.response.status).toBe(200);
    expect(applied.value?.replayed).toBe(false);
    expect((await driver.inspect(fixture)).keyIds).toContain(fixture.newKey.kid);
  }, 30_000);

  test(`${mode} credential approval expires at created T plus sixty seconds`, async () => {
    const fixture = await driver.seed(mode);
    const operation = await driver.stage(fixture.caller, {
      key: randomUUID(),
      subjectId: fixture.subjectId,
      credential: fixture.newKey,
    });
    expect(operation.response.status).toBe(200);
    const approval = await driver.approve(fixture.caller, operation.value!);
    expect(approval.response.status).toBe(200);
    const binding = await driver.binding(approval.value!.reference);
    expect(Date.parse(binding.expiresAt) - Date.parse(binding.createdAt)).toBe(60_000);
    const before = await driver.inspect(fixture);
    await driver.awaitExpiry(approval.value!.reference);
    const refused = await driver.apply(fixture.caller, approval.value!.reference, operation.value!);
    expect(refused.response.status).toBe(403);
    expect(await refused.response.json()).toMatchObject({ effect_status: 'not_applied' });
    expect(await driver.inspect(fixture)).toEqual(before);
  }, 90_000);
}
