import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandRejected, type CommandEnvelope, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ensureGlobalClassificationContext, globalClassificationTerminal,
  GLOBAL_CLASSIFICATION_BOOTSTRAP_COST } from '../src/modules/classification/global.ts';
import { outboxEventHandlers } from '../src/modules/classification/outbox-event.ts';
import { PendingActivation, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('G-380: bootstrap resolves a lost response and does not cache existence across reset', async () => {
  const objectDirectory = resolve('.temp', `classification-${Bun.randomUUIDv7()}`);
  const commands: CommandEnvelope[] = [];
  let present = false, reads = 0;
  const env = { objectDirectory, lineage: { dataEpoch: 'first', routingEpoch: 'route' }, fuseki: {
    query: async () => { reads++; return { boolean: present }; },
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([name, profile]) => [name, profile.sha256])) }),
    commandWithReceipt: async (command: CommandEnvelope) => {
      commands.push(command); present = true; throw new Error('lost response');
    },
  } } as unknown as WorkActivationEnvironment;
  try {
    await ensureGlobalClassificationContext(env);
    expect(commands).toHaveLength(1);
    expect(reads).toBe(GLOBAL_CLASSIFICATION_BOOTSTRAP_COST.graphReads);
    expect(commands[0]!.validations).toHaveLength(GLOBAL_CLASSIFICATION_BOOTSTRAP_COST.validations);
    await ensureGlobalClassificationContext(env);
    expect(commands).toHaveLength(1);
    present = false; env.lineage = { dataEpoch: 'reset', routingEpoch: 'next-route' };
    await ensureGlobalClassificationContext(env);
    expect(commands).toHaveLength(2);
    expect(commands[1]!.receipt).not.toBe(commands[0]!.receipt);
  } finally { rmSync(objectDirectory, { recursive: true, force: true }); }
});

test('G-380: failed bootstrap stays pending; rejected validation is preserved', async () => {
  const objectDirectory = resolve('.temp', `classification-${Bun.randomUUIDv7()}`);
  const env = { objectDirectory, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' }, fuseki: {
    query: async () => ({ boolean: false }),
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([name, profile]) => [name, profile.sha256])) }),
    commandWithReceipt: async () => ({ status: 'guard-unmatched' }),
  } } as unknown as WorkActivationEnvironment;
  try {
    await expect(ensureGlobalClassificationContext(env)).rejects.toBeInstanceOf(PendingActivation);
    env.fuseki.commandWithReceipt = async () => ({ status: 'invalid' });
    await expect(ensureGlobalClassificationContext(env)).rejects.toBeInstanceOf(CommandRejected);
  } finally { rmSync(objectDirectory, { recursive: true, force: true }); }
});

test('G-380: relay requires the exact system terminal and retained bootstrap revision', async () => {
  const terminal = globalClassificationTerminal('epoch');
  const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`, operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  const values: Record<string, string> = { receipt: terminal.receipt, digest: terminal.digest,
    action: 'classification.global.bootstrap', outcome: `${RV}Succeeded`, epoch: 'epoch', sequence: '1', operation };
  const batch = { batchId: terminal.batch, dataEpoch: 'epoch', sequence: '1', routingEpoch: 'route', eventIds: [terminal.event] };
  let rows = [{ revision: { type: 'uri', value: revision }, operation: { type: 'uri', value: operation },
    manifest: { type: 'uri', value: `urn:rezics:sha256:${'a'.repeat(64)}` } }];
  const fuseki = { query: async () => ({ results: { bindings: rows } }) } as unknown as FusekiClient;
  const handler = outboxEventHandlers[0]!;
  const read = (overrides: Record<string, string | undefined> = {}) => handler.read({ fuseki, batch, eventId: terminal.event,
    ordinal: 0, value: name => ({ ...values, ...overrides })[name] });
  expect(handler.authority).toBe('system');
  expect((await read()).data.receipt).toMatchObject({ systemProof: { revision, operation } });
  for (const overrides of [{ admissionId: Bun.randomUUIDv7() }, { sequence: '2' }, { digest: 'b'.repeat(64) },
    { action: 'classification.proposition.define' }, { outcome: `${RV}Cancelled` }]) {
    await expect(read(overrides)).rejects.toThrow('system terminal');
  }
  rows = [];
  await expect(read()).rejects.toThrow('retained revision');
});
