/**
 * Surface                         | Reader                              | Closed / absent | Open / restored
 * Original reply Asset bytes      | anonymous/member/moderator/platform | ABSENT          | existing audience
 * Exact Use bytes and renditions  | anonymous/member/moderator/platform | ABSENT          | existing audience
 * Matching ETag / cached 304      | anonymous/member/moderator/platform | ABSENT, no ETag | existing audience
 * Representation with/without Use | anonymous/member/moderator/platform | ABSENT          | existing audience
 * Missing/stale ancestry/recovery | any                                 | UNAVAILABLE     | UNAVAILABLE
 *
 * An injected Media ancestry owner reads current attachment evidence; the
 * injected disclosure owner decides closure. The adapter adds no policy.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  configureDisclosure, configureDisclosureAncestrySource, DisclosureUnavailable,
  type DisclosureAncestryEvidence, type DisclosureTarget, type OwnerEstablishedGraphParents,
} from '../src/modules/disclosure/read.ts';
import {
  captureClosedRealmMedia, readClosedRealmMedia, type ClosedRealmMediaReference,
} from '../src/modules/media/closed-realm-media.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../src/modules/suitability/policy.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { fixtureDisclosureCut } from './support/disclosure-ancestry.ts';

const ref = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const asset = ref(1), representation = ref(2), use = ref(3), work = ref(4), realm = ref(5);
const bytes = new TextEncoder().encode('Retained reply image bytes');
const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
const absent = () => Response.json({ code: 'media_unavailable', message: 'Media is unavailable' }, { status: 404 });

function fixture() {
  const state = { closed: false, attachmentRevision: 'attachment:1', missing: false,
    recoveryGeneration: fixtureDisclosureCut.recoveryGeneration,
    enforcementCut: fixtureDisclosureCut.enforcementCut, realmHead: 'realm:head:1' };
  const calls = { hydrate: 0, source: [] as DisclosureTarget[][], policy: [] as DisclosureTarget[][],
    viewers: [] as Viewer[] };
  const selected = new Map<string, DisclosureTarget>();
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (query: string) => ({ results: { bindings: [
      { resource: { value: work }, head: { value: 'work:head:1' } },
      { resource: { value: realm }, head: { value: state.realmHead } },
    ].filter(row => query.includes(`<${row.resource.value}>`)) } }) },
  } as unknown as WorkActivationEnvironment;
  const evidence = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const relationshipBasis = {
      owner: 'media' as const, kind: target.occurrence?.kind ?? 'publication' as const,
      resource: target.occurrence?.resource ?? asset,
      revision: target.occurrence?.revision ?? state.attachmentRevision,
      targetResource: target.resource, targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify([target.resource, state.attachmentRevision])).digest('hex'),
      dataEpoch: 'epoch',
    };
    selected.set(relationshipBasis.token, target);
    const parents: OwnerEstablishedGraphParents = [
      { owner: 'graph', kind: 'work', resource: work, head: 'work:head:1', relationshipBasis },
      { owner: 'graph', kind: 'realm', resource: realm, head: state.realmHead, relationshipBasis },
    ];
    return { resource: target.resource, resourceKind: 'other', relationshipBasis,
      parents, status: state.missing ? 'unavailable' : 'complete' };
  };
  configureDisclosureAncestrySource(env, 'media', {
    read: async targets => { calls.source.push([...targets]); return targets.map(evidence); },
    reread: async bases => bases.map(basis => evidence(selected.get(basis.token)!)),
  });
  configureDisclosure(env, {
    read: async () => { throw new Error('A media read must use the capture/final cut contract'); },
    readAtCut: async (targets, viewer, channel) => {
      expect(channel).toBe('media');
      calls.policy.push([...targets]); calls.viewers.push(viewer);
      return { decisions: targets.map(target => state.closed && target.ancestry!.parents.some(parent =>
        parent.kind === 'realm' && parent.resource === realm) ? 'hidden' as const : 'visible' as const),
      anonymousNames: [], fenceBases: targets.map(() => ({ recoveryGeneration: state.recoveryGeneration, enforcementCut: state.enforcementCut })) };
    },
  });
  const serve = async (reference: ClosedRealmMediaReference | null, validator: string | null = null,
    viewer: Viewer = ANONYMOUS_VIEWER, duringHydration?: () => void) => {
    // The route's owner lookup settles a nonexistent Asset before this adapter.
    if (!reference) return absent();
    const response = await readClosedRealmMedia(env, reference, async () => {
      calls.hydrate++;
      duringHydration?.();
      if (validator === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, no-cache' } });
      return new Response(bytes, { headers: { etag, 'content-type': 'image/png', 'cache-control': 'public, no-cache' } });
    }, viewer);
    return response ?? absent();
  };
  return { env, state, calls, serve };
}

async function observable(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()], body: [...new Uint8Array(await response.arrayBuffer())] };
}

for (const reader of ['anonymous', 'member', 'moderator', 'platform'] as const) {
  for (const surface of ['original', 'use', 'rendition'] as const) {
    for (const cached of [false, true]) {
      test(`closed reply ${surface} bytes are absent for ${reader}, cached=${cached}`, async () => {
        const f = fixture(); f.state.closed = true;
        const viewer = reader === 'anonymous' ? ANONYMOUS_VIEWER : { ...ANONYMOUS_VIEWER, signedIn: true };
        const reference = { asset: asset.slice(-36), ...(surface === 'original' ? {} : {
          representation: representation.slice(-36), use: use.slice(-36),
        }), context: ref(99), target: ref(100) };
        expect(await observable(await f.serve(reference, cached ? etag : null, viewer)))
          .toEqual(await observable(await f.serve(null, cached ? etag : null, viewer)));
        expect(f.calls.hydrate).toBe(0);
        expect(f.calls.viewers).toEqual([viewer]);
        expect(f.calls.policy[0]!.every(target => target.ancestry!.parents.some(parent =>
          parent.kind === 'realm' && parent.resource === realm))).toBe(true);
        expect(f.calls.source[0]!.every(target => target.work === undefined && !('target' in target))).toBe(true);
      });
    }
  }
}

test('an open read retains bytes and validators, and restoration admits a new read', async () => {
  const f = fixture();
  expect(await (await f.serve({ asset, representation, use })).text()).toBe('Retained reply image bytes');
  expect(f.calls.policy).toHaveLength(2);
  expect((await f.serve({ asset, representation, use }, etag)).status).toBe(304);
  f.state.closed = true;
  expect((await f.serve({ asset }, etag)).status).toBe(404);
  f.state.closed = false;
  expect((await f.serve({ asset }, etag)).status).toBe(304);
});

for (const cached of [false, true]) {
  test(`closure during hydration discards the response and all validators, cached=${cached}`, async () => {
    const f = fixture();
    await expect(f.serve({ asset, representation, use }, cached ? etag : null, ANONYMOUS_VIEWER, () => {
      f.state.closed = true; f.state.enforcementCut = 'b'.repeat(64);
    })).rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(f.calls.policy).toHaveLength(2);
  });
}

for (const change of ['attachment', 'head', 'recovery', 'cut'] as const) {
  test(`a stale ${change} discards buffered bytes as unavailable`, async () => {
    const f = fixture();
    await expect(f.serve({ asset, representation, use }, null, ANONYMOUS_VIEWER, () => {
      if (change === 'attachment') f.state.attachmentRevision = 'attachment:2';
      if (change === 'head') f.state.realmHead = 'realm:head:2';
      if (change === 'recovery') f.state.recoveryGeneration = '1';
      if (change === 'cut') f.state.enforcementCut = 'b'.repeat(64);
    })).rejects.toBeInstanceOf(DisclosureUnavailable);
  });
}

test('missing attachment evidence cannot authorize hydration', async () => {
  const f = fixture(); f.state.missing = true;
  await expect(f.serve({ asset })).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(f.calls.hydrate).toBe(0);
});

test('missing registered ancestry evidence or disclosure owner fails before loading any bytes', async () => {
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  configureDisclosureAncestrySource(env, 'media', { read: async () => [], reread: async () => [] });
  await expect(captureClosedRealmMedia(env, { asset })).rejects.toBeInstanceOf(DisclosureUnavailable);
  const f = fixture(); configureDisclosure(f.env, null);
  await expect(f.serve({ asset })).rejects.toBeInstanceOf(DisclosureUnavailable);
  expect(f.calls.hydrate).toBe(0);
});

test('a capture can fence an existing conditional-delivery callback without deriving new ancestry', async () => {
  const f = fixture();
  const read = await captureClosedRealmMedia(f.env, { asset, representation, use });
  expect(read).not.toBeNull();
  f.state.closed = true;
  expect(await read!.fence()).toBe(false);
});
