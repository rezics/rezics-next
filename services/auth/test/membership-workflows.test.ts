import { expect, spyOn, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { testDatabase } from '../scripts/database.ts';
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

test('a failing step logs its original cause and workflow ID while DBOS stores only the step failure', async () => {
  const { input } = await fixture();
  const database = testDatabase();
  const original = new Error('private SQL failure with secret-reference-7c93');
  const workflowId = 'membership-step-error';
  const run = registerMembershipWorkflows({
    async authorize() {
      return {};
    },
    actorAccountId: () => 'actor',
    async reserve() {
      return { value: { accountId: 'member', principal: input.principal, reservationId: 'reservation' } };
    },
    async publish() {
      throw original;
    },
    async terminalize() {},
    async release() {},
  });
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    DBOS.setConfig({
      name: 'membership-step-errors',
      systemDatabaseUrl: database.url,
      // Keep the SDK's own workflow failure log separate from the step diagnostic.
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    await DBOS.launch();
    const handle = await DBOS.startWorkflow(run, { workflowID: workflowId })(input);
    const thrown = await handle.getResult().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Membership workflow step failed: publish');
    expect((thrown as Error).cause).toBeUndefined();
    expect((thrown as Error).stack).not.toContain(original.message);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    const logged = log.mock.calls[0]![0] as Error;
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toBe(`Membership workflow step failed: publish (workflow ${workflowId})`);
    expect(logged.cause).toBe(original);
    const steps = await DBOS.listWorkflowSteps(workflowId);
    const stored = steps?.find((step) => step.name === 'accounts.membership.publish')?.error;
    expect(stored).toBeInstanceOf(Error);
    expect(stored!.message).toBe('Membership workflow step failed: publish');
    expect(stored!.cause).toBeUndefined();
    expect(stored!.stack).not.toContain(original.message);
    expect(JSON.stringify(steps)).not.toContain(original.message);
  } finally {
    log.mockRestore();
    await DBOS.shutdown({ deregister: true });
    database.close();
  }
}, 30000);
