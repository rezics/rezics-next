import { expect, test } from 'bun:test';
import { CommandOutcomeUnknown, CommandRejected, FusekiClient, type CommandEnvelope,
  type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { validatedCommand } from '../src/infrastructure/invalid-receipt.ts';
import { assertCommandProfiles, profileValidations } from '../src/infrastructure/profile.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';

const receipt = 'urn:rezics:receipt:test';
const envelope: CommandEnvelope = {
  receipt, digest: 'digest-a', update: 'INSERT DATA {}', validations: [], deadlineMs: 1_000,
};
const admission = { id: '00000000-0000-4000-8000-000000000001', authorityEpoch: '1', scope: 'work:create:root' };

function fixture(status: number, response: unknown, receiptDigest?: string) {
  const requests: { path: string; body: string }[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, body: await request.text() });
    if (url.pathname.endsWith('/command')) return Response.json(response, { status });
    if (url.pathname.endsWith('/query')) return Response.json({ results: { bindings: receiptDigest
      ? [{ digest: { type: 'literal', value: receiptDigest },
        dataset: { type: 'uri', value: 'urn:rezics:dataset:product' },
        epoch: { type: 'literal', value: 'epoch-a' },
        sequence: { type: 'literal', value: '7' } }] : [] } });
    return new Response('missing', { status: 404 });
  } });
  return { client: new FusekiClient(`http://localhost:${server.port}/rezics`),
    requests, stop: () => server.stop(true) };
}

test('SYS02/SYS10 command commits with declared validation envelope', async () => {
  const run = fixture(200, { status: 'committed', position: {
    datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '7',
  } });
  try {
    const result = await run.client.commandWithReceipt(envelope);
    expect(result.status).toBe('committed');
    expect(run.requests.map(request => request.path)).toEqual(['/rezics/command']);
    expect(JSON.parse(run.requests[0]!.body)).toEqual(envelope);
  } finally { run.stop(); }
});

test('SYS02/SYS14 lost response resolves only matching receipt', async () => {
  const run = fixture(503, {}, 'digest-a');
  try {
    expect(await run.client.commandWithReceipt(envelope)).toEqual({ status: 'committed',
      position: { datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '7' } });
    expect(run.requests.map(request => request.path)).toEqual(['/rezics/command', '/rezics/query']);
    expect(run.requests[1]!.body).toContain(`<${receipt}>`);
  } finally { run.stop(); }
});

test('SYS02 same receipt with different digest is conflict', async () => {
  const run = fixture(409, { status: 'guard-unmatched' }, 'digest-b');
  try { expect(await run.client.commandWithReceipt(envelope)).toEqual({ status: 'conflict' }); }
  finally { run.stop(); }
});

test('SYS02 uncertain response and absent receipt remains unknown', async () => {
  const run = fixture(503, {});
  try { await expect(run.client.commandWithReceipt(envelope)).rejects.toBeInstanceOf(CommandOutcomeUnknown); }
  finally { run.stop(); }
});

test('SYS02 invalid command does not infer success from receipt', async () => {
  const run = fixture(422, { status: 'invalid', report: { conforms: false } });
  try {
    expect((await run.client.commandWithReceipt(envelope)).status).toBe('invalid');
    expect(run.requests.map(request => request.path)).toEqual(['/rezics/command']);
  } finally { run.stop(); }
});

test('SYS02 guard-unmatched and absent receipt remains a failed guard', async () => {
  const run = fixture(200, { status: 'guard-unmatched' });
  try {
    expect(await run.client.commandWithReceipt(envelope)).toEqual({ status: 'guard-unmatched' });
    expect(run.requests.map(request => request.path)).toEqual(['/rezics/command', '/rezics/query']);
  } finally { run.stop(); }
});

test('SYS02 deadline with absent receipt remains unknown', async () => {
  const run = fixture(200, { status: 'deadline' });
  try { await expect(run.client.commandWithReceipt(envelope)).rejects.toBeInstanceOf(CommandOutcomeUnknown); }
  finally { run.stop(); }
});

test('SYS02 startup and focus declarations are pinned to generated profiles', async () => {
  class ProfileClient extends FusekiClient {
    override async commandHealth() { return { moduleVersion: '0.5.10',
      instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, value]) => [id, value.sha256])) }; }
  }
  const client = new ProfileClient('http://localhost:1/rezics');
  await expect(assertCommandProfiles(client)).resolves.toBeUndefined();
  expect(await profileValidations(client, 'work-metadata-v1', [{
    shape: profileRegistry['work-metadata-v1'].shapes[0]!,
    focus: ['https://rezics.com/id/work'], graphs: ['urn:rezics:graph:current'],
  }])).toEqual([{ profile: 'work-metadata-v1',
    sha256: profileRegistry['work-metadata-v1'].sha256,
    shape: profileRegistry['work-metadata-v1'].shapes[0],
    focus: ['https://rezics.com/id/work'], graphs: ['urn:rezics:graph:current'] }]);
  await expect(profileValidations(client, 'work-metadata-v1', [{ shape: 'urn:untrusted:shape',
    focus: ['https://rezics.com/id/work'], graphs: ['urn:rezics:graph:current'],
  }])).rejects.toThrow('unreviewed shape');
});

test('SYS02 Main readiness accepts the pinned command module and rejects an older one', async () => {
  class ReadyFuseki extends FusekiClient {
    constructor(readonly version: string) { super('http://localhost:1/rezics'); }
    override async query(): Promise<SparqlResult> { return { boolean: true }; }
    override async commandHealth() { return { moduleVersion: this.version,
      instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, value]) => [id, value.sha256])) }; }
  }
  const work = { environment: { lineage: { dataEpoch: 'epoch-a', routingEpoch: 'routing-a' } } } as unknown as MainWorkDependencies;
  const ready = await createMainApp(new ReadyFuseki('0.5.10'), work)
    .handle(new Request('http://localhost/health/ready'));
  expect(ready.status).toBe(200);
  const old = await createMainApp(new ReadyFuseki('0.3.0'), work)
    .handle(new Request('http://localhost/health/ready'));
  expect(old.status).toBe(503);
});

test('SYS02 invalid finalization loses a receipt race to the original success', async () => {
  class RacingClient extends FusekiClient {
    commands: CommandEnvelope[] = [];
    constructor() { super('http://localhost:1/rezics'); }
    override async commandWithReceipt(value: CommandEnvelope): Promise<CommandResult> {
      this.commands.push(value);
      if (this.commands.length === 1) return { status: 'invalid' };
      return { status: 'committed', position: {
        datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '7',
      } };
    }
    override async query(): Promise<SparqlResult> { return { results: { bindings: [{
      digest: { type: 'literal', value: 'digest-a' },
      outcome: { type: 'uri', value: 'https://rezics.com/vocab/Succeeded' },
    }] } }; }
  }
  const fuseki = new RacingClient();
  const result = await validatedCommand({ fuseki, lineage: { dataEpoch: 'epoch-a', routingEpoch: '1' } }, envelope, admission);
  expect(result.status).toBe('committed');
  expect(fuseki.commands).toHaveLength(3);
  expect(fuseki.commands[1]!.validations).toEqual([]);
  expect(fuseki.commands[1]!.receipt).toBe(envelope.receipt);
  expect(fuseki.commands[1]!.digest).toBe(envelope.digest);
  expect(fuseki.commands[1]!.update).toContain('rv:rejectionKind rv:InvalidProfile');
  expect(fuseki.commands[1]!.update).toContain('rv:admissionId "00000000-0000-4000-8000-000000000001"');
  expect(fuseki.commands[1]!.update).toContain('rv:authorityEpoch "1"');
  expect(fuseki.commands[1]!.update).toContain('rv:admittedScope "work:create:root"');
});

test('SYS02 invalid finalization detects a conflicting receipt digest', async () => {
  class ConflictClient extends FusekiClient {
    constructor() { super('http://localhost:1/rezics'); }
    override async commandWithReceipt(value: CommandEnvelope): Promise<CommandResult> {
      return value.validations.length ? { status: 'invalid' } : { status: 'conflict' };
    }
    override async query(): Promise<SparqlResult> { return { results: { bindings: [{
      digest: { type: 'literal', value: 'different-digest' },
      outcome: { type: 'uri', value: 'https://rezics.com/vocab/Succeeded' },
    }] } }; }
  }
  const fuseki = new ConflictClient();
  await expect(validatedCommand({ fuseki, lineage: { dataEpoch: 'epoch-a', routingEpoch: '1' } },
    { ...envelope, validations: [{ profile: 'work-metadata-v1', sha256: 'a',
      shape: 'urn:shape', focus: ['urn:focus'], graphs: ['urn:graph'] }] }, admission))
    .rejects.toBeInstanceOf(CommandRejected);
});
