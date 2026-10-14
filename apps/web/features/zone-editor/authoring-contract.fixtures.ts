import { documentText, fromPlainText } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { collectionPreview } from './home-modules.fixtures.ts';

/** Contract-built states awaiting prove-phase recording. No recorded answer is edited here. */
export type AuthoringContractState = 'saved' | 'empty' | 'loading' | 'unavailable' | 'retired' | 'recovered'
  | 'revoked-member' | 'revoked-moderator' | 'restored' | 'operator-without-agent' | 'operator-mandate'
  | 'pending-save' | 'pending-publication' | 'replayed-after-competition';
const id = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const iri = (tail: number) => `https://rezics.com/id/${id(tail)}`;
export const contractZoneId = id(1101);
export const contractSpaceId = id(1102);
export const contractSavingAgent = iri(1103);
export const contractDocument = fromPlainText('Saved by the original Agent. 雨夜の庭。', 'blocks');
export const contractUnsavedDocument = fromPlainText('The next saved Agent garden.', 'blocks');
export const contractSavedAfterEdit = { revisionId: id(1122), byteDigest: 'ef'.repeat(32), contentEpoch: id(1123) };
export const contractBasis = { revisionId: id(1105), byteDigest: 'ab'.repeat(32), contentEpoch: id(1106) };
export const contractHome = iri(1104);
export const contractVariant = `urn:rezics:variant:${id(1107)}`;
export const contractHead = iri(1108);
export const contractNextHead = iri(1109);
export const contractNavigation = iri(1110);
export const contractCompetingRevision = id(1111);
export const contractPending = { operationId: id(1112), status: 'reconciling', phase: 'projection',
  result: null, retry: { allowed: true, afterMs: 100 } };
export const contractProvenance = { kind: 'admitted-original-contribution-v1', rightsBasis: 'original-contribution',
  author: contractSavingAgent, scope: `content:draft:${contractHome}` };

export function contractManagementKey(state: AuthoringContractState): string {
  return state.startsWith('revoked-') || state === 'operator-without-agent' ? contractSpaceId : contractZoneId;
}

export function contractActor(state: AuthoringContractState): string {
  return state.startsWith('operator-') ? iri(1113) : state === 'revoked-member' ? iri(1114)
    : state === 'revoked-moderator' ? iri(1115) : contractSavingAgent;
}

/** Exact request/state inventory for the prove phase, including both independent authority requirements. */
export function authoringContractRequests(state: AuthoringContractState) {
  const actingSubject = contractActor(state);
  const root = `/v1/zones/${contractZoneId}`;
  const query = `?actingSubject=${encodeURIComponent(actingSubject)}`;
  const selectedPage = { page: contractHome, variantId: contractVariant, ...contractBasis };
  return {
    source: 'contract-built; not recorded', state, actingSubject,
    authority: state === 'operator-mandate' ? { resource: `zone:edit:${iri(1101)}`, agent: actingSubject, live: true }
      : state === 'operator-without-agent' ? { resource: `zone:edit:${iri(1101)}`, agent: null, live: false }
      : { resource: iri(1101), agent: actingSubject, live: !state.startsWith('revoked-') },
    saved: { page: selectedPage, document: contractDocument, provenance: contractProvenance },
    reads: [
      { method: 'GET', path: `/v1/zones/${contractManagementKey(state)}/configuration${query}` },
      ...(state === 'retired' ? [] : [{ method: 'GET', path: `/v1/addresses/resolve?scope=space&key=${contractSpaceId}&actingSubject=${encodeURIComponent(actingSubject)}` }]),
      ...(contractManagementKey(state) === contractSpaceId ? [{ method: 'GET', path: `${root}/configuration${query}` }] : []),
      { method: 'GET', path: `${root}/showcase-editor${query}` },
      { method: 'GET', path: `${root}${query}` },
      { method: 'GET', path: `${root}${query}&limit=50` },
    ],
    writes: [
      { method: 'POST', path: '/v1/content-drafts', body: { profile: 'content-text-v1', resourceId: contractHome,
        variantId: contractVariant, expectedHead: contractBasis.revisionId, language: { kind: 'tag', tag: 'ja', originalTag: 'ja' },
        direction: direction('ja', documentText(state === 'pending-save' ? contractUnsavedDocument : contractDocument)), document: state === 'pending-save' ? contractUnsavedDocument : contractDocument, actingSubject } },
      { method: 'POST', path: `${root}/site-publications`, body: { expectedHead: contractHead,
        routesRevision: contractNavigation, navigationRevision: contractNavigation, pages: [selectedPage], actingSubject } },
      ...(['retirements', 'recoveries'] as const).map(action => ({ method: 'POST', path: `${root}/${action}`,
        body: { expectedHead: contractHead, actingSubject } })),
    ] as const,
  };
}

/** Typed transport at the production reader boundary, with every call available to interaction assertions. */
export function authoringContractClient(state: AuthoringContractState) {
  const manifest = authoringContractRequests(state);
  const actor = manifest.actingSubject;
  const denied = state.startsWith('revoked-') || state === 'operator-without-agent';
  const preview = collectionPreview();
  preview.presentation.modules = [];
  preview.presentation.navigation = [];
  delete preview.presentation.official;
  preview.moduleData = [];
  preview.navigation = { navigation: iri(1116), revision: contractNavigation, mounts: [], next: null,
    sourcePosition: { datasetId: 'product', dataEpoch: id(1117), sequence: '7' } };
  preview.page = state === 'empty' ? null : { document: contractDocument, definitions: [], blocks: [], showcases: [],
    showcaseData: { slides: [], slideMedia: [] },
    cost: { nodesVisited: 3, extensions: 0, showcases: 0, responseBytes: 512, graphReads: 0, definitionExecutions: 0 } };
  preview.publicationStatus = state === 'empty' ? 'private' : 'behind';
  const configuration = { zone: iri(1101), space: iri(1102), state: state === 'retired' ? 'retired' : 'active',
    homeDocument: contractHome, presentation: preview.presentation };
  const configured = { zone: iri(1101), revision: contractHead, name: 'Retained Agent garden', language: 'ja', direction: direction('ja', 'Retained Agent garden'),
    configuration, cost: { graphReads: 1, objectReads: 1 } };
  const receipt = { ...manifest.writes[1]!.body, outcome: 'succeeded', zone: iri(1101), revision: contractNextHead,
    themeRevision: contractHead, homeDocument: contractHome, homeRevision: iri(1118),
    receipt: id(1119), admissionId: id(1120), requestDigest: 'cd'.repeat(32), authorityEpoch: id(1121),
    scope: `zone:edit:${iri(1101)}`, dataEpoch: id(1117), sequence: '8', replayed: true,
    pages: [{ ...manifest.saved.page, language: 'ja' }] };
  const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  let savedBasis = contractBasis;
  let savedDocument = contractDocument;
  let pending = state.startsWith('pending-');
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.slice(BFF_PREFIX.length);
    const body: unknown = request.method === 'GET' ? null : await request.json();
    calls.push({ method: request.method, path: path + url.search, body, key: request.headers.get('idempotency-key') });
    if (state === 'loading') return new Promise<Response>(() => {});
    if ((request.method === 'GET' ? url.searchParams.get('actingSubject') : (body as { actingSubject?: string })?.actingSubject) !== actor) {
      throw new Error(`Contract request lost its acting Agent: ${request.url}`);
    }
    const problem = (status: number, code: string, title: string) => Response.json({ type: 'about:blank', status, code, title }, { status });
    if (state === 'unavailable') return problem(503, 'zone_unavailable', 'Zone is unavailable');
    if (path === '/v1/addresses/resolve' && url.searchParams.get('key') !== contractSpaceId) {
      throw new Error('A Zone identifier cannot manufacture a Space capability');
    }
    if (path === '/v1/addresses/resolve') return Response.json({ profile: 'address-resolution-v1', status: 'resolved',
      scope: 'space', key: url.searchParams.get('key'), state: 'current', holder: iri(1102),
      canonical: { prefix: '/z/', key: 'agent-garden', suffixSource: '' }, capabilities: { zone: iri(1101) } });
    if (denied) return problem(request.method === 'GET' ? 404 : 403, 'zone_unavailable', 'Zone is unavailable');
    if (request.method === 'GET') {
      if (path.endsWith('/configuration')) return Response.json(configured);
      if (path.endsWith('/showcase-editor')) return Response.json({ ...configured, preview, slideMedia: [],
        draft: { variantId: contractVariant, revisionId: state === 'empty' ? null : savedBasis.revisionId,
          document: state === 'empty' ? null : savedDocument, byteDigest: state === 'empty' ? null : savedBasis.byteDigest,
          language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: direction('ja', documentText(savedDocument)), editable: true,
          sourcePosition: { owner: 'content', dataEpoch: savedBasis.contentEpoch, sequence: '4' } },
        publishedPage: state === 'empty' ? null : { page: contractHome, variantId: contractVariant,
          revisionId: contractCompetingRevision } });
      if (path === `/v1/zones/${contractZoneId}`) return Response.json({ ...preview.navigation, ownerRevision: contractHead });
    } else {
      const expected = manifest.writes.find(item => item.path === path);
      if (!expected || !body || typeof body !== 'object' || !calls.at(-1)!.key) throw new Error(`Unknown contract command: ${path}`);
      if ((body as { expectedHead?: unknown }).expectedHead !== contractHead && path !== '/v1/content-drafts') {
        return problem(409, 'stale_zone_head', 'Zone changed');
      }
      if (pending) { pending = false; return Response.json(contractPending, { status: 202 }); }
      if (path.endsWith('/site-publications')) return Response.json(receipt);
      if (path === '/v1/content-drafts') {
        savedBasis = contractSavedAfterEdit;
        savedDocument = (body as { document: typeof contractDocument }).document;
        return Response.json({ ...savedBasis,
          sourcePosition: { owner: 'content', dataEpoch: savedBasis.contentEpoch, sequence: '5' }, replayed: true });
      }
      return Response.json({ zone: iri(1101), revision: contractNextHead, replayed: true });
    }
    throw new Error(`Unspecified contract request: ${request.method} ${path}`);
  }) as typeof fetch;
  return { main: browserMainApi('https://contract.invalid', { fetcher }), manifest, calls, receipt };
}
