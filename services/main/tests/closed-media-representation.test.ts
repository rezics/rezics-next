import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  configureDisclosure, configureDisclosureAncestrySource, DisclosureUnavailable,
  type DisclosureAncestryEvidence, type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { readClosedRealmMedia, readClosedRealmMediaSelection } from '../src/modules/media/closed-realm-media.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { fixtureDisclosureCut } from './support/disclosure-ancestry.ts';

const ref = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const asset = ref(1), representation = ref(2), use = ref(3), realm = ref(4);

type DisclosureAwait = 'ancestry' | 'capture-relationship' | 'capture-head' | 'capture-decision'
  | 'fence-relationship' | 'fence-head' | 'fence-decision';

function fixture(duringAwait: (phase: DisclosureAwait) => Promise<void> = async () => {}) {
  const state = { closed: false, independent: false, attachmentPresent: true,
    directHidden: null as string | null, failReread: false };
  const calls = { hydrate: 0, targets: [] as DisclosureTarget[], rereads: 0, heads: 0, decisions: 0 };
  const selected = new Map<string, DisclosureTarget>();
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async () => {
      await duringAwait(++calls.heads === 1 ? 'capture-head' : 'fence-head');
      return { results: { bindings: [{ resource: { value: realm }, head: { value: 'realm:1' } }] } };
    } },
  } as unknown as WorkActivationEnvironment;
  const evidence = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const relationshipBasis = { owner: 'media' as const,
      kind: target.occurrence ? 'media-use' as const : 'publication' as const,
      resource: target.occurrence?.resource ?? asset,
      revision: target.occurrence?.revision ?? 'asset:attachments:1', targetResource: target.resource,
      targetRevision: null, token: createHash('sha256').update(target.resource).digest('hex'), dataEpoch: 'epoch' };
    selected.set(relationshipBasis.token, target);
    return { resource: target.resource, resourceKind: 'other', relationshipBasis,
      parents: state.independent ? [] : [{ owner: 'graph', kind: 'realm', resource: realm,
        head: 'realm:1', relationshipBasis }],
      status: state.attachmentPresent ? 'complete' : 'unavailable' };
  };
  configureDisclosureAncestrySource(env, 'media', {
    read: async targets => {
      calls.targets.push(...targets);
      await duringAwait('ancestry');
      return targets.map(evidence);
    },
    reread: async bases => {
      await duringAwait(++calls.rereads === 1 ? 'capture-relationship' : 'fence-relationship');
      if (state.failReread) throw new Error('Media evidence owner is offline');
      return bases.map(basis => evidence(selected.get(basis.token)!));
    },
  });
  configureDisclosure(env, {
    read: async () => { throw new Error('Expected fresh disclosure cut'); },
    readAtCut: async targets => {
      await duringAwait(++calls.decisions === 1 ? 'capture-decision' : 'fence-decision');
      return { decisions: targets.map(target =>
        target.resource === state.directHidden || state.closed && target.ancestry!.parents.some(parent =>
          parent.kind === 'realm' && parent.resource === realm) ? 'hidden' as const : 'visible' as const),
      anonymousNames: [], fenceBases: targets.map(() => fixtureDisclosureCut) };
    },
  });
  const read = (withUse: boolean, duringHydration?: () => void | Promise<void>) => readClosedRealmMedia(env,
    { asset, representation, ...(withUse ? { use } : {}) }, async () => {
      calls.hydrate++; await duringHydration?.();
      return { asset, representation, use: withUse ? use : null, sha256: 'a'.repeat(64), width: 100, height: 100 };
    }, ANONYMOUS_VIEWER);
  return { env, state, calls, read };
}

for (const withUse of [false, true]) {
  test(`closed representation metadata is absent, withUse=${withUse}`, async () => {
    const f = fixture(); f.state.closed = true;
    expect(await f.read(withUse)).toBeNull();
    expect(f.calls.hydrate).toBe(0);
    expect(f.calls.targets.map(target => target.resource)).toEqual(withUse ? [asset, representation, use] : [asset, representation]);
    expect(f.calls.targets.every(target => withUse ? target.occurrence?.resource === use
      && target.occurrence.revision === use : target.occurrence === undefined)).toBe(true);
  });

  test(`open metadata is preserved and fenced after hydration, withUse=${withUse}`, async () => {
    const f = fixture();
    expect(await f.read(withUse)).toEqual({ asset, representation, use: withUse ? use : null,
      sha256: 'a'.repeat(64), width: 100, height: 100 });
    expect(f.calls.hydrate).toBe(1);
    expect(f.calls.rereads).toBe(2);
  });

  test(`a fresh Realm closure discards hydrated metadata, withUse=${withUse}`, async () => {
    const f = fixture();
    expect(await f.read(withUse, () => { f.state.closed = true; })).toBeNull();
  });
}

for (const hidden of [asset, representation, use]) {
  test(`direct governance on ${hidden.slice(-1)} still hides an otherwise open occurrence`, async () => {
    const f = fixture(); f.state.directHidden = hidden;
    expect(await f.read(true)).toBeNull();
    expect(f.calls.hydrate).toBe(0);
  });

  test(`only ${hidden === asset ? 'Asset' : hidden === representation ? 'Representation' : 'Use'} hidden during hydration makes delivery absent`, async () => {
    const f = fixture();
    expect(await f.read(true, async () => {
      await Promise.resolve();
      f.state.directHidden = hidden;
    })).toBeNull();
    expect(f.state.closed).toBe(false);
    expect(f.calls.hydrate).toBe(1);
    expect(f.calls.decisions).toBe(2);
    expect(f.calls.targets.map(target => target.resource)).toEqual([asset, representation, use]);
  });
}

test('an owner-proven independent Asset does not acquire a Realm from an unrelated closure', async () => {
  const f = fixture(); f.state.independent = true; f.state.closed = true;
  expect(await f.read(false)).not.toBeNull();
});

test('a missing exact attachment is unavailable rather than an independent publication', async () => {
  const f = fixture(); f.state.attachmentPresent = false;
  await expect(f.read(true)).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(f.calls.hydrate).toBe(0);
});

test('a removed attachment or failed owner reread discards already hydrated metadata', async () => {
  for (const failure of ['removed', 'offline'] as const) {
    const f = fixture();
    await expect(f.read(true, () => {
      if (failure === 'removed') f.state.attachmentPresent = false;
      else f.state.failReread = true;
    })).rejects.toBeInstanceOf(DisclosureUnavailable);
  }
});

test('the initial missing and closed owner selections share null without hydration', async () => {
  for (const kind of ['missing', 'closed'] as const) {
    const f = fixture(); f.state.closed = true;
    let reads = 0, hydrations = 0;
    const result = await readClosedRealmMediaSelection(f.env, async () => {
      reads++;
      return kind === 'missing' ? null : { asset, representation, use };
    }, row => row, async row => { hydrations++; return row; });
    expect(result).toBeNull();
    expect(reads).toBe(1);
    expect(hydrations).toBe(0);
  }
});

test('a stable owner selection hydrates only after its exact basis is reread', async () => {
  const f = fixture();
  const events: string[] = [];
  expect(await readClosedRealmMediaSelection(f.env, async () => {
    events.push('owner'); return { asset, representation, use };
  }, row => row, async row => { events.push('hydrate'); return row.representation; })).toBe(representation);
  expect(events).toEqual(['owner', 'owner', 'hydrate']);
});

for (const change of ['asset', 'representation', 'use', 'digest', 'removed', 'mutated'] as const) {
  test(`a moved ${change} selection cannot borrow fresh ancestry to hydrate the old selection`, async () => {
    const f = fixture();
    const selected = { asset, representation, use, digest: 'a'.repeat(64) };
    let reads = 0, hydrations = 0;
    await expect(readClosedRealmMediaSelection(f.env, async () => {
      if (++reads === 1) return selected;
      if (change === 'removed') return null;
      if (change === 'mutated') { selected.digest = 'b'.repeat(64); return selected; }
      return { ...selected, [change]: change === 'digest' ? 'b'.repeat(64) : ref(99) };
    }, row => row, async row => { hydrations++; return row; })).rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(hydrations).toBe(0);
  });
}

// Shared owner A -> closed B: before capture => ABSENT; capture/reread =>
// UNAVAILABLE; after the equality check => captured A bytes and metadata only.
const selectionAwaits = ['initial-owner', 'ancestry', 'capture-relationship', 'capture-head',
  'capture-decision', 'fresh-owner', 'hydration', 'fence-relationship', 'fence-head', 'fence-decision'] as const;

for (const phase of selectionAwaits) {
  test(`a shared owner mutation during ${phase} never hydrates its closed successor`, async () => {
    const original = { asset, representation, use,
      metadata: { sha256: 'a'.repeat(64), width: 100 }, bytes: new Uint8Array([1, 2, 3]) };
    const selected = structuredClone(original);
    const successor = { asset: ref(11), representation: ref(12), use: ref(13),
      metadata: { sha256: 'b'.repeat(64), width: 200 }, bytes: new Uint8Array([4, 5, 6]) };
    const events: string[] = [];
    const mutateDuring = async (current: string) => {
      events.push(current);
      // Suspend the owner/hydrator so the mutation occurs inside its await.
      await Promise.resolve();
      if (current === phase) {
        selected.asset = successor.asset;
        selected.representation = successor.representation;
        selected.use = successor.use;
        Object.assign(selected.metadata, successor.metadata);
        selected.bytes.set(successor.bytes);
      }
    };
    const f = fixture(mutateDuring);
    f.state.directHidden = successor.asset;
    let ownerReads = 0, hydrations = 0;
    const result = readClosedRealmMediaSelection(f.env, async () => {
      await mutateDuring(++ownerReads === 1 ? 'initial-owner' : 'fresh-owner');
      return selected;
    }, row => row, async row => {
      hydrations++;
      await mutateDuring('hydration');
      return structuredClone(row);
    });
    if (phase === 'initial-owner') {
      expect(await result).toBeNull();
      expect(hydrations).toBe(0);
    } else if (['ancestry', 'capture-relationship', 'capture-head', 'capture-decision', 'fresh-owner'].includes(phase)) {
      await expect(result).rejects.toBeInstanceOf(DisclosureUnavailable);
      expect(hydrations).toBe(0);
    } else {
      expect(await result).toEqual(original);
      expect(hydrations).toBe(1);
      expect(f.calls.targets.map(target => target.resource)).toEqual([asset, representation, use]);
    }
    expect(events).toContain(phase);
    expect(selected).toEqual(successor);
  });
}
