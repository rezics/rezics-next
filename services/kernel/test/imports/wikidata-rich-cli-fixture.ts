import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteResult, Source } from '@rezics/definitions/bulk';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { sourceDigest } from '../../../../packages/conversion/src/support.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Candidate = {
  id: string;
  statement: BatchStatement & { id: string };
  source: Source;
  revision: number;
  retracted: number | null;
  head: number | null;
};
type Exchange = { path: string; bytes: string; status: number; response: string };
type Snak = { snaktype: string; property: string; datatype: string; datavalue?: { type: string; value: unknown } };
type Claim = { type: string; rank: string; mainsnak: Snak; qualifiers?: Record<string, Snak[]> };

/** Controlled qualification-edge transplants, using the existing native cases' shapes. */
function richRecord() {
  const record: { id: string; type: string; lastrevid: number; claims: Record<string, Claim[]>;
    labels: Record<string, { language: string; value: string }>; [key: string]: unknown } = structuredClone(entity);
  const item = (property: string, id: string): Snak => ({
    snaktype: 'value', property, datatype: 'wikibase-item',
    datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': Number(id.slice(1)), id } },
  });
  const measurement = (qualifiers: Record<string, Snak[]>): Claim => ({
    type: 'statement', rank: 'normal',
    mainsnak: { snaktype: 'value', property: 'P6570', datatype: 'quantity',
      datavalue: { type: 'quantity', value: { amount: '+1450', unit: '1' } } },
    qualifiers,
  });
  record.claims.P6570 = [
    measurement(structuredClone(record.claims.P50![0]!.qualifiers!)),
    measurement({ P459: [item('P459', 'Q718390')], P518: [item('P518', 'Q63246861')] }),
    measurement({ P518: [{ snaktype: 'somevalue', property: 'P518', datatype: 'wikibase-item' }] }),
  ];
  record.labels['unknown-language'] = { language: 'unknown-language', value: 'UNKNOWN_LANGUAGE_SENTINEL' };
  // Unknown-language monolingual author qualifiers must not become English text.
  record.claims.P50![0]!.qualifiers!.P1932 = [{
    snaktype: 'value', property: 'P1932', datatype: 'monolingualtext',
    datavalue: { type: 'monolingualtext', value: { language: 'unknown-language', text: 'UNKNOWN_LANGUAGE_SENTINEL' } },
  }];
  // An image URL and unlicensed prose are hostile extra input, not rights evidence.
  record.claims.P18 = [{ type: 'statement', rank: 'normal', mainsnak: {
    snaktype: 'value', property: 'P18', datatype: 'commonsMedia',
    datavalue: { type: 'string', value: 'https://images.example.org/UNKNOWN_IMAGE_SENTINEL.jpg' },
  } }];
  return { ...record, prose: 'UNKNOWN_PROSE_SENTINEL' };
}

/** One real CLI/Auth/application/registered-worker world; only input bytes and scheduling are supplied. */
export async function runWikidataRichCliJourney() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  const close = async () => {
    try { await runtime.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  };
  try {
    directory = await mkdtemp('/dev/shm/wikidata-rich-cli-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { mode: 0o600, flag: 'wx' });
    const support = identitySupport(runtime.identity);
    const editor = await openApiObserver(runtime);
    await support.renewManagement();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid, subjectAccountId: runtime.identity.bulk.accountId, headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = { key: staged.key, effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId, headers: support.managementHeaders };
    const approved = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approved.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600, flag: 'wx',
    });
    const api = 'https://wikidata-rich-cli.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const argv = ['--source', 'wikidata', '--dump', '-', '--state', state, '--api', api, '--auth', auth,
      '--account-key', keyPath, '--account', runtime.identity.bulk.accountId,
      '--client', runtime.identity.client.clientId];
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    const revisions: string[] = [];
    const sourceRows: unknown[] = [];
    const authPaths: string[] = [];
    const input = richRecord();

    function inspect() {
      const session = new ImportSession(state);
      try {
        const baseline = session.store.key('wikidata', input.id).baseline;
        const claim = session.bindings.claim({ source: 'wikidata', external_id: input.id });
        const journal = session.store.database.query(
          'SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 64',
        ).all('wikidata', input.id);
        const media = session.store.database.query(
          'SELECT * FROM binding_media WHERE source=? AND external_id=? LIMIT 64',
        ).all('wikidata', input.id);
        return { source: session.store.source('wikidata'), active: session.store.activeRun('wikidata'), baseline, claim, journal, media };
      } finally { session.close(); }
    }
    async function invoke(record: typeof input, interruptBeforeWrite = false) {
      const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
      const original = bytes.slice();
      const controller = new AbortController();
      const offset = exchanges.length;
      let sealed = false;
      let consumed = 0;
      const attempted: string[] = [];
      const result = await runImportCli(argv, {
        signal: controller.signal,
        stdin: (async function* () {
          for (let start = 0; start < bytes.length; start += 127) {
            const chunk = bytes.slice(start, start + 127);
            consumed += chunk.length;
            yield chunk;
          }
        })(),
        observer: {
          onAccountKey(path, observed) {
            expect(path).toBe(keyPath);
            expect(observed.regularFile).toBe(true);
            expect(observed.mode & 0o777).toBe(0o600);
          },
          onCoordinator({ importer, registration, converterModule, decoderModule }) {
            revisions.push(registration.converter_revision);
            expect(registration.source).toBe('wikidata');
            expect(converterModule).toBe(import.meta.resolve('../../../../packages/conversion/src/wikidata.ts'));
            expect(decoderModule).toBe(import.meta.resolve('../../../importer/src/dumps.ts'));
            // Observe the real acquisition barrier; do not replace its result.
            sealed = importer.session.store.activeRun('wikidata') !== null;
            const store = importer.session.store;
            const seal = store.seal.bind(store);
            store.seal = (run, request) => {
              const result = seal(run, request);
              if (request.complete && result.status === 'ready') {
                expect(consumed).toBe(bytes.length);
                sealed = true;
              }
              return result;
            };
          },
        },
        fetch: (async (value: Request | string | URL, init?: RequestInit) => {
          const request = value instanceof Request ? value : new Request(value, init);
          const url = new URL(request.url);
          expect(sealed).toBe(true);
          if (url.origin === auth) {
            authPaths.push(url.pathname);
            return support.host.service.handler(request);
          }
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(claims.client_id).toBe(runtime.identity.client.clientId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          expect(['/v1/subjects:batchWrite', '/v1/sourceFences:check']).toContain(url.pathname);
          const body = request.method === 'GET' ? '' : await request.clone().text();
          if (url.pathname === '/v1/subjects:batchWrite') {
            expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65536);
            attempted.push(body);
            if (interruptBeforeWrite) {
              controller.abort();
              throw new DOMException('Scheduled interruption before delivery', 'AbortError');
            }
            for (const command of (JSON.parse(body) as { commands: BatchCommand[] }).commands) {
              const old = commands.get(command.key);
              if (old) expect(command).toEqual(old);
              commands.set(command.key, command);
            }
          }
          const response = await runtime.replay(request);
          exchanges.push({ path: url.pathname, bytes: body, status: response.status, response: await response.clone().text() });
          return response;
        }) as typeof fetch,
      });
      expect(result.openHandles).toBe(0);
      expect(JSON.stringify(result)).not.toContain('Bearer ');
      expect(JSON.stringify(result)).not.toContain('"d":');
      expect(bytes).toEqual(original);
      const captured = exchanges.slice(offset);
      sourceRows.push(inspect());
      return { ...result, captured, attempted, writes: captured.filter((e) => e.path === '/v1/subjects:batchWrite') };
    }
    function subject() {
      const observed = inspect();
      expect(observed.claim?.state).toBe('bound');
      if (observed.claim?.state !== 'bound') throw new Error('CLI did not persist a returned subject');
      return observed.claim.subject;
    }
    async function receipt(command: BatchCommand) {
      const route = command.op === 'create'
        ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
        : routeOf(command.subject)!;
      const result = await runtime.database.admin.query(
        `SELECT to_jsonb(r) AS receipt FROM core.receipt r WHERE partition_no=$1 AND principal_kind=$2
         AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5`,
        [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, command.key],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0];
    }
    async function page(id: string, property: string, context = GLOBAL_CONTEXT, sameAs?: string) {
      const response = await editor.http(`/v1/subjects/${id}/candidates?${new URLSearchParams({
        property, context, limit: '100', ...(sameAs ? { sameAs } : {}),
      })}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body as unknown as { candidates: Candidate[]; adoption: { head: number } | null };
    }
    async function select(id: string, property: string, context = GLOBAL_CONTEXT, sameAs?: string) {
      const listing = await page(id, property, context, sameAs);
      expect(listing.candidates.length).toBeGreaterThan(0);
      for (const candidate of listing.candidates) {
        const accepted = await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
          context, expected_head: candidate.head,
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      }
      const adopted = await editor.http(`/v1/subjects/${id}:adopt`, {
        context, property, ...(sameAs ? { sameAs } : {}), mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: listing.candidates.map((c) => ({ candidate: c.id, rank: c.statement.rank ?? 'normal' })),
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
      return listing.candidates;
    }
    async function publicView(id: string, context = GLOBAL_CONTEXT) {
      const links = linkProjection(runtime.database.pool);
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const result = await links.run(partitionOf(routeOf(id)!));
        expect(result.status).not.toBe('stopped');
        if (result.status === 'read' && result.envelopes === 0) { caughtUp = true; break; }
        if (result.status === 'busy') await Bun.sleep(5);
      }
      expect(caughtUp).toBe(true);
      const response = await runtime.request(`/v1/subjects/${id}?context=${context}`);
      expect(response.status).toBe(200);
      return await response.json() as { subject: { id: string; statements: Record<string, Candidate['statement'][]> } };
    }
    const values = (statements: Candidate['statement'][]) => statements.map((s) => ({
      id: s.id, property: s.property, value: s.value, rank: s.rank, qualifiers: s.qualifiers, references: s.references,
    })).sort((a, b) => a.id.localeCompare(b.id));

    const initial = await invoke(input);
    expect(initial.code, JSON.stringify(initial)).toBe(0);
    const initialSubjectId = subject();
    const initialState = inspect();
    expect(initialState.baseline?.recordRevision).toBe(String(input.lastrevid));
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT }, subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'], valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const selected: Candidate[] = [];
    for (const [property, sameAs] of [
      ['schema:name'], ['schema:datePublished'], ['schema:url'],
      ['schema:author', 'http://www.wikidata.org/entity/Q42'],
      ['schema:author', 'http://www.wikidata.org/entity/Q999999999'],
    ]) selected.push(...await select(initialSubjectId, property!, GLOBAL_CONTEXT, sameAs));
    expect(selected).toHaveLength(6);
    for (const candidate of selected) {
      expect(candidate.source).toMatchObject({ source: 'wikidata', external_id: input.id,
        record_revision: String(input.lastrevid), converter_revision: 'wikidata-4', field_group: 'facts' });
      expect(candidate.source.digest).toBe(initialState.baseline!.digest);
      expect(candidate.statement.references).toContainEqual(expect.objectContaining({
        parts: expect.arrayContaining([expect.objectContaining({ property: expect.objectContaining({ id: 'schema:url' }),
          value: { type: 'value', content: `https://www.wikidata.org/wiki/${input.id}?oldid=${input.lastrevid}` } })]),
      }));
    }
    const preferred = selected.find((c) => c.statement.rank === 'preferred')!;
    expect(preferred.statement.qualifiers).toContainEqual({ property: expect.objectContaining({ id: 'schema:position' }),
      value: { type: 'value', content: '1' } });
    expect(preferred.statement.references).toContainEqual(expect.objectContaining({ parts: [expect.objectContaining({
      property: expect.objectContaining({ id: 'schema:url' }),
      value: { type: 'value', content: 'https://catalogue.example.org/books/example' },
    })] }));
    for (const candidate of selected.filter((c) => c.statement.property.id === 'schema:author'))
      expect(candidate.statement.value).toEqual({ type: 'somevalue' });
    const disclosed = await publicView(initialSubjectId);
    const selectedSupportedValues = values(selected.map((c) => c.statement));
    const nativeSupportedValues = values(Object.values(disclosed.subject.statements).flat());
    const withheldExactMeasurementCandidates = (await page(initialSubjectId, 'schema:wordCount')).candidates;
    const unknownLanguageTextDisclosures = Object.values(disclosed.subject.statements).flat()
      .filter((statement) => JSON.stringify(statement).includes('UNKNOWN_LANGUAGE_SENTINEL'));
    const created = await editor.http('/v1/contexts', { labels: { en: 'Independent rich CLI review' } });
    expect(created.status).toBe(201);
    const context = (created.body.context as { id: string }).id;
    await select(initialSubjectId, 'schema:url', context);
    const independentSelectionBefore = (await publicView(initialSubjectId, context)).subject.statements['schema:url'];
    const oldCommands = [...commands.values()];
    const immutable = async () => ({
      journal: inspect().journal.filter((row) => oldCommands.some((c) => c.key === (row as { key: string }).key)),
      receipts: await Promise.all(oldCommands.map(receipt)),
      candidates: await runtime.database.admin.query(
        'SELECT candidate_id,statement,source FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=ANY($3::uuid[]) ORDER BY candidate_id',
        [routeOf(initialSubjectId), initialSubjectId, selected.map((c) => c.id)],
      ).then((r) => r.rows),
      media: inspect().media,
    });
    const originalBootstrapBefore = await immutable();

    const changed = structuredClone(input);
    changed.lastrevid++;
    changed.claims.P856![0]!.mainsnak.datavalue!.value = 'https://books.example.org/revised';
    const refreshed = await invoke(changed);
    expect(refreshed.code, JSON.stringify(refreshed)).toBe(0);
    const refreshedSubjectId = subject();
    const fresh = (await page(initialSubjectId, 'schema:url', context)).candidates
      .filter((c) => c.source.record_revision === String(changed.lastrevid));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.statement.value).toEqual({ type: 'value', content: 'https://books.example.org/revised' });
    expect(fresh[0]!.source.digest).not.toBe(selected[0]!.source.digest);
    const independentSelectionAfter = (await publicView(initialSubjectId, context)).subject.statements['schema:url'];
    const unchangedReopen = await invoke(changed);
    const originalBootstrapAfter = await immutable();

    // Leave real prepared work outstanding, then add a facts fence before reopening it.
    const fenced = structuredClone(changed);
    fenced.lastrevid++;
    fenced.claims.P856![0]!.mainsnak.datavalue!.value = 'https://books.example.org/fenced';
    const interrupted = await invoke(fenced, true);
    expect(interrupted.code).toBe(130);
    expect(interrupted.attempted.length).toBeGreaterThan(0);
    expect(inspect().active).not.toBeNull();
    const takedown = await editor.http('/v1/sourceFences:takedown', {
      source: 'wikidata', externalId: input.id, fieldGroup: 'facts', reason: 'Controlled late facts fence',
    });
    expect(takedown.status, JSON.stringify(takedown.body)).toBe(200);
    const fencedRefresh = await invoke(fenced);
    const afterFence = await publicView(initialSubjectId);
    const disclosedFencedFacts = Object.values(afterFence.subject.statements).flat();
    expect((await page(initialSubjectId, 'schema:wordCount')).candidates).toEqual([]);
    const boundary = await runtime.mediaBoundary.capture();
    expect(boundary.registrations.length).toBeGreaterThan(0);
    const unknownProseOrImageEffects = [
      ...boundary.sourceRequests, ...boundary.liveInternetRequests, ...boundary.calls, ...inspect().media,
      ...[...commands.values()].filter((c) => c.source.field_group !== 'facts' || 'rights' in c ||
        /UNKNOWN_(PROSE|IMAGE)_SENTINEL/.test(JSON.stringify(c))),
    ];
    const nativeReceiptRows = await Promise.all([...commands.values()].map(receipt));
    // No borrowed identity: relation QIDs remain external evidence under this exact source.
    const db = new Database(state, { readonly: true });
    try {
      for (const qid of ['Q42', 'Q999999999']) expect(db.query(
        'SELECT subject FROM binding_records WHERE source=? AND external_id=?',
      ).all('wikidata', qid)).toEqual([]);
    } finally { db.close(); }
    expect(authPaths).toContain('/signin/key');
    expect(authPaths).toContain('/token');
    expect(new Set(revisions)).toEqual(new Set(['wikidata-4']));
    for (const exchange of exchanges.filter((e) => e.path === '/v1/subjects:batchWrite')) {
      expect(exchange.status).toBe(200);
      for (const result of (JSON.parse(exchange.response) as BatchWriteResult).results)
        expect(result.status, JSON.stringify(result)).toBeLessThan(400);
    }
    // Raw, credential-free anchors remain in the managed native log after tmpfs cleanup.
    console.log(JSON.stringify({ journey: 'Wikidata rich cited proposal CLI refresh', converterRevision: revisions[0],
      bundleRevision: bundledRelease.catalogue, bundleDigest: bundledDigest, initialSubjectId,
      sourceRows, sourceDigests: sourceRows.map((r) => (r as ReturnType<typeof inspect>).baseline?.digest),
      suppliedDigest: sourceDigest(input), exchanges, nativeReceiptRows, media: boundary }));
    return {
      initial, converterRevision: revisions[0], richCitedCandidates: selected.map((c) => c.statement),
      selectedSupportedValues, nativeSupportedValues, withheldExactMeasurementCandidates,
      unknownLanguageTextDisclosures, unknownProseOrImageEffects, refreshed, refreshedSubjectId, initialSubjectId,
      newSupportedProposalIds: fresh.map((c) => c.id), independentSelectionAfter, independentSelectionBefore,
      unchangedReopen, unchangedReopenWrites: unchangedReopen.writes, originalBootstrapAfter, originalBootstrapBefore,
      fencedRefresh, disclosedFencedFacts, nativeReceiptRows, close,
    };
  } catch (error) { await close(); throw error; }
}
