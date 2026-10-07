import { expect, test } from 'bun:test';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';
import { resolveParagraphSelector, type ContentComment } from '../../content/src/comments.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { hash } from '../src/modules/work/activate.ts';

const id = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const revision = id(1), work = `https://rezics.com/id/${id(2)}`, actor = `https://rezics.com/id/${id(3)}`;
const variant = `urn:rezics:variant:${id(4)}`, assessment = id(5), commentId = id(6);
const secret = 'private pinned content must not escape the delivery fence';
const annotation = 'private annotation must not escape the delivery fence';
const text = `Opening paragraph\n${secret}\nClosing paragraph`;
const serializedJson = JSON.stringify({ body: text });
const sourcePosition = { owner: 'content' as const, dataEpoch: id(7), sequence: '2' };
type Surface = 'revision' | 'comment' | 'comment-page';

class ContentGraph extends FusekiClient {
  erased = false;
  scans = 0;
  constructor() { super('http://content-custody.invalid'); }
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('SELECT ?target WHERE') && query.includes('rv:ErasedRevision')) {
      this.scans++;
      return { results: { bindings: this.erased ? [{ target: { type: 'uri',
        value: `urn:rezics:content:revision:${revision}` } }] : [] } };
    }
    if (query.includes('ASK')) return { boolean: true };
    throw new Error(`unexpected Content delivery fixture query: ${query.slice(0, 80)}`);
  }
}

function fixture() {
  const graph = new ContentGraph();
  const state = { held: false, rightsCalls: 0 };
  let enterRights!: () => void, releaseRights!: () => void;
  const rightsEntered = new Promise<void>(resolve => { enterRights = resolve; });
  const rightsReleased = new Promise<void>(resolve => { releaseRights = resolve; });
  const exact: ExactReadResult = { revisionId: revision, status: 'available', serializedJson, body: { body: text },
    reference: { owner: 'content', resourceId: work, variantId: variant, revisionId: revision,
      format: 'rezics-content-json-v1', model: 'content-shape-v1', byteDigest: hash(serializedJson),
      byteLength: Buffer.byteLength(serializedJson), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', sourceRevision: null, predecessor: null,
      provenance: { kind: 'admitted-public-domain-v1', rightsAssessmentId: assessment } } };
  const comment: ContentComment = { type: 'Annotation', motivation: 'commenting',
    comment: `https://rezics.com/id/${commentId}`, author: actor, resourceId: work,
    variantId: variant, revisionId: revision, byteDigest: exact.reference.byteDigest, body: annotation,
    target: { type: 'SpecificResource', source: `urn:rezics:content:revision:${revision}`,
      selector: resolveParagraphSelector(text, secret) }, sourcePosition, replayed: false };
  const content = { owningResourceForRevision: async (wanted: string) => wanted === revision ? work : null,
    readExactBatch: async (wanted: string[], authorize: Parameters<ContentCore['readExactBatch']>[1]) => {
      const allowed = await authorize(wanted);
      return wanted.map(revisionId => allowed.has(revisionId) && revisionId === revision ? exact
        : { revisionId, status: 'denied' as const });
    } } as unknown as ContentCore;
  const assertRecoveryOpen = async () => {
    if (state.held) throw new AdmissionUnavailable('Access is held for recovery');
  };
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/erasure-custody-tests',
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
  account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
  access: { assertRecoveryOpen, canReadWork: async (_principal: unknown, subject: string, resource: string) => {
    await assertRecoveryOpen();
    return subject === actor && resource === work;
  } }, content,
  comments: { read: async (wanted: string) => wanted === commentId ? comment : null,
    list: async () => ({ revisionId: revision, comments: [comment], sourcePosition, next: null }) },
  rights: { store: { currentPublicDomainAssessment: async (resource: string, rightsAssessment: string) => {
    expect(resource).toBe(work);
    expect(rightsAssessment).toBe(assessment);
    state.rightsCalls++;
    enterRights();
    await rightsReleased;
    return true;
  } } } } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  const read = (surface: Surface) => app.handle(new Request(`http://main.local${surface === 'comment'
    ? `/v1/content-comments/${commentId}` : `/v1/content-revisions/${revision}${surface === 'comment-page' ? '/comments' : ''}`}`
    + `?actingSubject=${encodeURIComponent(actor)}`, { headers: { authorization: 'Bearer admitted-reader' } }));
  return { graph, state, exact, comment, read, rightsEntered, releaseRights };
}

for (const surface of ['revision', 'comment', 'comment-page'] as const) {
  test(`OPS12: the ${surface} HTTP read delivers coherent exact public-domain Content while both gates stay open`, async () => {
    const f = fixture();
    const pending = f.read(surface);
    await f.rightsEntered;
    expect(f.graph.scans).toBe(1);
    f.releaseRights();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    if (surface === 'revision') expect(result).toMatchObject({ serializedJson, body: { body: text } });
    else if (surface === 'comment') expect(result).toMatchObject({ body: annotation, resolvedText: secret });
    else expect(result).toMatchObject({ comments: [{ body: annotation, resolvedText: secret }], next: null });
    expect(f.state.rightsCalls).toBe(1);
  });

  test(`OPS12: Access closure during the ${surface} rights read withholds exact Content and annotation bytes`, async () => {
    const f = fixture();
    const pending = f.read(surface);
    await f.rightsEntered;
    f.state.held = true;
    f.releaseRights();
    const response = await pending;
    expect(response.status).toBe(503);
    const result = await response.text();
    expect(result).not.toContain(secret);
    expect(result).not.toContain(annotation);
    expect(result).not.toContain('serializedJson');
  });

  test(`OPS12: graph suppression during the ${surface} rights read hides still-retained Content and annotations`, async () => {
    const f = fixture();
    const pending = f.read(surface);
    await f.rightsEntered;
    f.graph.erased = true;
    f.releaseRights();
    const response = await pending;
    expect(response.status).toBe(404);
    const result = await response.text();
    expect(result).not.toContain(secret);
    expect(result).not.toContain(annotation);
    expect(result).not.toContain('serializedJson');
    expect(f.exact.serializedJson).toBe(serializedJson);
    expect(f.comment.body).toBe(annotation);
  });
}
