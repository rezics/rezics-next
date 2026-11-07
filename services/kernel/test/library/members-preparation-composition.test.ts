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

test('default composition supplies native Source admission and an unconfigured Search worker cannot publish an empty prefix', async () => {
  const previous = peekLibraryDomain();
  try {
    composeLibraryDomain();
    const domain = requireLibraryDomain();
    expect(domain.scopeWork).toBeDefined();
    expect(domain.preparationWork).toBeDefined();
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
