import { expect, test } from 'bun:test';
import {
  createSearchDisclosureApplication,
  createSearchIndexRequest,
  finishDiscoveryDisclosure,
  prepareConceptDisclosure,
  runSearchSource,
  type ConceptDiscoveryPorts,
} from '../../src/search/disclosure-application.ts';
import type {
  ConceptBrowseBinding,
  ConceptBrowseObservation,
  ConceptBrowseStore,
} from '../../src/search/concept-browse.ts';
import { SearchOperationError, recoverSearchOperands } from '../../src/search/operation-outcomes.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import { OwnerCurrentRestartRequired } from '../../src/search/discovery-errors.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
import { searchHttpExecute } from '../../src/search/http/search.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';
import { releasedMultilingualSubject } from './support/released-names.ts';
import { parseText } from '../../src/search/text.ts';

const selection = { property: 'schema:genre', concept: 'root', scheme: 'scheme', includeChildren: true as const };
const binding: ConceptBrowseBinding = {
  release: 'release',
  graph: 'graph',
  scheme: selection.scheme,
  membership: 'membership',
  principal: 'reader',
  request: 'request',
};
const input = {
  principal: 'reader',
  request: { text: 'lantern' },
  filter: {
    statement: { property: selection.property, in: [selection.concept], concept: { scheme: selection.scheme } },
  },
  limit: 1,
  countCandidateLimit: 0,
  now: () => 10,
};
function conceptPorts(
  observation: ConceptBrowseObservation,
  retained: 'complete' | 'building' | 'retired' = 'complete',
) {
  const charges: unknown[] = [];
  const store: ConceptBrowseStore = {
    create: async () => ({ id: 'retained', revision: '1' }),
    read: async () => (retained === 'building' ? { status: retained, next: null } : { status: retained }),
    contains: async () => true,
    advance: async () => null,
    seal: async () => null,
    retire: async () => {},
  };
  const ports: ConceptDiscoveryPorts = {
    browse: () => ({
      observe: async () => observation,
      children: async () => {
        throw new Error('unused');
      },
    }),
    store: (id, options) => {
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(options.expiresAt).toBe(10 + 24 * 60 * 60 * 1000);
      options.reserve({ statements: 1, rows: 1, bytes: 1 });
      charges.push('store');
      return store;
    },
    readStatements: async (_partition, _request, _after, limit) => {
      charges.push(limit);
      return { status: 'unavailable' };
    },
  };
  return { ports, charges };
}

test('concept preparation retains native refusals until the HTTP route constructs its problem', async () => {
  for (const [status, code] of [
    ['preparing', 'index_not_ready'],
    ['unavailable', 'dependency_unavailable'],
    ['rejected', 'invalid_request'],
  ] as const) {
    const { ports } = conceptPorts({ status });
    const native = await prepareConceptDisclosure(input, ports).catch((error: unknown) => error);
    expect(native).toBeInstanceOf(SearchOperationError);
    expect(native).not.toBeInstanceOf(ProblemError);
    expect(native).toMatchObject({ code });
    await expect(
      searchHttpExecute(input.request, async () => {
        throw native;
      }),
    ).rejects.toMatchObject({
      code,
      ...(status === 'preparing' ? { headers: { 'retry-after': '1' } } : {}),
      ...(status === 'rejected' ? { errors: [{ pointer: '/filter', code: 'invalid_format' }] } : {}),
    });
  }
  for (const [retained, code] of [
    ['building', 'index_not_ready'],
    ['retired', 'search_restart_required'],
  ] as const) {
    const { ports } = conceptPorts({ status: 'current', binding }, retained);
    await expect(prepareConceptDisclosure(input, ports)).rejects.toMatchObject({ code });
  }
});

test('one retained concept cut serves duplicate selections and charges the existing statement replay reservation', async () => {
  const { ports, charges } = conceptPorts({ status: 'current', binding });
  const prepared = await prepareConceptDisclosure({ ...input, filter: { or: [input.filter, input.filter] } }, ports);
  expect(charges).toEqual(['store']);
  expect(prepared?.resolveCut({ subject: 'subject', selection })?.state.binding).toEqual(binding);
  expect(await prepared?.reader(0, { subject: 'subject', selection }, null, 64)).toEqual({ status: 'unavailable' });
  expect(charges).toEqual(['store', 64]);
  // A second read cannot hide an overrun behind a fresh per-call allowance.
  await expect(prepared!.reader(0, { subject: 'subject', selection }, null, 1_000_000)).rejects.toBeInstanceOf(
    SearchUnavailableError,
  );
  expect(charges).toEqual(['store', 64]);
});

test('current text uses the bound physical analyzer and an invocation-local analysis cache', async () => {
  const calls: string[] = [];
  const application = createSearchDisclosureApplication({
    analyze: async (index, analyzer, text) => {
      calls.push(`${index}:${analyzer}:${text}`);
      return [{ token: text.toLowerCase(), position: 0, startOffset: 0, endOffset: text.length }];
    },
  });
  const subject = releasedMultilingualSubject();
  const matcher = application.currentText('physical-7');
  const query = parseText('"Steins;Gate"');
  expect(await matcher.matchesText(subject, query)).toBe(true);
  const before = calls.length;
  await matcher.matchesText(subject, query);
  expect(calls.length).toBe(before);
  expect(calls.every((call) => call.startsWith('physical-7:'))).toBe(true);
  await application.currentText('physical-8').matchesText(subject, query);
  expect(calls.some((call) => call.startsWith('physical-8:'))).toBe(true);
});

test('projection and CURRENT final complete before a page can escape, including a useful continuation', async () => {
  const events: string[] = [];
  const page: DiscoveryPage = {
    hits: [],
    kinds: { values: [], next: null },
    next: 'useful-page-continuation',
    as_of: '2026-11-07T00:00:00Z',
  };
  const result = await finishDiscoveryDisclosure(
    {
      finish: async () => {
        events.push('final');
      },
    },
    async () => {
      events.push('project');
      return page;
    },
  );
  expect(result).toBe(page);
  expect(events).toEqual(['project', 'final']);
  await expect(
    finishDiscoveryDisclosure(
      {
        finish: async () => {
          throw new OwnerCurrentRestartRequired();
        },
      },
      async () => page,
    ),
  ).rejects.toBeInstanceOf(OwnerCurrentRestartRequired);
});

test('source recovery and failed template installation retain native preparation and retry the admitted operation', async () => {
  const unavailable = new SearchUnavailableError('missing current evidence');
  await expect(
    runSearchSource(
      async () => {
        throw unavailable;
      },
      () => false,
    ),
  ).rejects.toMatchObject({ code: 'index_not_ready' });
  await expect(
    runSearchSource(
      async () => {
        throw new Error('source read failed');
      },
      () => false,
    ),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  const preserved = new ProblemError('deadline_exceeded');
  await expect(
    runSearchSource(
      async () => {
        throw preserved;
      },
      (error) => error === preserved,
    ),
  ).rejects.toBe(preserved);
  let installs = 0;
  let reads = 0;
  const read = createSearchIndexRequest({
    install: async () => {
      if (++installs === 1) throw unavailable;
    },
    unavailable: () => false,
  });
  await expect(read(async () => ++reads)).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(reads).toBe(0);
  expect(await read(async () => ++reads)).toBe(1);
  expect(await read(async () => ++reads)).toBe(2);
  expect(installs).toBe(2);
  expect(recoverSearchOperands({ family: 'source-not-ready', authoredBytes: 5000 })).toEqual({
    family: 'source-not-ready',
    reusableRequest: true,
  });
});
