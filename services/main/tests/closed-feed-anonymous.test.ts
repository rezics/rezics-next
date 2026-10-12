// Surface                         anonymous  member  manager  case-party
// All/Following, New/Best/Top      omit       omit    omit     omit
// Every retained continuation     omit       omit    omit     omit
// Group/rank/count attribution    omit       omit    omit     omit
// Realm scope (closed/missing)    same 404   same 404 same 404  same 404
// Closure during card hydration   omit       omit    omit     omit
// Independent original            preserve   preserve preserve preserve
// These tests exercise the adapter boundary; route wiring is a separate claim.
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import {
  configureDisclosure, configureDisclosureAncestrySource, DisclosureUnavailable,
  type DisclosureAncestryEvidence, type DisclosureRelationshipBasis, type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import {
  captureClosedRealmFeedScope, captureClosedRealmFeedSources, readClosedRealmFeedSources,
} from '../src/modules/feed/closed-realm-feed.ts';
import { rankCandidates } from '../src/modules/feed/ranking.ts';
import type { FeedSource } from '../src/modules/feed/source.ts';
import { retainedMembershipBasis } from '../src/modules/read-basis/membership.ts';
import { WorkReadMissing, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { fixtureDisclosureCut } from './support/disclosure-ancestry.ts';

export type ClosedFeedReader = 'anonymous' | 'member' | 'manager' | 'case-party';
const native = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = native(1), work = native(2), head = 'urn:rezics:revision:feed-parent:1';
const binding = (value: string) => ({ type: 'uri' as const, value });

export function closedFeedOwner(actor: ClosedFeedReader) {
  const state = { closed: false, workHidden: false, contentHidden: false, ancestry: true,
    realmParent: true, preparation: true, approval: true, placement: 'current', parentHead: head,
    generation: '0', enforcementCut: fixtureDisclosureCut.enforcementCut, available: true, hydrate: () => {},
    privateRealm: false, member: true, proof: 'membership:1',
    reviewGrain: null as null | 'work' | 'realization' | 'release' | 'occurrence' | 'resource' };
  const sources: FeedSource[] = Array.from({ length: 6 }, (_, index) => ({
    id: native(10 + index), sequence: String(index + 1), kind: index % 2 === 0 ? 'discussion' : 'work',
    target: index % 2 === 0 ? native(30 + index) : work, work, actor: native(40 + index),
    realm: index % 2 === 0 ? realm : null, zone: null, language: 'en', excerpt: `Body ${index}`,
    title: null, occurrence: null, contentTarget: null, reply: index % 2 === 0 ? native(30 + index) : null,
    contentRevision: index % 2 === 0 ? `urn:rezics:content:revision:revision-${index}` : null, review: null,
  }));
  const calls: { targets: readonly DisclosureTarget[]; channel: string; signedIn: boolean }[] = [];
  const selected = new Map<string, DisclosureTarget>();
  const env = { lineage: { dataEpoch: 'closed-feed-epoch', routingEpoch: 'routing' },
    fuseki: { query: async (query: string) => {
      if (query.includes('SELECT ?space ?realmRevision')) return { results: { bindings:
        query.includes(`<${realm}>`) ? [{ space: binding(native(3)), realmRevision: binding(head),
          disclosure: binding(`${RV}${state.privateRealm ? 'Private' : 'Public'}`) }] : [] } };
      if (query.includes('SELECT ?resource ?head')) return { results: { bindings:
        [work, realm].filter(id => query.includes(`<${id}>`)).map(id => ({ resource: binding(id), head: binding(state.parentHead) })) } };
      if (query.includes('SELECT DISTINCT ?id ?sequence ?kind ?target')) {
        state.hydrate();
        return { results: { bindings: sources.filter(source => query.includes(`<${source.id}>`)).map(source => ({
          id: binding(source.id), sequence: binding(source.sequence), kind: binding(source.kind),
          target: binding(source.target), work: binding(work), actor: binding(source.actor),
          ...(source.realm ? { realm: binding(source.realm), reply: binding(source.reply!),
            contentRevision: binding(source.contentRevision!) } : {}),
        })) } };
      }
      throw new Error('Unexpected feed owner query');
    } },
  } as unknown as WorkActivationEnvironment;
  const evidence = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const direct = target.resource === realm;
    const source = direct ? undefined : sources.find(source => source.id === target.occurrence?.resource);
    if (!direct && !source) throw new Error('Unknown selected occurrence');
    const basis: DisclosureRelationshipBasis = {
      owner: target.occurrence?.owner ?? 'graph',
      kind: state.reviewGrain && state.reviewGrain !== 'work' ? 'publication' : target.occurrence?.kind ?? 'identity',
      resource: target.occurrence?.resource ?? realm,
      revision: target.occurrence?.revision ?? head,
      targetResource: target.resource, targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify([target, state.placement])).digest('hex'),
      dataEpoch: env.lineage.dataEpoch,
    };
    selected.set(basis.token, target);
    return { resource: target.resource, resourceKind: direct ? 'realm' : 'other', relationshipBasis: basis,
      status: state.ancestry && (!source?.realm || state.approval && state.preparation) ? 'complete' : 'unavailable',
      parents: direct ? [] : source?.realm && state.realmParent
        ? [...(state.reviewGrain === 'resource' ? [] : [{ owner: 'graph' as const, kind: 'work' as const, resource: work, head, relationshipBasis: basis }]),
          { owner: 'graph', kind: 'realm', resource: realm, head, relationshipBasis: basis }]
        : [{ owner: 'graph', kind: 'work', resource: work, head, relationshipBasis: basis }],
    };
  };
  const ancestry = { read: async (targets: readonly DisclosureTarget[]) => targets.map(evidence),
    reread: async (bases: readonly DisclosureRelationshipBasis[]) => bases.map(basis => evidence(selected.get(basis.token)!)) };
  for (const owner of ['graph', 'content', 'review'] as const) configureDisclosureAncestrySource(env, owner, ancestry);
  configureDisclosure(env, {
    read: async () => { throw new Error('A feed must capture an Access cut'); },
    readAtCut: async (targets, viewer, channel) => {
      if (!state.available) throw new DisclosureUnavailable('Access unavailable');
      calls.push({ targets, channel, signedIn: viewer.signedIn });
      return { decisions: targets.map(target => state.closed && (target.resource === realm
        || target.ancestry?.parents.some(parent => parent.kind === 'realm' && parent.resource === realm))
        || state.workHidden && target.ancestry?.parents.some(parent => parent.resource === work)
        || state.contentHidden && target.owner === 'content' ? 'hidden' as const : 'visible' as const),
      anonymousNames: [], fenceBases: targets.map(() => ({ recoveryGeneration: state.generation, enforcementCut: state.enforcementCut })) };
    },
  });
  const viewer = disclosureViewer(actor === 'anonymous' ? null : { issuer: 'account.test', subject: actor } as never);
  const session = new WorkReadSession({ environment: env, access: {
    realmReadProof: async () => state.member ? state.proof : null,
  } } as unknown as MainWorkDependencies, new Request('https://rezics.test/feed'),
  { actingSubject: actor === 'anonymous' ? undefined : native(80), publicViewer: viewer },
  { dataEpoch: env.lineage.dataEpoch, sequence: '6' });
  session.principal = actor === 'anonymous' ? null : { issuer: 'account.test', subject: actor } as never;
  return { state, session, sources, calls, realm, work };
}

export function closedFeedCases(actor: ClosedFeedReader) {
  for (const scope of actor === 'anonymous' ? ['all'] : ['all', 'following']) {
    for (const order of scope === 'following' ? ['new', 'best'] as const : ['new', 'best', 'top'] as const) {
      test(`closed-feed-${actor}: ${scope}/${order} omits every Realm occurrence across continuations`, async () => {
        const owner = closedFeedOwner(actor);
        const position = { dataEpoch: 'closed-feed-epoch', sequence: '1' }, filter = ['home-feed-v1', actor, scope, order];
        let cursor: string | undefined;
        const delivered: string[] = [];
        owner.state.closed = true;
        for (let start = 0; start < owner.sources.length; start += 2) {
          const retained = retainedMembershipBasis('home-feed-v1', cursor, filter, position);
          const batch = await captureClosedRealmFeedSources(owner.session, owner.sources.slice(start, start + 2));
          const visible = await batch.fence();
          expect(visible).toEqual([owner.sources[start + 1]!]);
          const ranked = order === 'new' ? visible : rankCandidates(visible.map(source => ({ ...source, score: 1, time: 0 })), order);
          delivered.push(...ranked.map(source => source.id));
          const last = owner.sources[start + 1]!;
          cursor = retained.encode(last.id, JSON.stringify({ recentRealms: visible.map(source => source.realm), count: visible.length }));
          const next = retainedMembershipBasis('home-feed-v1', cursor, filter, position);
          expect(next.cursor?.order).not.toContain(owner.realm);
        }
        expect(delivered).toEqual(owner.sources.filter(source => !source.realm).map(source => source.id));
        expect(owner.calls.every(call => call.signedIn === (actor !== 'anonymous'))).toBe(true);
      });
    }
  }
  test(`closed-feed-${actor}: capture precedes grouping and count attribution`, async () => {
    const owner = closedFeedOwner(actor);
    owner.state.closed = true;
    const batch = await captureClosedRealmFeedSources(owner.session, owner.sources, 'count');
    expect(batch.sources.length).toBe(3);
    expect((await batch.fence()).map(source => source.actor)).toEqual(owner.sources.filter(source => !source.realm).map(source => source.actor));
    expect(owner.calls.every(call => call.channel === 'count')).toBe(true);
  });
  test(`closed-feed-${actor}: count receipts carry the exact placement without hydrated card fields`, async () => {
    const owner = closedFeedOwner(actor);
    const source = owner.sources[0]!;
    const receipt = { id: source.id, kind: source.kind, target: source.target, work: source.work,
      realm: source.realm, reply: source.reply, contentTarget: source.contentTarget, contentRevision: source.contentRevision };
    const counted = await captureClosedRealmFeedSources(owner.session, [receipt], 'count');
    expect(counted.sources).toEqual([receipt]);
    owner.state.closed = true;
    expect(await counted.fence()).toEqual([]);
  });
  test(`closed-feed-${actor}: closure during hydration discards cards and their continuation attribution`, async () => {
    const owner = closedFeedOwner(actor);
    const batch = await captureClosedRealmFeedSources(owner.session, owner.sources);
    expect(batch.sources).toEqual(owner.sources);
    const hydrated = new Map(batch.sources.map(source => [source.id, { body: source.excerpt, realm: source.realm, actor: source.actor }]));
    owner.state.closed = true;
    const delivered = (await batch.fence()).map(source => hydrated.get(source.id));
    expect(delivered.length).toBe(3);
    expect(JSON.stringify(delivered)).not.toContain(owner.realm);
    expect(delivered).toEqual(owner.sources.filter(source => !source.realm).map(source => hydrated.get(source.id)));
  });
  test(`closed-feed-${actor}: Realm scope is missing before selection and fenced after hydration`, async () => {
    const owner = closedFeedOwner(actor);
    const fence = await captureClosedRealmFeedScope(owner.session, realm);
    owner.state.closed = true;
    await expect(fence()).rejects.toBeInstanceOf(WorkReadMissing);
    const missing = async (id: string) => {
      try { await captureClosedRealmFeedScope(owner.session, id); return null; }
      catch (error) { expect(error).toBeInstanceOf(WorkReadMissing); return { status: 404, body: 'Realm unavailable' }; }
    };
    expect(await missing(realm)).toEqual(await missing(native(999)));
  });
  test(`closed-feed-${actor}: private Realm scope and occurrences preserve the Work owner's refusal`, async () => {
    const owner = closedFeedOwner(actor);
    owner.state.privateRealm = true;
    owner.state.member = false;
    await expect(owner.session.realm(realm)).rejects.toBeInstanceOf(WorkReadMissing);
    await expect(captureClosedRealmFeedScope(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
    await expect(captureClosedRealmFeedSources(owner.session, [owner.sources[0]!])).rejects.toBeInstanceOf(WorkReadMissing);
    expect(owner.calls).toEqual([]);
    await expect(captureClosedRealmFeedScope(owner.session, native(999))).rejects.toBeInstanceOf(WorkReadMissing);
  });
  if (actor !== 'anonymous') test(`closed-feed-${actor}: private Realm revocation and changed membership fence delivery`, async () => {
    for (const change of ['revoked', 'changed'] as const) {
      const owner = closedFeedOwner(actor);
      owner.state.privateRealm = true;
      const scoped = await captureClosedRealmFeedScope(owner.session, realm);
      const captured = await captureClosedRealmFeedSources(owner.session, [owner.sources[0]!]);
      if (change === 'revoked') owner.state.member = false;
      else owner.state.proof = 'membership:2';
      await expect(scoped()).rejects.toBeInstanceOf(Error);
      await expect(captured.fence()).rejects.toBeInstanceOf(Error);
    }
  });
  test(`closed-feed-${actor}: missing ancestry, approval and preparation cannot expose a retained event`, async () => {
    for (const key of ['ancestry', 'approval', 'preparation', 'realmParent', 'available'] as const) {
      const owner = closedFeedOwner(actor);
      owner.state[key] = false;
      await expect(captureClosedRealmFeedSources(owner.session, owner.sources)).rejects.toBeInstanceOf(DisclosureUnavailable);
    }
  });
  test(`closed-feed-${actor}: changed placement, approval, preparation, parent and recovery discard captured hydration`, async () => {
    for (const change of ['placement', 'approval', 'preparation', 'parent', 'recovery', 'enforcement'] as const) {
      const owner = closedFeedOwner(actor);
      const batch = await captureClosedRealmFeedSources(owner.session, owner.sources);
      if (change === 'placement') owner.state.placement = 'replaced';
      if (change === 'approval' || change === 'preparation') owner.state[change] = false;
      if (change === 'parent') owner.state.parentHead = 'urn:rezics:revision:feed-parent:2';
      if (change === 'recovery') owner.state.generation = '1';
      if (change === 'enforcement') owner.state.enforcementCut = 'b'.repeat(64);
      await expect(batch.fence()).rejects.toBeInstanceOf(DisclosureUnavailable);
    }
  });
  test(`closed-feed-${actor}: restoration preserves independent Work and Content restrictions`, async () => {
    const owner = closedFeedOwner(actor);
    owner.state.closed = true;
    const closed = await captureClosedRealmFeedSources(owner.session, owner.sources);
    owner.state.closed = false;
    expect((await closed.fence()).map(source => source.id)).toEqual(owner.sources.filter(source => !source.realm).map(source => source.id));
    owner.state.workHidden = true;
    expect((await captureClosedRealmFeedSources(owner.session, owner.sources)).sources).toEqual([]);
    owner.state.workHidden = false;
    owner.state.contentHidden = true;
    expect((await captureClosedRealmFeedSources(owner.session, owner.sources)).sources).toEqual([]);
    owner.state.contentHidden = false;
    expect((await captureClosedRealmFeedSources(owner.session, owner.sources)).sources).toEqual(owner.sources);
  });
  test(`closed-feed-${actor}: closure in current source hydration is captured before selection`, async () => {
    const owner = closedFeedOwner(actor);
    owner.state.hydrate = () => { owner.state.closed = true; };
    const batch = await readClosedRealmFeedSources(owner.session, owner.sources);
    expect((await batch.fence()).map(source => source.id)).toEqual(owner.sources.filter(source => !source.realm).map(source => source.id));
  });
  test(`closed-feed-${actor}: closure omits adoption, decision, review and Content publication occurrences`, async () => {
    for (const kind of ['adoption', 'decision', 'review', 'contribution'] as const) {
      const owner = closedFeedOwner(actor);
      const source = owner.sources[0]!;
      source.kind = kind;
      source.reply = null;
      source.target = owner.work;
      if (kind === 'review') source.readerReview = { revision: 'review-revision', body: 'Review body' } as FeedSource['readerReview'];
      if (kind === 'contribution') source.contentTarget = owner.work;
      const captured = await captureClosedRealmFeedSources(owner.session, [source, owner.sources[1]!]);
      expect(captured.sources.length).toBe(2);
      owner.state.closed = true;
      expect((await captured.fence()).map(row => row.id)).toEqual([owner.sources[1]!.id]);
    }
  });
  for (const grain of ['work', 'realization', 'release', 'occurrence', 'resource'] as const) {
    test(`closed-feed-${actor}: ${grain} review keeps the target owner's parent chain`, async () => {
      const owner = closedFeedOwner(actor);
      owner.state.reviewGrain = grain;
      const source = owner.sources[0]!;
      source.kind = 'review';
      source.reply = null;
      source.target = source.work = grain === 'work' ? work : native(200);
      source.readerReview = { revision: 'review-revision', body: 'Review body', work: source.target,
        main_version: grain === 'work' ? native(201) : null } as FeedSource['readerReview'];
      const captured = await captureClosedRealmFeedSources(owner.session, [source]);
      expect(captured.sources).toEqual([source]);
      expect(owner.calls[0]?.targets[0]?.ancestry?.parents.map(parent => parent.resource))
        .toEqual(grain === 'resource' ? [realm] : [work, realm]);
      owner.state.closed = true;
      expect(await captured.fence()).toEqual([]);
    });
  }
  test(`closed-feed-${actor}: captured identity and review bytes survive caller mutation`, async () => {
    const owner = closedFeedOwner(actor);
    const original = owner.sources[1]!;
    original.kind = 'review';
    original.readerReview = { revision: 'review-revision', body: 'Original review' } as FeedSource['readerReview'];
    const source = { ...original, readerReview: { ...original.readerReview! } };
    const captured = await captureClosedRealmFeedSources(owner.session, [source]);
    source.actor = native(999);
    source.readerReview!.body = 'Changed review';
    const [safe] = await captured.fence();
    expect(safe?.actor).not.toBe(source.actor);
    expect(safe?.readerReview?.body).toBe('Original review');
  });
  test(`closed-feed-${actor}: captured Content bytes and reference survive caller mutation`, async () => {
    const owner = closedFeedOwner(actor);
    const source = owner.sources[0]!;
    source.publishedContent = { status: 'available', body: { content: { text: 'Admitted body' } },
      reference: { resourceId: source.reply, revisionId: 'revision-0', language: { kind: 'tag', tag: 'en' } } } as unknown as NonNullable<FeedSource['publishedContent']>;
    const original = structuredClone(source);
    const captured = await captureClosedRealmFeedSources(owner.session, [source]);
    (source.publishedContent.body.content as { text: string }).text = 'Changed body';
    source.publishedContent.reference.resourceId = native(999);
    expect(captured.sources).toEqual([original]);
    const delivered = await captured.fence();
    expect(delivered).toEqual([original]);
    expect(Object.isFrozen(delivered[0]?.publishedContent?.body.content)).toBe(true);
    expect(Object.isFrozen(delivered[0]?.publishedContent?.reference)).toBe(true);
  });
  test(`closed-feed-${actor}: a closure that moves the Access cut discards hydration and originals remain on retry`, async () => {
    const owner = closedFeedOwner(actor);
    const captured = await captureClosedRealmFeedSources(owner.session, owner.sources);
    owner.state.closed = true;
    owner.state.enforcementCut = 'b'.repeat(64);
    await expect(captured.fence()).rejects.toBeInstanceOf(DisclosureUnavailable);
    const retried = await captureClosedRealmFeedSources(owner.session, owner.sources);
    expect((await retried.fence()).map(source => source.id)).toEqual(owner.sources.filter(source => !source.realm).map(source => source.id));
  });
  test(`closed-feed-${actor}: incomplete exact revision and oversized or duplicate batches are unavailable`, async () => {
    const owner = closedFeedOwner(actor);
    const incomplete = { ...owner.sources[0]!, contentRevision: null };
    await expect(captureClosedRealmFeedSources(owner.session, [incomplete])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(captureClosedRealmFeedSources(owner.session, [owner.sources[0]!, owner.sources[0]!])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(captureClosedRealmFeedSources(owner.session, Array.from({ length: 21 }, (_, index) => ({ ...owner.sources[1]!, id: native(100 + index) }))))
      .rejects.toBeInstanceOf(DisclosureUnavailable);
    expect(owner.calls.length).toBe(0);
    const empty = await captureClosedRealmFeedSources(owner.session, []);
    expect(empty.sources).toEqual([]);
    expect(await empty.fence()).toEqual([]);
  });
}

closedFeedCases('anonymous');
