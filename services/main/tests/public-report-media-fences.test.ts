import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { ContentCore } from '../../content/src/core.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { publicReportOwners } from '../src/modules/public-report/owners.ts';
import { WorkReadMoved } from '../src/modules/work/read-session.ts';

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const resource = `https://rezics.com/id/${uuid(1)}`;
function fixture() {
  const state = { disclosure: 'public', lifecycle: 'active', draft: uuid(2),
    otherDraft: uuid(3), sequence: 1, reads: 0, recoveryChecks: 0 };
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('SELECT a.id::text, v.draft_head::text')) {
      state.reads++;
      const requested = args![0] as string[];
      return { rows: state.disclosure === 'public' && state.lifecycle === 'active' && requested.includes(uuid(1))
        ? [{ id: uuid(1), draft_head: state.draft }] : [], rowCount: 1 };
    }
    if (sql === 'SELECT owner FROM media.asset WHERE id = $1') return {
      rows: [{ owner: `https://rezics.com/id/${uuid(4)}` }], rowCount: 1,
    };
    if (sql.includes('content.reply_author')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected report SQL: ${sql}`);
  } } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid/public-report-media');
  graph.query = async body => {
    if (body.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{
      epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: String(state.sequence) },
    }] } };
    if (body.includes('SELECT DISTINCT ?zone ?head ?typed') || body.includes('SELECT DISTINCT ?resource ?revision') || body.includes('SELECT ?r ?revision ?type') || body.includes('SELECT ?r ?mergedInto')
      || body.includes('SELECT ?author ?realm')) return { results: { bindings: [] } };
    throw new Error(`Unexpected report graph read: ${body}`);
  };
  let afterEvidenceRead: () => void = () => {};
  const core = { readExactBatch: async (revisions: string[]) => {
    const rows = revisions.map(revision => ({ status: 'available', reference: {
      resourceId: resource, revisionId: revision, byteDigest: 'a'.repeat(64), format: 'media-set-v1',
    } }));
    afterEvidenceRead();
    return rows;
  } } as unknown as ContentCore;
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/public-report-media-fences',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {
    assertRecoveryOpen: async () => { state.recoveryChecks++; },
  } } as unknown as MainWorkDependencies;
  const owner = publicReportOwners(deps, pool, core);
  const resolve = () => owner.resolve({ profile: 'public-report-v1', category: 'credible_threat', target: resource,
    statement: 'Selected media context', contentLanguage: 'en' },
  new Request('http://main.test/v1/public-reports', { method: 'POST' }), null);
  return { state, resolve, mutate: (change: () => void) => { afterEvidenceRead = change; } };
}

for (const changed of ['lifecycle', 'disclosure', 'draft head'] as const) {
  test(`report delivery refuses selected media ${changed} movement after exact evidence hydration`, async () => {
    const f = fixture();
    f.mutate(() => {
      if (changed === 'lifecycle') f.state.lifecycle = 'deleted';
      if (changed === 'disclosure') f.state.disclosure = 'private';
      if (changed === 'draft head') f.state.draft = uuid(5);
      f.state.sequence++;
    });
    await expect(f.resolve()).rejects.toBeInstanceOf(WorkReadMoved);
    expect(f.state.reads).toBe(2);
    expect(f.state.recoveryChecks).toBe(1);
  });
}

test('report delivery keeps exact selected evidence when another asset draft and dataset position change', async () => {
  const f = fixture();
  f.mutate(() => { f.state.otherDraft = uuid(5); f.state.sequence++; });
  const resolved = await f.resolve();
  expect(resolved.evidence).toMatchObject({ resource, revision: uuid(2), state: 'available' });
  expect(f.state.reads).toBe(2);
  expect(f.state.recoveryChecks).toBe(1);
});
