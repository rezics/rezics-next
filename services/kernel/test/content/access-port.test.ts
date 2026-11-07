import { expect, test } from 'bun:test';
import { bindContentAccess, contentAccess, within, type ContentAccessPort } from '../../src/content/access-port.ts';
import {
  GrantDeniedError,
  ResourceAccessWriteDeniedError,
  DurableInitiatorUnavailableError,
  ApprovalIdentityDeniedError,
  PlatformClosedError,
} from '../../src/access/contract/index.ts';
import { GrantDeniedError as CompatibilityGrantDeniedError } from '../../src/access/grant-commands.ts';
import { DurableInitiatorUnavailableError as CompatibilityDurableError } from '../../src/access/durable-initiator.ts';
import { ApprovalIdentityDeniedError as CompatibilityApprovalError } from '../../src/access/approved-identity.ts';
import { PlatformClosedError as CompatibilityClosedError } from '../../src/access/gates/admission.ts';

test('Content Access forwarding retains generic values, budgets, errors and current composition', async () => {
  const previous = contentAccess();
  const result = { state: 'ready' as const, rows: [1, 2] };
  const denied = new GrantDeniedError();
  const calls: number[] = [];
  const first: ContentAccessPort = {
    ...previous,
    within: async (deadline, read) => {
      calls.push(deadline);
      return read();
    },
  };
  try {
    bindContentAccess(first);
    // The forwarding function preserves the native generic return type and object identity.
    const observed: typeof result = await within(123, async () => result);
    expect(observed).toBe(result);
    expect(calls).toEqual([123]);
    const failed = Promise.reject(denied);
    await expect(within(456, () => failed)).rejects.toBe(denied);
    const secondFailure = new Error('replacement producer');
    bindContentAccess({
      ...first,
      within() {
        throw secondFailure;
      },
    });
    expect(() => within(789, async () => result)).toThrow(secondFailure);
  } finally {
    bindContentAccess(previous);
  }
});

test('Content and native Access retain the same refusal identities and inheritance', () => {
  expect(GrantDeniedError).toBe(CompatibilityGrantDeniedError);
  expect(DurableInitiatorUnavailableError).toBe(CompatibilityDurableError);
  expect(ApprovalIdentityDeniedError).toBe(CompatibilityApprovalError);
  expect(PlatformClosedError).toBe(CompatibilityClosedError);
  expect(new GrantDeniedError()).toBeInstanceOf(ResourceAccessWriteDeniedError);
});
