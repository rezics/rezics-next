import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, configureDisclosureAncestrySource,
  type DisclosureAncestryEvidence, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import type { MetadataBasis, MetadataRef } from '../src/modules/media/presentation.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { mediaRoutes } from '../src/routes/media.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iri = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const asset = uuid(1), representation = uuid(2), use = uuid(3), independent = uuid(4);
const target = iri(5), actor = iri(6), selection = uuid(7);
const payload = new Uint8Array([1, 2, 3]), digest = 'a'.repeat(64), etag = `"${digest}"`;
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
type Surface = 'bare' | 'exact' | 'use' | 'avatar' | 'agent-avatar' | 'private' | 'unattached' | 'original' | 'owner';

function fixture(surface: Surface) {
  const state = { hidden: false, closed: false, reads: 0, opening: 0, closing: 0, fallback: false,
    afterOpening: () => {} };
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const graph = { query: async (query: string) => {
    if (query.includes('ASK')) return { boolean: true };
    const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
      .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('1') };
      return { results: { bindings: [control, ...refs('r').map(reference => ({ ...control,
        r: uri(reference), type: term('work'), work: uri(reference), head: uri(reference),
        public: term('true'), label: { ...term('Image target'), 'xml:lang': 'en' } }))] } };
    }
    if (query.includes('SELECT ?work ?head')) return { results: { bindings: refs('work').map(reference => ({
      work: uri(reference), head: uri(reference), owningWork: uri(reference), owningHead: uri(reference),
    })) } };
    if (query.includes('SELECT ?resource ?head')) return { results: { bindings: refs('resource').map(reference => ({
      resource: uri(reference), head: uri(reference),
    })) } };
    if (query.includes('SELECT ?avatar')) return { results: { bindings: surface === 'agent-avatar'
      ? [{ avatar: term(selection) }] : [] } };
    if (query.includes('SELECT ?agent')) return { results: { bindings: [{ agent: uri(target) }] } };
    if (query.includes('SELECT ?epoch ?hold ?context'))
      return { results: { bindings: [] } };
    if (query.includes('SELECT ?epoch ?sequence ?hold WHERE')) return { results: { bindings: [
      { epoch: term('epoch'), sequence: term('1') },
    ] } };
    throw new Error(`Unexpected graph query: ${query.slice(0, 160)}`);
  } } as unknown as FusekiClient;
  const environment = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/media-delivery-revocation' };
  configureFixtureDisclosureAncestry(environment, item => {
    const resource = item.work ?? (item.owner === 'graph' ? item.resource : undefined);
    return resource ? { resource, head: resource, ...(item.workRevision !== undefined
      ? { protectedRevision: item.workRevision } : {}) } : undefined;
  });
  const selected = new Map<string, DisclosureTarget>();
  const evidence = (item: DisclosureTarget): DisclosureAncestryEvidence => {
    const relationshipBasis = { owner: 'media' as const, kind: item.occurrence ? 'media-use' as const : 'publication' as const,
      resource: item.occurrence?.resource ?? item.resource, revision: item.occurrence?.revision ?? 'publication:1',
      targetResource: item.resource, targetRevision: item.revision ?? null, dataEpoch: 'epoch',
      token: createHash('sha256').update(JSON.stringify(item)).digest('hex') };
    selected.set(relationshipBasis.token, item);
    const readableIndependent = item.occurrence?.resource === iri(4) || item.resource === iri(4);
    const realm = { owner: 'graph' as const, kind: 'realm' as const, resource: iri(8), head: iri(8), relationshipBasis };
    return { resource: item.resource, resourceKind: 'other', relationshipBasis, status: 'complete',
      parents: readableIndependent ? [] : item.work ? [{ owner: 'graph', kind: 'work', resource: item.work,
        head: item.work, relationshipBasis }, realm] : [realm] };
  };
  configureDisclosureAncestrySource(environment, 'media', {
    read: async items => items.map(evidence),
    reread: async bases => bases.map(basis => evidence(selected.get(basis.token)!)),
  });
  configureDisclosure(environment, fixtureDisclosureReader(async targets => {
    if (state.reads) state.closing++; else state.opening++;
    return targets.map(item => state.hidden && item.resource === iri(1)
      || state.closed && item.ancestry?.parents.some(parent => parent.kind === 'realm' && parent.resource === iri(8))
      ? 'hidden' : 'visible');
  }));
  const privateRead = surface === 'private' || surface === 'unattached' || surface === 'original' || surface === 'owner';
  const metadata = (reference: MetadataRef): MetadataBasis | null => {
    if ('representation' in reference && !reference.use && state.fallback) return null;
    return { owner: actor, actor, target: privateRead && surface !== 'unattached' ? target : null, context: DEFAULT_MEDIA_CONTEXT,
      disclosure: privateRead ? 'private' : 'public', objectNamespace: 'media', byteLength: payload.length,
      metadata: { asset, representation, use: 'representation' in reference ? reference.use ?? null : use,
        sha256: digest, mediaType: 'image/png', controls: { nsfw: {}, ageRating: {}, conceal: null } },
    } as MetadataBasis;
  };
  const delivery = { owner: actor, uploader: 'principal', asset, representation, use, target,
    context: DEFAULT_MEDIA_CONTEXT, objectNamespace: 'media', sha256: digest, mediaType: 'image/png',
    byteLength: payload.length, availability: 'available', disclosure: privateRead ? 'private' : 'public',
    moderation: 'none', lifecycle: 'active', clearance: 'cleared', role: 'image', width: 100, height: 100 };
  const finished: string[] = [];
  const deps = { environment,
    account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: { canManageMedia: async () => surface === 'private' || surface === 'unattached' || surface === 'owner',
      canReadAsBaselineMember: async () => false, canReadWork: async () => true,
      canActAsPlatformAdministrator: async () => true, activePrincipalId: async () => 'principal',
      canProtectMedia: async () => { state.afterOpening(); return false; } },
    media: { store: { presentation: { metadata: async (refs: MetadataRef[]) => refs.map(metadata),
      representationUses: async () => [use, independent] }, itemDelivery: async () => delivery,
      avatarDelivery: async () => delivery, assetDelivery: async () => delivery },
    objects: () => ({ get: async () => { state.reads++; entered(); await resumed; return payload; } }) },
    downloadLeases: { admit: async () => ({ id: 'lease' }), begin: async () => {},
      finish: async (_id: string, outcome: string) => { finished.push(outcome); } },
  } as unknown as MainWorkDependencies;
  const app = mediaRoutes(graph, deps);
  const path = surface === 'avatar' || surface === 'agent-avatar' ? `/v1/media/avatars/${selection}`
    : surface === 'use' ? `/v1/media/uses/${use}`
    : surface === 'original' || surface === 'owner' ? `/v1/media/assets/${asset}/bytes?target=${target}&actingSubject=${actor}`
    : `/v1/media/representations/${representation}/bytes${surface === 'bare' ? '' : `?use=${use}`}${surface === 'private' || surface === 'unattached' ? `&actingSubject=${actor}` : ''}`;
  const get = (validator?: string, url = path, signed = false) => app.handle(new Request(`http://main.local${url}${signed
    ? `${url.includes('?') ? '&' : '?'}actingSubject=${actor}` : ''}`, { headers: {
    ...(privateRead || signed ? { authorization: 'Bearer reader' } : {}), ...(validator ? { 'if-none-match': validator } : {}),
  } }));
  return { state, get, reading, resume, finished };
}

async function absent(response: Response) {
  expect(response.status, await response.clone().text()).toBe(404);
  expect(response.headers.get('etag')).toBeNull();
  expect(response.headers.get('cache-control')).not.toContain('public');
  expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(payload);
}

for (const surface of ['bare', 'exact', 'use', 'avatar', 'agent-avatar', 'private', 'unattached', 'original', 'owner'] as const) {
  for (const revocation of ['asset', 'realm'] as const) {
    test(`${surface} discards buffered bytes after ${revocation} disclosure is revoked`, async () => {
      const f = fixture(surface);
      f.state.fallback = surface === 'bare';
      const response = f.get();
      await Promise.race([f.reading, response.then(async result => {
        if (!f.state.reads) throw new Error(`Read ended before object retrieval: ${result.status} ${await result.text()}`);
      })]);
      expect(f.state.opening).toBeGreaterThan(0);
      if (revocation === 'asset') f.state.hidden = true; else f.state.closed = true;
      f.resume();
      await absent(await response);
      expect(f.state.reads).toBe(1);
      expect(f.state.closing).toBeGreaterThan(0);
      if (surface === 'private' || surface === 'original') expect(f.finished).toEqual(['aborted']);
      if (revocation === 'realm' && surface === 'bare') {
        const control = await f.get(undefined, `/v1/media/representations/${representation}/bytes?use=${independent}`);
        expect(control.status).toBe(200);
        expect(new Uint8Array(await control.arrayBuffer())).toEqual(payload);
      }
    });
  }
  for (const validator of [etag, `"other", W/${etag}`, '*']) {
    test(`${surface} refuses a revoked cached response for ${validator}`, async () => {
      const f = fixture(surface); f.resume();
      const first = await f.get();
      expect(first.status).toBe(200);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);
      f.state.hidden = true;
      await absent(await f.get(validator));
    });
  }
}

for (const surface of ['bare', 'exact', 'use', 'avatar'] as const) {
  test(`${surface} retains public bytes and conditional 304 while disclosure remains readable`, async () => {
    const f = fixture(surface); f.resume();
    expect((await f.get()).headers.get('cache-control')).toBe('public, no-cache');
    const response = await f.get(etag);
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(etag);
    expect(await response.text()).toBe('');
    expect(f.state.reads).toBe(1);
  });
}

for (const surface of ['bare', 'exact', 'use'] as const) {
  test(`${surface} discards a matching validator when disclosure is revoked after the opening decision`, async () => {
    const f = fixture(surface);
    // Editorial controls are assembled after opening disclosure. Revoke while
    // that owner lookup awaits, when a 304 will skip object retrieval entirely.
    f.state.afterOpening = () => { f.state.hidden = true; };
    await absent(await f.get(etag, undefined, true));
    expect(f.state.reads).toBe(0);
  });
}
