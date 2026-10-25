import { expect, spyOn, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  registerMembershipWorkflows,
  type MembershipWorkInput,
  type MembershipWorkflowPorts,
} from '../src/membership-workflows.ts';

async function fixture(leaving = false, fail = false) {
  const calls: string[] = [];
  const authorization = 'a'.repeat(300) + '.' + 'b'.repeat(43);
  const input: MembershipWorkInput = {
    kind: 'membership',
    principal: { kind: 'organization', id: 'organization' },
    memberAccountId: 'member',
    role: leaving ? null : 'member',
    ...(leaving ? { reservationId: 'reservation' } : {}),
    authorization,
  };
  const reservation = { accountId: 'member', principal: input.principal, reservationId: 'reservation' };
  const ports: MembershipWorkflowPorts<object> = {
    async authorize(reference, value) {
      expect(reference).toBe(authorization);
      expect(value).toEqual(input);
      calls.push('authorize');
      return {};
    },
    actorAccountId: () => 'actor',
    async reserve() {
      calls.push('reserve');
      return { value: reservation };
    },
    async publish() {
      calls.push('publish');
      if (fail) throw new Error('fail');
    },
    async terminalize() {
      calls.push('terminalize');
    },
    async release() {
      calls.push('release');
    },
  };
  const step = spyOn(DBOS, 'registerStep').mockImplementation(((fn: unknown) => fn) as never);
  const workflow = spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
  try {
    const run = registerMembershipWorkflows(ports);
    expect(step.mock.calls.every((call) => call[1]?.retriesAllowed === false)).toBe(true);
    expect(DBOS.isInitialized()).toBe(false);
    return { input, run, calls };
  } finally {
    step.mockRestore();
    workflow.mockRestore();
  }
}

test('sealed locators survive registered steps and each protected phase resolves original approval', async () => {
  const join = await fixture();
  await join.run(join.input);
  expect(join.calls).toEqual(['authorize', 'reserve', 'authorize', 'publish']);
  const leave = await fixture(true);
  await leave.run(leave.input);
  expect(leave.calls).toEqual(['authorize', 'authorize', 'publish', 'release']);
  const compensation = await fixture(false, true);
  await expect(compensation.run(compensation.input)).rejects.toThrow();
  expect(compensation.calls).toEqual(['authorize', 'reserve', 'authorize', 'publish', 'terminalize', 'release']);
});

test('registered steps reject bearer and raw contexts before resolving or effects', async () => {
  for (const authorization of [
    '',
    'a'.repeat(4097),
    'header.payload.signature',
    'Bearer secret',
    '{"actor":"forged"}',
    'has whitespace',
  ]) {
    const f = await fixture();
    await expect(f.run({ ...f.input, authorization })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});
