import { expect, test } from 'bun:test';
import { randomUUID, randomInt } from 'node:crypto';
import { importedRightsAssessments } from '../../../services/main/src/modules/rights/import-policy.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import type { StoredSourceRow } from '../../../services/main/src/modules/library-import/file-store.ts';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
const id = () => `https://rezics.com/id/${randomUUID()}`;

test('a MAL reader matches by admitted identity alongside ISBN and VNDB, and reviewed source adoption retains binding rights', async () => {
  const stack = await startMediaStack('library-identifiers', { library: true });
  const reader = await stack.member('library-reader');
  const other = await stack.member('other-reader');
  const workId = `OL${randomInt(1, 1_000_000_000_000)}W`;
  let sourceCalls = 0;
  const runtime = await composeMain({ config: stack.composition.config, fuseki: stack.fuseki,
    accessPool: stack.accessPool, contentPool: stack.contentPool, relayPool: stack.composition.relayPool,
    erasureRelayPool: stack.composition.relayPool, ownerRelayPool: stack.composition.relayPool,
    recommendationRelayPool: stack.composition.relayPool,
    overrides: { account: { verify: async (request, scopes) => {
      const principal = await stack.composition.dependencies.account.verify(request, scopes);
      const consent = { accountScopes: ['work:read', 'work:create', 'library:write'] };
      return { ...principal, ...consent, currentAssertion: async () => ({
        ...await principal.currentAssertion?.(), ...principal, ...consent,
      }) };
    } }, dependencies: {
      openLibraryFetch: (async (url: string) => {
        sourceCalls++;
        if (new URL(url).pathname === '/search.json') return Response.json({ docs: [
          { key: `/works/${workId}`, title: 'Retained source title', author_name: [] },
        ] });
        expect(url).toBe(`https://openlibrary.org/works/${workId}.json`);
        return Response.json({ key: `/works/${workId}`, type: { key: '/type/work' },
          title: 'Retained source title', authors: [], revision: 7 });
      }) as typeof fetch,
    } } });
  const call = (method: string, path: string, body?: object, key = randomUUID(), token = reader.token) =>
    runtime.app.handle(new Request(`http://main.local${path}`, { method, headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    const { agent } = await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Library reader',
    }), 201);
    const grant = async (scope: string, action: string) => {
      const client = await stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await grantFixtureAuthority(client, { scope, requireDispatch: true,
          representations: [{ principalId: reader.principalId, actor: agent, action, lifetime: '8 hours' }],
          grant: { actor: agent, action, lifetime: '8 hours' } });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    await grant('work:create:root', 'work.create');
    const upload = async (format: string, file: string) => json<{ id: string }>(await call('POST',
      '/v1/me/library-imports', { actingSubject: agent, format, file }), 201);
    const rows = async (file: string) => json<{ rows: StoredSourceRow[] }>(await call('GET',
      `/v1/me/library-imports/${file}/rows?actingSubject=${encodeURIComponent(agent)}`));
    // Source acquisition is explicit. The MAL consumer below uses this same
    // native Work; its licence comes from the bound Source, not its list ID.
    const sourceRow = emptyRow('source', 'Retained source title', {});
    const sourceFile = await upload('rezics', JSON.stringify({ profile: 'rezics-library-export-v1', rows: [sourceRow] }));
    expect((await rows(sourceFile.id)).rows[0]?.match?.openLibrary[0]?.workId).toBe(workId);
    const adoptionKey = randomUUID();
    const adopt = () => call('POST', `/v1/me/library-imports/${sourceFile.id}/rows/0/adoptions`, {
      actingSubject: agent, workId, titleLanguage: 'en',
    }, adoptionKey);
    const adopted = await json<{ work: string; replayed: boolean }>(await adopt());
    // Both identifier-grain cases cover the same exact immutable realization.
    // The reader's title intentionally differs, so title matching cannot prove this.
    const native = { work: adopted.work };
    await grant(`work:edit:${native.work}`, 'work.edit');
    const realization = id(), release = id();
    const saved = await json<{ revision: string }>(await call('PUT',
      `/v1/works/${native.work.slice(-36)}/realizations/${realization.slice(-36)}`, {
        profile: 'realization-v1', expectedHead: null, actingSubject: agent, id: realization,
        language: 'ja', kind: 'original', translators: [], publishers: [],
        source: { kind: 'unresolved', work: native.work }, status: 'official', verification: 'verified', evidence: `https://openlibrary.org/works/${workId}`,
      }));
    const mal = String(randomInt(1, 1_000_000_000)), vn = `v${randomInt(1, 1_000_000_000)}`;
    await json(await call('PUT', `/v1/works/${native.work.slice(-36)}/releases/${release.slice(-36)}`, {
      profile: 'release-v2', expectedHead: null, actingSubject: agent, id: release, kind: 'formal',
      status: 'official', title: { value: 'Edition evidence title', language: 'en' }, titleLanguage: 'en',
      tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: null,
      isbn13: '9780306406157', originalUrl: null, fixedRelease: null, evidence: null,
      platform: null, territory: null,
      identifiers: [{ provider: 'https://myanimelist.net/anime', value: mal },
        { provider: 'https://vndb.org/vn', value: vn }],
      coverage: [{ realization, revision: saved.revision, completeness: 'complete' }],
    }));
    const imported = await upload('mal', `<myanimelist><anime><series_animedb_id>${mal}</series_animedb_id>
      <series_title>My exported title</series_title><my_status>Completed</my_status>
      <my_comments>Private reader evidence</my_comments></anime></myanimelist>`);
    const malRows = await rows(imported.id);
    expect(malRows.rows[0]?.match).toMatchObject({ kind: 'matched', work: native.work, target: null });
    expect(malRows.rows[0]?.source.creators).toEqual([]);
    expect(sourceCalls).toBe(2);
    const identified = [emptyRow('isbn', 'Personal edition title', {}), emptyRow('vn', 'Personal VN title', {})];
    identified[0]!.identifiers = [{ provider: 'isbn13', value: '9780306406157' }];
    identified[1]!.identifiers = [{ provider: 'https://vndb.org/vn', value: vn }];
    const legacy = await upload('rezics', JSON.stringify({ profile: 'rezics-library-export-v1', rows: identified }));
    const legacyRows = await rows(legacy.id);
    expect(legacyRows.rows.map(row => [row.match?.kind, row.match?.work, row.match?.target]))
      .toEqual([['matched', native.work, release], ['matched', native.work, null]]);
    expect((await call('GET', `/v1/me/library-imports/${imported.id}/rows?actingSubject=${encodeURIComponent(agent)}`,
      undefined, randomUUID(), other.token)).status).toBe(403);
    await json(await call('PUT', `/v1/me/library-imports/${imported.id}/rows/0`, {
      actingSubject: agent, expectedVersion: malRows.rows[0]!.version, choice: 'apply', work: native.work,
    }));

    const evidence = await stack.contentPool.query<{ id: string; evidence: { provider: string; sourceUrl: string } }>(`
      SELECT a.id, a.evidence FROM rights.use_assessment a JOIN rights.material m ON m.id = a.material_id
      WHERE m.work_id = $1 ORDER BY a.id`, [adopted.work]);
    expect(evidence.rows).toHaveLength(6);
    expect(evidence.rows.every(row => row.evidence.provider === 'open-library'
      && row.evidence.sourceUrl === `https://openlibrary.org/works/${workId}`)).toBe(true);
    expect(await json(await adopt())).toEqual({ work: adopted.work, replayed: true });
    const replay = await stack.contentPool.query('SELECT id FROM rights.use_assessment WHERE id = ANY($1::uuid[])',
      [evidence.rows.map(row => row.id)]);
    expect(replay.rows).toHaveLength(6);
    expect(sourceCalls).toBe(2);
    const source = { provider: 'open-library', namespace: 'work', externalId: workId };
    await expect(runtime.dependencies.sourceAdoptions!.importBinding(source, id())).rejects.toThrow();
    const binding = await runtime.dependencies.sourceAdoptions!.importBinding(source, adopted.work);
    expect(binding?.rightsEvidence).toEqual({ basis: 'unknown', note: 'Reuse basis has not been assessed.' });
    expect((await runtime.dependencies.sourceAdoptions!.authorReferences([adopted.work])).get(adopted.work) ?? []).toEqual([]);
    const support = await runtime.dependencies.sourceAdoptions!.readSupport(reader.principalId, adopted.work);
    await runtime.dependencies.sourceAdoptions!.withdrawSupport(reader.principalId, adopted.work, randomUUID(), {
      binding: support!.binding, expectedSupport: support!.supportIdentity, reason: 'Source support revoked',
    });
    await expect(runtime.dependencies.rights!.store.assessSourceImport(binding!, importedRightsAssessments({
      provider: 'open-library', url: `https://openlibrary.org/works/${workId}` }, adopted.work))).rejects.toThrow();
    expect((await adopt()).status).toBe(409);
    expect(sourceCalls).toBe(2);
  } finally { await stack.stop(); }
}, 180_000);
