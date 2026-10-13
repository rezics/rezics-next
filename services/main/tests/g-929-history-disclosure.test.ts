import { expect, test } from 'bun:test';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { readWikiHistory } from '../src/modules/wiki/history-read.ts';
import { WorkReadMissing } from '../src/modules/work/read-session.ts';
import {
  configureDisclosure,
  DisclosureUnavailable,
  type DisclosureDecision,
} from '../src/modules/disclosure/read.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const term = (value: string) => ({ type: 'literal', value });
const principal = { issuer: 'account', subject: 'unknown-age-reader' };

function fixture() {
  let receiptReads = 0,
    quotationReads = 0;
  let decision: DisclosureDecision = 'visible';
  let outage = false;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async (query) => ({
    results: {
      bindings: (query.includes('SELECT ?work ?main ?structuredDecision') || query.includes('SELECT ?structuredDecision')) ? []
        : query.includes('SELECT ?resource ?head') ? [{ resource: term(work), head: term(work) }]
        : query.includes('SELECT ?epoch ?sequence')
        ? [{ epoch: term('epoch'), sequence: term('1') }]
        : query.includes('SELECT ?main ?public')
          ? [{ main: term(work), public: term('true') }]
          : [{ work: term(work), head: term(work) }],
    },
  });
  const environment = {
    fuseki: graph,
    objectDirectory: '.temp/g-929',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
  };
  configureFixtureDisclosureAncestry(environment, target => target.work ? { resource: work, head: work,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async (targets, viewer) => {
      expect(viewer.signedIn).toBe(true);
      expect(viewer.age).toBe('unknown');
      expect(viewer.optIns).toEqual({ general: true, r15: false, sexual: false, grotesque: false });
      if (outage) throw new DisclosureUnavailable('Assessment unavailable');
      return targets.map(() => decision);
    }));
  const deps = {
    environment,
    access: { assertRecoveryOpen: async () => undefined, activePrincipalId: async () => actor, canReadWork: async () => true },
    editorialReview: {
      appliedReceipts: async () => {
        receiptReads++;
        return { receipts: [], through: null, nextCursor: null };
      },
    },
    wikiEvidence: {
      withheld: async () => {
        quotationReads++;
        return new Set<string>();
      },
    },
  } as unknown as MainWorkDependencies;
  return {
    deps,
    hide: () => {
      decision = 'tombstone';
    },
    fail: () => {
      outage = true;
    },
    counts: () => ({ receiptReads, quotationReads }),
  };
}

test('G929: withheld and unavailable Work admission precedes journal/quotation hydration', async () => {
  for (const failure of ['withheld', 'outage'] as const) {
    const f = fixture();
    if (failure === 'withheld') f.hide();
    else f.fail();
    for (const scope of [{}, { entity: actor }, { section: 'characters' as const }])
      await expect(
        readWikiHistory(f.deps, principal, actor, work, undefined, undefined, scope, {
          limit: 1,
          cursor: 'untrusted-cursor',
        }),
      ).rejects.toBeInstanceOf(failure === 'withheld' ? WorkReadMissing : DisclosureUnavailable);
    expect(f.counts()).toEqual({ receiptReads: 0, quotationReads: 0 });
  }
});

test('G929: an admitted empty wiki preserves its journal control and live fence', async () => {
  const f = fixture();
  const result = await readWikiHistory(f.deps, principal, actor, work);
  expect(result).toMatchObject({
    work,
    claims: [],
    entities: [],
    units: [],
    nextCursor: null,
    sourcePosition: { dataEpoch: 'epoch', sequence: '0' },
  });
  expect(f.counts()).toEqual({ receiptReads: 2, quotationReads: 2 });
  f.hide();
  await expect(
    readWikiHistory(f.deps, principal, actor, work, result.revisions),
  ).rejects.toBeInstanceOf(WorkReadMissing);
  expect(f.counts()).toEqual({ receiptReads: 2, quotationReads: 2 });
});
