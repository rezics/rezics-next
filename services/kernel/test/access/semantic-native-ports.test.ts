import { expect, test } from 'bun:test';
import { createNativeAccessPorts } from '../../src/access/adapters/native.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';

test('native Access identity ports bind mapping, original recovery, read snapshots and Source maintenance', () => {
  const ports = createNativeAccessPorts(async () => undefined);
  const accountId = '11111111-1111-4111-8111-111111111111';
  expect(ports.identity.accountAgentId(accountId)).toBe(accountAgentId(accountId));
  expect(typeof ports.identity.readOriginalAccountAgentIdentity).toBe('function');
  expect(typeof ports.identity.verifyOriginalAccountAgentIdentity).toBe('function');
  expect(typeof ports.identity.withReadTransaction).toBe('function');
  expect(typeof ports.identity.activeIdentitySourceConsumerMaintenance).toBe('function');
});
