import { expect, test } from 'bun:test';
import type { ContentCore, ContentOutboxEvent, ProjectionPublication } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { type WorkActivationEnvironment, RV } from '../src/modules/work/activate.ts';

const contentEpoch = '11111111-1111-4111-8111-111111111111';
const graphEpoch = '22222222-2222-4222-8222-222222222222';
const admission = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revisionId = '33333333-3333-4333-8333-333333333333';
const zone = 'https://rezics.com/id/44444444-4444-4444-8444-444444444444';
const home = 'https://rezics.com/id/55555555-5555-4555-8555-555555555555';
const foreignZone = 'https://rezics.com/id/66666666-6666-4666-8666-666666666666';
const siteRevision = 'https://rezics.com/id/77777777-7777-4777-8777-777777777777';
const variant = 'urn:rezics:variant:88888888-8888-4888-8888-888888888888';
const otherRevisionId = '99999999-9999-4999-8999-999999999999';
const digest = 'a'.repeat(64);
const position = (sequence: string) => ({ owner: 'content' as const, dataEpoch: contentEpoch, sequence });
const cell = (value: string) => ({ value });

function fixture(status: ProjectionPublication['status'] = 'active', legacy = false) {
  const resource = legacy ? zone : home;
  const receipt = compositionReceiptIri(admission, 'zone.edit');
  const publication: ProjectionPublication = {
    preparationId: `content-site-pin:${admission}:${revisionId}`,
    preparationPosition: position('2'),
    reference: { owner: 'content', resourceId: resource, variantId: variant, revisionId,
      format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: digest, byteLength: 12,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', sourceRevision: null,
      predecessor: null, provenance: {} },
    status, graph: { outcome: status, revisionId, receipt, dataEpoch: graphEpoch, sequence: '7' },
  };
  const selected = { resource, variant, revision: revisionId, digest };
  const graph = { owners: legacy ? [] as string[] : [zone], zoneTypes: new Set([zone]),
    dataEpoch: graphEpoch, routingEpoch: '1', sequence: '7', held: false,
    pin: publication.preparationId, pinEpoch: contentEpoch, pinSequence: '2' };
  const terminal = { scope: `zone:edit:${zone}`, dataEpoch: graphEpoch, sequence: '7' };
  const queries: string[] = [];
  const counters = { bodies: 0, profiles: 0, mutations: 0, publications: 0 };
  const acknowledgements: Array<{ pending?: unknown }> = [];
  const event: ContentOutboxEvent = { id: 'home-terminal-3', position: position('3'),
    operationId: 'home-settle', eventType: `content.publication.${status}`, recipe: 'content-body-v1',
    revisionId, payload: {} };
  const content = { ownerPosition: async () => position('3'), readOutbox: async () => [event],
    readProjectionPublication: async () => { counters.publications++; return publication; },
    readPublicationErasureSupersession: async () => null,
    readExactBatch: async () => { counters.bodies++; throw new Error('home body was read for search'); },
  } as unknown as ContentCore;
  const cursor = { readScan: async () => position('2'), retries: async () => [],
    hasPendingTarget: async () => false,
    acknowledge: async (_consumer: string, _checkpoint: unknown, _next: unknown, pending?: unknown) => {
      acknowledgements.push({ pending });
    },
  } as unknown as ContentProjectionCursor;
  const env = { lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused',
    fuseki: { query: async (sparql: string) => {
      queries.push(sparql);
      if (sparql.includes('SearchGraphAnchor')) return { boolean: true };
      if (sparql.includes('ASK') && sparql.includes('rv:sitePublicationRevision ?site')) return { boolean: true };
      if (sparql.includes('SELECT ?zone ?revision ?routesRevision')) {
        return { results: { bindings: [{ zone: cell(zone), revision: cell(siteRevision),
          routesRevision: cell(siteRevision), navigationRevision: cell(siteRevision), themeRevision: cell(siteRevision),
          count: cell('1'), admissionId: cell(admission), digest: cell('b'.repeat(64)), authorityEpoch: cell('2'),
          scope: cell(`zone:edit:${zone}`), dataEpoch: cell(graphEpoch), sequence: cell('7'),
          binding: cell(zonePublishedPageBinding(siteRevision, selected.resource, selected.revision)),
          page: cell(selected.resource), variant: cell(selected.variant),
          contentRevision: cell(`urn:rezics:content:revision:${selected.revision}`), byteDigest: cell(selected.digest),
          ...(legacy ? {} : { homeDocument: cell(selected.resource), homeRevision: cell(siteRevision) }),
        }] } };
      }
      if (sparql.includes('SELECT ?outcome ?reason ?kind ?action')) {
        return { results: { bindings: [{ outcome: cell(`${RV}Cancelled`), digest: cell('b'.repeat(64)),
          admission: cell(admission), epoch: cell('2'), scope: cell(terminal.scope),
          dataEpoch: cell(terminal.dataEpoch), sequence: cell(terminal.sequence) }] } };
      }
      if (sparql.includes('ASK') && sparql.includes('rv:sequence ?current')) {
        const queriedZone = /<([^>]+)> a rv:Zone/.exec(sparql)?.[1];
        const association = /<([^>]+)> rv:homeDocument <([^>]+)>/.exec(sparql);
        const graphOpen = sparql.includes(`rv:dataEpoch "${graph.dataEpoch}"`)
          && sparql.includes(`rv:routingEpoch "${graph.routingEpoch}"`)
          && !graph.held && BigInt(graph.sequence) >= BigInt(publication.graph.sequence);
        const owner = !!queriedZone && graph.zoneTypes.has(queriedZone)
          && (queriedZone === resource || !!association && association[1] === queriedZone
            && association[2] === resource && graph.owners.includes(queriedZone)
            && (graph.owners.length === 1 || !sparql.includes('FILTER NOT EXISTS { ?otherZone rv:homeDocument')));
        const binding = status === 'rejected' || sparql.includes(`rv:ownerDataEpoch "${graph.pinEpoch}"`)
          && (graph.pin !== publication.preparationId || graph.pinSequence === publication.preparationPosition.sequence);
        return { boolean: graphOpen && owner && binding };
      }
      throw new Error(`unexpected home relay query: ${sparql.slice(0, 120)}`);
    },
    commandHealth: async () => { counters.profiles++; throw new Error('search profile was checked'); },
    command: async () => { counters.mutations++; throw new Error('search was mutated'); },
    commandWithReceipt: async () => { counters.mutations++; throw new Error('graph was mutated'); },
    update: async () => { counters.mutations++; throw new Error('graph was updated'); },
  } } as unknown as WorkActivationEnvironment;
  return { publication, selected, graph, terminal, queries, counters, acknowledgements,
    run: async () => {
      const result = await relayContentProjectionOnce(env, content, cursor, 'public-search');
      expect(counters).toEqual({ bodies: 0, profiles: 0, mutations: 0, publications: 1 });
      expect(acknowledgements).toHaveLength(1);
      expect(!!acknowledgements[0]!.pending).toBe(result?.disposition === 'deferred');
      return result;
    } };
}

test('home publication acknowledges exact P custody without live grants, body reads or search writes', async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({ sourceSequence: '3', disposition: 'ignored' });
  expect(f.queries.some(query => query.includes(`<${zone}> rv:homeDocument <${home}>`))).toBe(true);
});

test('legacy Zone-owned home custody remains acknowledgeable', async () => {
  expect((await fixture('active', true).run())?.disposition).toBe('ignored');
});

for (const field of ['resource', 'variant', 'revision', 'digest'] as const) {
  test(`a home receipt selecting another ${field} defers terminal acknowledgement`, async () => {
    const f = fixture();
    f.selected[field] = field === 'resource' ? foreignZone : field === 'variant'
      ? `urn:rezics:variant:${otherRevisionId}` : field === 'revision' ? otherRevisionId : 'c'.repeat(64);
    expect((await f.run())?.disposition).toBe('deferred');
  });
}

for (const status of ['active', 'rejected'] as const) {
  for (const owners of [[foreignZone], [zone, foreignZone]]) {
    test(`${status} home custody with ${owners.length === 1 ? 'foreign' : 'ambiguous'} Zone ownership defers`, async () => {
      const f = fixture(status);
      f.graph.owners = owners;
      expect((await f.run())?.disposition).toBe('deferred');
    });
  }
}

test('cancelled custody uses the retained owning-Zone scope for an untyped reserved P', async () => {
  const f = fixture('rejected');
  expect((await f.run())?.disposition).toBe('ignored');
  expect(f.queries.some(query => query.includes(`<${zone}> rv:homeDocument <${home}>`))).toBe(true);
});

test('legacy Zone-owned cancelled custody remains acknowledgeable', async () => {
  expect((await fixture('rejected', true).run())?.disposition).toBe('ignored');
});

for (const scope of [`zone:edit:${home}`, `zone:edit:${foreignZone}`]) {
  test(`cancelled home custody refuses ${scope === `zone:edit:${home}` ? 'P' : 'foreign Zone'} authority scope`, async () => {
    const f = fixture('rejected');
    f.terminal.scope = scope;
    expect((await f.run())?.disposition).toBe('deferred');
  });
}

for (const status of ['active', 'rejected'] as const) {
  for (const change of ['epoch', 'sequence', 'closed'] as const) {
    test(`${status} home custody defers an unavailable native ${change}`, async () => {
      const f = fixture(status);
      if (change === 'epoch') f.publication.graph.dataEpoch = contentEpoch;
      if (change === 'sequence') f.graph.sequence = '6';
      if (change === 'closed') f.graph.held = true;
      expect((await f.run())?.disposition).toBe('deferred');
    });
  }
}

test('cancelled custody cannot settle another revision encoded by its Content pin', async () => {
  const f = fixture('rejected');
  f.publication.preparationId = `content-site-pin:${admission}:${otherRevisionId}`;
  expect((await f.run())?.disposition).toBe('deferred');
});

test('active custody defers a different Content pin owner position', async () => {
  const f = fixture();
  f.graph.pinSequence = '1';
  expect((await f.run())?.disposition).toBe('deferred');
});

test('active custody defers a different Content pin epoch', async () => {
  const f = fixture();
  f.graph.pinEpoch = graphEpoch;
  expect((await f.run())?.disposition).toBe('deferred');
});

for (const field of ['dataEpoch', 'sequence'] as const) {
  test(`cancelled custody defers a retained receipt ${field} mismatch`, async () => {
    const f = fixture('rejected');
    f.terminal[field] = field === 'dataEpoch' ? contentEpoch : '6';
    expect((await f.run())?.disposition).toBe('deferred');
  });
}
