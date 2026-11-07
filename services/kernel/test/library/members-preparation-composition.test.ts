import { expect, test } from 'bun:test';
import { composeLibraryDomain } from '../../src/composition/library.ts';
import {
  bindLibraryDomain,
  peekLibraryDomain,
  requireLibraryDomain,
  unbindLibraryDomain,
} from '../../src/library/domain-binding.ts';
import type { NativePreparationPrefixRequest } from '../../src/library/adapters/index.ts';
import type { WorkContext } from '../../src/work/registry.ts';
import { MEMBERS_PREPARATION_SOURCE_PATHS } from '../../src/search/scope-members-source-declaration.ts';
import { MEMBERS_SELECTED_CHILDREN } from '../../src/library/members-preparation-work.ts';
import { MEMBERS_PREPARATION_SOURCE_DECLARATION } from '../../src/library/members-preparation-source-declaration.ts';
import { createMembersPreparationApplication } from '../../src/library/application/members-preparation.ts';

test('default composition supplies native Source admission and an unconfigured Search worker cannot publish an empty prefix', async () => {
  const previous = peekLibraryDomain();
  try {
    composeLibraryDomain();
    const domain = requireLibraryDomain();
    expect(domain.scopeWork).toBeDefined();
    expect(domain.preparationWork).toBeDefined();
    expect(domain.membersPreparation?.native.bind).toBeFunction();
    expect(domain.membersPreparation?.native.readClosure).toBeFunction();
    expect(domain.membersPreparation?.native.evaluate).toBeFunction();
    expect(domain.membersPreparation?.reservation.reserve).toBeFunction();
    expect(domain.membersPreparation?.createPlan).toBeFunction();
    expect(domain.membersPreparation?.readPreparedMembers).toBeFunction();
    expect(domain.membersPreparation?.checkCompletion).toBeFunction();
    // This worker has no registered Search runtime. The producer must refuse before reading the native frame.
    const source = domain.preparationWork!({} as WorkContext);
    expect(await source.prefix({} as NativePreparationPrefixRequest)).toBeNull();
    const declaration = MEMBERS_PREPARATION_SOURCE_DECLARATION();
    expect(declaration.status).toBe('complete');
    expect(MEMBERS_PREPARATION_SOURCE_PATHS()).toBe(declaration.paths);
    expect(MEMBERS_SELECTED_CHILDREN().source).toEqual(declaration.cost);
    expect(declaration.axes).toContain('engineRequests');
    expect(declaration.cost.engineRequests).toBe(0);
  } finally {
    if (previous) bindLibraryDomain(previous);
    else unbindLibraryDomain();
  }
});

test('member preparation application passes one native and reservation instance to every operation', () => {
  const native = Object.freeze({ name: 'native' });
  const reservation = Object.freeze({ name: 'reservation' });
  type Supplied = readonly [typeof native, typeof reservation];
  const construct = (
    _dependencies: undefined,
    suppliedNative: typeof native,
    suppliedReservation: typeof reservation,
  ): Supplied => [suppliedNative, suppliedReservation];
  const application = createMembersPreparationApplication({
    native,
    reservation,
    createPreparation: construct,
    createPlan: construct,
    createReader: construct,
  });
  const expected: Supplied = [native, reservation];
  expect(application.createPreparation(undefined)).toEqual(expected);
  expect(application.createPlan(undefined)).toEqual(expected);
  expect(application.createReader(undefined)).toEqual(expected);
});
