import { expect, test } from 'bun:test';
import { provisionedAgent } from '../support/provisioned-agent.ts';

const agent = 'https://rezics.com/id/0b1f6f0e-6f0f-4d0e-9a52-0a4c2b7a9f11';

function api(statuses: number[]) {
  const calls: { path: string; body: unknown; key: string }[] = [];
  const main = async (_method: 'POST', path: string, body: unknown, key: string) => {
    calls.push({ path, body, key });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return Response.json(status >= 400 ? { code: 'agent_provision_compensated' }
      : { profile: 'agent-provision-v1', agent, state: status === 202 ? 'pending' : 'active' }, { status });
  };
  return { main, calls };
}

test('a created Agent is returned from the first answer', async () => {
  const { main, calls } = api([201]);
  expect(await provisionedAgent(main, 'Outcome owner', { sleep: async () => {} })).toBe(agent);
  expect(calls).toEqual([{ path: '/v1/agents', key: calls[0]!.key,
    body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Outcome owner' } }]);
});

test('a pending provision is read to its end with the same idempotency key', async () => {
  const { main, calls } = api([202, 202, 200]);
  const waits: number[] = [];
  expect(await provisionedAgent(main, 'Outcome member', { sleep: async ms => { waits.push(ms); } })).toBe(agent);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map(call => call.key)).size).toBe(1);
  expect(waits).toEqual([1000, 1000]);
});

test('a first answer of 200 is another caller’s Agent, not this setup’s', async () => {
  const { main } = api([200]);
  await expect(provisionedAgent(main, 'Outcome owner', { sleep: async () => {} }))
    .rejects.toThrow('Persona setup expected HTTP 201, got 200');
});

test('a refusal and a provision that never ends fail the setup', async () => {
  const refused = api([202, 409]);
  await expect(provisionedAgent(refused.main, 'Outcome owner', { sleep: async () => {} }))
    .rejects.toThrow('Persona setup expected HTTP 201, got 409 after 1 replays');
  const stuck = api([202]);
  await expect(provisionedAgent(stuck.main, 'Outcome owner', { replays: 3, sleep: async () => {} }))
    .rejects.toThrow('got 202 after 3 replays');
  expect(stuck.calls).toHaveLength(4);
});
