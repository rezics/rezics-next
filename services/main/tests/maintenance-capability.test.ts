import { expect, test } from 'bun:test';
import { FusekiClient, type CommandEnvelope } from '../src/infrastructure/fuseki.ts';

test('SYS02: Main sends the maintenance capability only for reserved receipts', async () => {
  const seen: Array<{ receipt: string; authorization: string | null }> = [];
  const capability = 'a'.repeat(64);
  const admittedCapability = 'b'.repeat(64);
  const server = Bun.serve({ port: 0, fetch: async request => {
    if (!request.url.endsWith('/command')) throw new Error('unexpected receipt lookup');
    const envelope = await request.json() as CommandEnvelope;
    seen.push({ receipt: envelope.receipt, authorization: request.headers.get('authorization') });
    if (envelope.receipt.startsWith('urn:rezics:receipt:')
      && request.headers.get('authorization') !== `Bearer ${capability}`) {
      return Response.json({ status: 'forbidden' }, { status: 403 });
    }
    if (envelope.receipt === 'urn:rezics:admitted:test'
      && request.headers.get('authorization') !== `Bearer ${admittedCapability}`) {
      return Response.json({ status: 'forbidden' }, { status: 403 });
    }
    return Response.json({ status: 'committed', position: {
      datasetId: 'urn:rezics:dataset:product', dataEpoch: 'test', sequence: '0',
    } });
  } });
  const client = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`, capability, '');
  const envelope = (receipt: string): CommandEnvelope => ({ receipt, digest: 'digest',
    update: 'INSERT DATA {}', validations: [], deadlineMs: 1000 });
  try {
    await client.command(envelope('urn:rezics:ordinary:test'));
    for (const prefix of ['bootstrap', 'restore-cutover', 'restore-release', 'retained-zero']) {
      await client.command(envelope(`urn:rezics:receipt:${prefix}:test`));
    }
    expect(seen).toEqual([
      { receipt: 'urn:rezics:ordinary:test', authorization: null },
      ...['bootstrap', 'restore-cutover', 'restore-release', 'retained-zero'].map(prefix => ({
        receipt: `urn:rezics:receipt:${prefix}:test`, authorization: `Bearer ${capability}`,
      })),
    ]);
    await expect(new FusekiClient(`http://127.0.0.1:${server.port}/rezics`, '')
      .command(envelope('urn:rezics:receipt:bootstrap:missing')))
      .rejects.toThrow('maintenance capability is required');
    expect(seen).toHaveLength(5);
    await new FusekiClient(`http://127.0.0.1:${server.port}/rezics`, capability,
      admittedCapability).command(envelope('urn:rezics:admitted:test'));
    expect(seen[5]).toEqual({ receipt: 'urn:rezics:admitted:test',
      authorization: `Bearer ${admittedCapability}` });
    await expect(new FusekiClient(`http://127.0.0.1:${server.port}/rezics`, 'b'.repeat(64), '')
      .commandWithReceipt(envelope('urn:rezics:receipt:bootstrap:wrong')))
      .rejects.toThrow('command capability rejected');
    expect(seen).toHaveLength(7);
  } finally {
    await server.stop(true);
  }
});
