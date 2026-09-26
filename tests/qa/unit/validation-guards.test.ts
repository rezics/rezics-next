import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION, profileValidations } from '../../../services/main/src/infrastructure/profile.ts';

const profile = 'work-metadata-v1';
const pinned = profileRegistry[profile];
const work = 'https://rezics.com/id/validation-guard-work';
const graph = 'urn:rezics:graph:current';
const entry = { shape: pinned.shapes[0]!, focus: [work], graphs: [graph] };

class ProfileClient extends FusekiClient {
  calls = 0;
  constructor(readonly digest = pinned.sha256) {
    super('http://127.0.0.1:1/rezics');
  }
  override async commandHealth() {
    this.calls++;
    return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: { [profile]: this.digest } };
  }
}

test('MODEL17/MODEL27: Main requires a reviewed shape and a nonempty focus/graph set', async () => {
  const client = new ProfileClient();
  await expect(profileValidations(client, profile, [])).rejects.toThrow('validation entries are empty');
  expect(client.calls).toBe(0);
  await expect(profileValidations(client, profile, [{ ...entry, shape: 'urn:unsupported:shape' }]))
    .rejects.toThrow('unreviewed shape');
  await expect(profileValidations(client, profile, [{ ...entry, focus: [] }]))
    .rejects.toThrow('focus or graph is empty');
  await expect(profileValidations(client, profile, [{ ...entry, graphs: [] }]))
    .rejects.toThrow('focus or graph is empty');
  expect(client.calls).toBe(3);
});

test('MODEL17: changed shape digest cannot build an activation validation', async () => {
  await expect(profileValidations(new ProfileClient('stale-shape'), profile, [entry]))
    .rejects.toThrow('differs from reviewed artifact');
});

test('MODEL27: validation construction costs one health read plus O(entries)', async () => {
  for (const count of [1, 32]) {
    const client = new ProfileClient();
    const entries = Array.from({ length: count }, (_, index) => ({ ...entry,
      focus: [`${work}-${index}`] }));
    const checked = await profileValidations(client, profile, entries);
    expect(checked).toHaveLength(count);
    expect(client.calls).toBe(1);
    expect(checked.map(item => item.focus[0])).toEqual(entries.map(item => item.focus[0]));
  }
});

test('MODEL27: a deadline without an operation receipt remains unknown', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests.push(new URL(request.url).pathname);
    if (request.url.endsWith('/command')) return Response.json({ status: 'deadline' });
    return Response.json({ results: { bindings: [] } });
  } });
  try {
    const client = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    const command: CommandEnvelope = { receipt: 'urn:rezics:receipt:validation-deadline',
      digest: 'deadline-probe', update: 'INSERT DATA {}', validations: [], deadlineMs: 1_000 };
    await expect(client.commandWithReceipt(command)).rejects.toBeInstanceOf(CommandOutcomeUnknown);
    expect(requests).toEqual(['/rezics/command', '/rezics/query']);
  } finally { await server.stop(true); }
});

test('MODEL24: product assembler exposes only query and validated command ingress', () => {
  const root = resolve(import.meta.dir, '../../..');
  const product = readFileSync(resolve(root, 'infra/jena/fuseki-text.ttl'), 'utf8');
  const qa = readFileSync(resolve(root, 'infra/jena/fuseki-text-qa.ttl'), 'utf8');
  expect(product).toContain('fuseki:serviceQuery "query"');
  expect(product).toContain('fuseki:name "command"');
  expect(product).not.toMatch(/fuseki:serviceUpdate|fuseki:serviceReadWriteGraphStore|fuseki:serviceUpload/);
  expect(qa).toContain('fuseki:serviceUpdate "update"');
});
