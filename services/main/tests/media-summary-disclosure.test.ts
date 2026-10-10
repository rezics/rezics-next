import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  configureDisclosure, DisclosureStore, discloseInventoryWithAnonymousNames,
  type DisclosureDecision, type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { readResourceSummaries, MAX_SUMMARY_BATCH } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { ANONYMOUS_VIEWER, type Labels, type Viewer } from '../src/modules/suitability/policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const principal = { issuer: 'account', subject: 'controller' };
interface Entry {
  type: 'work' | 'agent' | 'release';
  work?: string;
  head: string;
  publicName: boolean;
  active: boolean;
  controller?: string;
}
interface OwnerRequest extends DisclosureTarget { ordinal: number }

function fixture(count = 1, type: Entry['type'] = 'work') {
  const entries = new Map<string, Entry>(Array.from({ length: count }, (_, index) => {
    const reference = id(index + 1);
    return [reference, { type, head: id(index + 1001),
      ...(type === 'work' ? { work: reference } : {}), publicName: true, active: true }];
  }));
  const graphCalls: string[] = [], ownerCalls: Array<{ targets: OwnerRequest[]; effects: string[] }> = [];
  const assessments = new Map<string, Labels>();
  let restricted: (target: DisclosureTarget, effects: readonly string[]) => boolean = () => false;
  let recoveryOpen = true, malformedPublicName = false;
  const pool = { query: async (sql: string, args: unknown[]) => {
    if (!sql.includes('requested AS')) throw new Error('Unexpected disclosure statement');
    const targets = JSON.parse(String(args[0])) as OwnerRequest[];
    const effects = args[1] as string[];
    ownerCalls.push({ targets, effects });
    expect(targets.length).toBeLessThanOrEqual(64);
    return { rows: targets.map(target => {
      const owner = target.nameOwner ? entries.get(target.nameOwner) : undefined;
      const publicNameVisible = !target.nameOwner || !!owner?.active && owner.publicName;
      return { ordinal: target.ordinal, open: recoveryOpen, restricted: restricted(target, effects),
        assessments: sql.includes('access.suitability_assessment')
          ? [...new Set([target.resource, target.work])].flatMap(reference => reference && assessments.has(reference)
            ? [assessments.get(reference)!] : []) : [],
        nameVisible: !target.nameOwner || !!owner?.active && (owner.publicName
          || args[4] === principal.issuer && args[5] === owner.controller),
        publicNameVisible: malformedPublicName ? undefined : publicNameVisible };
    }) };
  } } as unknown as Pool;
  const graph = new FusekiClient('http://summary-disclosure.invalid');
  graph.query = async query => {
    graphCalls.push(query);
    const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
      .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
      .map(match => match[1]!);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      return { results: { bindings: [control, ...refs('r').flatMap(reference => {
        const entry = entries.get(reference);
        return entry ? [{ ...control, r: uri(reference), type: term(entry.type),
          ...(entry.work ? { work: uri(entry.work) } : {}), head: uri(entry.head), public: term('true'),
          label: { ...term(`Name ${reference.slice(-12)}`), 'xml:lang': 'en' } }] : [];
      })] } };
    }
    if (query.includes('SELECT ?work ?head')) return { results: { bindings: refs('work').map(reference => {
      const entry = entries.get(reference);
      return { work: uri(reference), ...(entry ? { head: uri(entry.head) } : {}),
        ...(entry?.type === 'agent' ? { nameOwner: uri(reference) } : {}),
        ...(entry?.work ? { owningWork: uri(entry.work), owningHead: uri(entries.get(entry.work)?.head ?? entry.head) } : {}) };
    }) } };
    if (query.includes('SELECT ?epoch ?hold ?context')) return { results: { bindings: [] } };
    throw new Error(`Unexpected summary query: ${query.slice(0, 160)}`);
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/summary-disclosure',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const disclosure = new DisclosureStore(pool);
  configureDisclosure(environment, disclosure);
  const input = { resources: [...entries.keys()], context: DEFAULT_MEDIA_CONTEXT, language: null };
  return { entries, environment, disclosure, graphCalls, ownerCalls, assessments, input,
    restrict: (policy: typeof restricted) => { restricted = policy; },
    holdRecovery: () => { recoveryOpen = false; },
    corruptPublicName: () => { malformedPublicName = true; },
  };
}

const avatar = (target: string): AvatarRow => ({ target, context: DEFAULT_MEDIA_CONTEXT,
  selection: id(501).slice(-36), selectionPosition: '1', use: id(502).slice(-36), asset: id(503).slice(-36),
  representation: id(504).slice(-36), sha256: 'a'.repeat(64), crop: null,
  mediaType: 'image/png', byteLength: 100, width: 128, height: 128, availability: 'available',
  clearance: 'cleared', disclosure: 'public', moderation: 'none', lifecycle: 'active', statePosition: '1' });
const media = (hydrate: () => void = () => {}) => ({
  avatarRows: async (resources: readonly string[]) => {
    hydrate();
    return { rows: new Map(resources.map(reference => [reference, avatar(reference)])),
      generation: { owner: 'content' as const, dataEpoch: 'media', sequence: '1' } };
  },
});

test('Summary classifies a controller-visible private Agent name as restricted and withholds it from other audiences', async () => {
  const f = fixture(1, 'agent'), entry = f.entries.get(id(1))!;
  entry.publicName = false; entry.controller = principal.subject;
  const controller = await readResourceSummaries(f.environment, undefined,
    { viewer: disclosureViewer(principal) }, f.input);
  expect(controller.summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted',
    name: { value: 'Name 000000000001' } });
  expect(f.ownerCalls).toHaveLength(2);
  for (const viewer of [ANONYMOUS_VIEWER, disclosureViewer({ ...principal, subject: 'stranger' })]) {
    const result = await readResourceSummaries(f.environment, undefined, { viewer }, f.input);
    expect(result.summaries).toEqual([{ reference: id(1), status: 'unavailable' }]);
  }
  expect((await readResourceSummaries(f.environment, undefined,
    { viewer: disclosureViewer(principal) }, { ...f.input, channel: 'search' })).summaries)
    .toEqual([{ reference: id(1), status: 'unavailable' }]);
  expect((await readResourceSummaries(f.environment, undefined,
    { viewer: disclosureViewer(principal) }, f.input)).summaries[0]).toMatchObject({ disclosure: 'restricted' });
  entry.publicName = true;
  expect((await readResourceSummaries(f.environment, undefined,
    { viewer: disclosureViewer(principal) }, f.input)).summaries[0]).toMatchObject({ disclosure: 'public' });
});

for (const change of ['governance', 'private-name', 'controller-revoked', 'agent-deactivated'] as const) {
  test(`Final summary disclosure denies ${change} during avatar hydration`, async () => {
    const f = fixture(1, change === 'governance' ? 'work' : 'agent');
    const entry = f.entries.get(id(1))!;
    entry.controller = principal.subject;
    if (change === 'controller-revoked') entry.publicName = false;
    const hydrated = media(() => {
      if (change === 'governance') f.restrict(() => true);
      else if (change === 'private-name') { entry.publicName = false; entry.controller = undefined; }
      else if (change === 'controller-revoked') entry.controller = undefined;
      else entry.active = false;
    });
    expect((await readResourceSummaries(f.environment, hydrated,
      { viewer: disclosureViewer(principal) }, f.input)).summaries).toEqual([
      { reference: id(1), status: 'unavailable' },
    ]);
    expect(f.ownerCalls).toHaveLength(2);
  });
}

test('Final summary classification observes a public-to-private change while retaining current controller visibility', async () => {
  const f = fixture(1, 'agent'), entry = f.entries.get(id(1))!;
  entry.controller = principal.subject;
  const result = await readResourceSummaries(f.environment, media(() => { entry.publicName = false; }),
    { viewer: disclosureViewer(principal) }, f.input);
  expect(result.summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted' });
  expect(f.ownerCalls).toHaveLength(2);
});

test('A full summary batch spends the same graph calls signed in and anonymous, with two owner statements per pass', async () => {
  for (const viewer of [ANONYMOUS_VIEWER, disclosureViewer(principal)]) {
    const f = fixture(MAX_SUMMARY_BATCH);
    for (let pass = 0; pass < 2; pass++) {
      const result = await readResourceSummaries(f.environment, undefined, { viewer }, f.input);
      expect(result.summaries).toHaveLength(MAX_SUMMARY_BATCH);
      expect(result.summaries.every(summary => summary.status === 'available' && summary.disclosure === 'public')).toBe(true);
      expect(result.cost).toMatchObject({ graphQueries: 3, accessQueries: 2 });
      expect(f.graphCalls).toHaveLength((pass + 1) * 3);
      expect(f.ownerCalls).toHaveLength((pass + 1) * 2);
      expect(f.ownerCalls.at(-1)!.targets).toHaveLength(MAX_SUMMARY_BATCH);
    }
  }
});

test('Owner adapters without paired decisions retain the required anonymous probe and its measured cost', async () => {
  const f = fixture(1, 'agent'), entry = f.entries.get(id(1))!;
  entry.publicName = false; entry.controller = principal.subject;
  // This adapter uses the real owner but deliberately supports only its original interface.
  configureDisclosure(f.environment, { read: f.disclosure.read.bind(f.disclosure) });
  const result = await readResourceSummaries(f.environment, undefined,
    { viewer: disclosureViewer(principal) }, f.input);
  expect(result.summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted' });
  expect(f.ownerCalls).toHaveLength(3);
  expect(f.graphCalls).toHaveLength(6);
  expect(result.cost).toMatchObject({ graphQueries: 4, accessQueries: 3 });
});

test('A full summary batch with covers preserves name indexes across two bounded final owner statements', async () => {
  const f = fixture(MAX_SUMMARY_BATCH);
  f.restrict(target => target.owner === 'media');
  const result = await readResourceSummaries(f.environment, media(),
    { viewer: disclosureViewer(principal) }, f.input);
  expect(result.summaries).toHaveLength(MAX_SUMMARY_BATCH);
  expect(result.summaries.every(summary => summary.status === 'available'
    && summary.disclosure === 'public' && summary.avatar.kind === 'fallback')).toBe(true);
  expect(f.ownerCalls.map(call => call.targets.length)).toEqual([64, 64, 64]);
  expect(f.graphCalls).toHaveLength(4);
  expect(result.cost).toMatchObject({ graphQueries: 4, accessQueries: 3, mediaQueries: 1 });
});

test('Release summaries carry the current owning Work and exact parent head into both disclosure passes', async () => {
  const f = fixture(2);
  f.entries.set(id(10), { type: 'release', work: id(2), head: id(1002), publicName: true, active: true });
  const input = { ...f.input, resources: [id(1), id(10)] };
  const first = await readResourceSummaries(f.environment, undefined, { viewer: disclosureViewer(principal) }, input);
  expect(first.summaries.map(summary => summary.status)).toEqual(['available', 'available']);
  for (const call of f.ownerCalls) {
    expect(call.targets[1]).toMatchObject({ resource: id(10), work: id(2), workRevision: id(1002) });
  }
  f.entries.get(id(2))!.head = id(1202);
  f.entries.get(id(10))!.head = id(1202);
  f.restrict(target => target.work === id(2) && target.workRevision === id(1202));
  const second = await readResourceSummaries(f.environment, undefined, { viewer: disclosureViewer(principal) }, input);
  expect(second.summaries).toEqual([expect.objectContaining({ reference: id(1), status: 'available' }),
    { reference: id(10), status: 'unavailable' }]);
  expect(f.ownerCalls[2]!.targets[1]).toMatchObject({ resource: id(10), work: id(2), workRevision: id(1202) });
});

test('Paired inventory retains every exact target, parent revision, context and channel independently', async () => {
  const f = fixture(2);
  const targets: DisclosureTarget[] = [
    { owner: 'graph', resource: id(1), component: 'name', revision: id(1001), work: id(1), workRevision: id(1001) },
    { owner: 'graph', resource: id(2), component: 'title', revision: id(1002), work: id(2), workRevision: id(1002) },
    { owner: 'graph', resource: id(1), component: 'name', revision: id(1101), work: id(1), workRevision: id(1101) },
    { owner: 'graph', resource: id(1), component: 'name', revision: id(1001), work: id(2), workRevision: id(1002) },
    { owner: 'graph', resource: id(1), component: 'name', revision: id(1001), work: id(2), workRevision: id(1102) },
    { owner: 'graph', resource: id(1), component: 'name', revision: id(1001), work: id(1), workRevision: id(1001), context: id(700) },
  ];
  f.restrict((target, effects) => effects.includes('search') && (target.resource === id(2)
    || target.revision === id(1101) || target.workRevision === id(1102) || target.context === id(700)));
  for (const channel of ['summary', 'search', 'summary'] as const) {
    const result = await discloseInventoryWithAnonymousNames(f.environment, targets, disclosureViewer(principal), channel);
    const expected: DisclosureDecision[] = channel === 'search'
      ? ['visible', 'hidden', 'hidden', 'visible', 'hidden', 'hidden']
      : targets.map(() => 'visible' as const);
    expect(result.decisions).toEqual(expected);
    expect(result.anonymousNames).toEqual(expected);
    const captured = f.ownerCalls.at(-1)!.targets;
    targets.forEach((target, index) => expect(captured[index]).toMatchObject(target));
  }
  expect(f.ownerCalls).toHaveLength(3);
  expect(f.graphCalls).toHaveLength(3);
});

test('Paired anonymous classification applies its own suitability audience at the same owner cut', async () => {
  const f = fixture(), viewer: Viewer = { signedIn: true, age: 'adult', country: 'US',
    optIns: { general: true, r15: true, sexual: true, grotesque: true } };
  f.assessments.set(id(1), ['r15']);
  const result = await readResourceSummaries(f.environment, undefined, { viewer }, { ...f.input, channel: 'digest' });
  expect(result.summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted' });
  expect(f.ownerCalls).toHaveLength(2);
  expect((await readResourceSummaries(f.environment, undefined, { viewer: ANONYMOUS_VIEWER },
    { ...f.input, channel: 'digest' })).summaries).toEqual([{ reference: id(1), status: 'unavailable' }]);
});

test('Anonymous name classification does not replace a signed-in viewers private media visibility', async () => {
  const f = fixture(), viewer = disclosureViewer(principal, id(1));
  let visibilityReads = 0;
  configureMediaVisibility({ environment: f.environment, access: {
    canManageMedia: async () => true,
  }, media: { store: {
    visibilityFacts: async (resources: readonly string[]) => {
      visibilityReads++;
      return new Map(resources.map(reference => [reference, {
        owner: id(1), disclosure: 'private', pending: false, blocked: false, attachments: [],
      }]));
    },
  } } } as unknown as MainWorkDependencies);
  const signedIn = await readResourceSummaries(f.environment, media(), { viewer }, f.input);
  expect(signedIn.summaries[0]).toMatchObject({ disclosure: 'public', avatar: { kind: 'image' } });
  const anonymous = await readResourceSummaries(f.environment, media(), { viewer: ANONYMOUS_VIEWER }, f.input);
  expect(anonymous.summaries[0]).toMatchObject({ disclosure: 'public', avatar: { kind: 'fallback' } });
  expect(visibilityReads).toBe(2);
});

for (const failure of ['recovery', 'incomplete-anonymous'] as const) {
  test(`Final paired disclosure fails closed on ${failure}`, async () => {
    const f = fixture(1, 'agent');
    const hydrated = media(() => {
      if (failure === 'recovery') f.holdRecovery();
      else f.corruptPublicName();
    });
    await expect(readResourceSummaries(f.environment, hydrated,
      { viewer: disclosureViewer(principal) }, f.input)).rejects.toThrow('Disclosure result is incomplete');
  });
}
