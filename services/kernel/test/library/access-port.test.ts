import { expect, test } from 'bun:test';
import { composeLibraryDomain, composeLibraryPresentation } from '../../src/composition/library.ts';
import {
  bindLibraryAccess,
  bindLibraryDomain,
  peekLibraryDomain,
  requireLibraryAccess,
  unbindLibraryDomain,
} from '../../src/library/domain-binding.ts';
import { readAccount, within } from '../../src/library/access-port.ts';
import { createLibraryAccessPorts } from '../../src/access/adapters/library.ts';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  GrantDeniedError,
  LifecycleDeniedError,
  LiveCopyPendingError,
  PlatformClosedError,
} from '../../src/access/contract/errors.ts';
import { ERASURE_PARTICIPANTS } from '../../src/access/contract/erasure.ts';
import { GrantDeniedError as CommandGrantDeniedError } from '../../src/access/grant-commands.ts';
import { GrantDeniedError as ResourceGrantDeniedError } from '../../src/access/resource-access-errors.ts';
import { LifecycleDeniedError as CommandLifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { PlatformClosedError as AdmissionPlatformClosedError } from '../../src/access/gates/admission.ts';
import {
  AccessUnavailableError as NativeAccessUnavailableError,
  CommandUnavailableError as NativeCommandUnavailableError,
} from '../../src/access/unavailable.ts';
import { LiveCopyPendingError as NativeLiveCopyPendingError } from '../../src/access/live-copy.ts';
import { ERASURE_PARTICIPANTS as NativeErasureParticipants } from '../../src/access/erasure.ts';

test('presentation and full Library composition install the same native Access behaviours', () => {
  const previous = peekLibraryDomain();
  const native = createLibraryAccessPorts();
  try {
    composeLibraryPresentation();
    expect(requireLibraryAccess()).toEqual(native);
    composeLibraryDomain();
    expect(requireLibraryAccess()).toEqual(native);
  } finally {
    if (previous) bindLibraryDomain(previous);
    else unbindLibraryDomain();
  }
});

test('Library forwards exact account inputs, result identity and generic deadline results', async () => {
  const previous = requireLibraryAccess();
  const client: Parameters<typeof readAccount>[0] = {
    query() {
      throw new Error('Unexpected native account query');
    },
  };
  const result: Awaited<ReturnType<typeof readAccount>> = null;
  const deadline = Date.now() + 10_000;
  const calls: unknown[][] = [];
  bindLibraryAccess({
    ...previous,
    async readAccount(...args) {
      calls.push(args);
      return result;
    },
    within(at, work) {
      expect(at).toBe(deadline);
      return work();
    },
  });
  try {
    expect(await readAccount(client, 7, 'account')).toBe(result);
    expect(calls).toEqual([[client, 7, 'account']]);
    const value = { state: 'active' as const };
    expect(await within(deadline, async () => value)).toBe(value);
    const refusal = new GrantDeniedError();
    bindLibraryAccess({ ...requireLibraryAccess(), readAccount: () => Promise.reject(refusal) });
    expect(await readAccount(client, 7, 'account').catch((error: unknown) => error)).toBe(refusal);
  } finally {
    bindLibraryAccess(previous);
  }
});

test('Access compatibility exports retain the shared refusal constructor identities', () => {
  expect(CommandGrantDeniedError).toBe(GrantDeniedError);
  expect(ResourceGrantDeniedError).toBe(GrantDeniedError);
  expect(CommandLifecycleDeniedError).toBe(LifecycleDeniedError);
  expect(AdmissionPlatformClosedError).toBe(PlatformClosedError);
  expect(NativeAccessUnavailableError).toBe(AccessUnavailableError);
  expect(NativeCommandUnavailableError).toBe(CommandUnavailableError);
  expect(NativeLiveCopyPendingError).toBe(LiveCopyPendingError);
  expect(NativeErasureParticipants).toBe(ERASURE_PARTICIPANTS);
});
