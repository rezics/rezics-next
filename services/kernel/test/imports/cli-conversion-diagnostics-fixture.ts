import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Candidate = { id: string; statement: { property: { id: string }; value: { type: string; content?: unknown } } };
type Exchange = { path: string; key: string | null; bytes: string; status: number; body: string };

function line(record: object) {
  const r = record as { type: { key: string }; key: string; revision: number; last_modified: { value: string } };
  return [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(record)].join('\t');
}

/** Ordinary CLI import of one Open Library edition, retained omission review, corrected reimport. */
export async function runCliConversionDiagnosticsJourney() {
  const previousTemporaryDirectory = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = '/dev/shm';
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryDirectory;
    }
  })();
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/cli-conversion-diagnostics-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const dumpPath = join(directory, 'openlibrary.tsv');
    const identity = runtime.identity;
    const support = identitySupport(identity);
    const editor = await openApiObserver(runtime);
    await support.renewManagement();
    const tierKey = randomUUID();
    const editorTier = await runtime.request(
      `/v1/accounts/${identity.governance.accountId}:setRateTier`,
      { key: tierKey, tier: 'trusted' },
      support.managementBearer,
      tierKey,
    );
    expect(editorTier.status, await editorTier.text()).toBe(200);
    const kid = randomUUID();
    const keys = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(keys.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(keys.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const edition = {
      type: { key: '/type/edition' },
      key: '/books/OL900000101M',
      revision: 11,
      last_modified: { type: '/type/datetime', value: '2025-02-03T04:05:06.654321' },
      title: 'The Glass Atlas: Pocket Edition',
      isbn_13: ['9780306406157'],
      publish_date: 'circa 1980',
    };
    await writeFile(dumpPath, `${line(edition)}\n`, { mode: 0o600 });
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const api = 'https://kernel.import.test';
    const argv = [
      '--source',
      'openlibrary',
      '--dump',
      dumpPath,
      '--state',
      state,
      '--api',
      api,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      identity.bulk.accountId,
      '--client',
      identity.client.clientId,
    ];
    const exchanges: Exchange[] = [];
    const commands = new Map<string, { bytes: string; keys: string[] }>();
    async function invoke(signal?: AbortSignal) {
      const start = exchanges.length;
      const result = await runImportCli(argv, {
        signal,
        observer: signal
          ? {
              onCoordinator({ importer }) {
                const seal = importer.session.store.seal.bind(importer.session.store);
                importer.session.store.seal = (...args) => {
                  const outcome = seal(...args);
                  signal.abort();
                  return outcome;
                };
              },
            }
          : undefined,
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) return support.host.service.handler(request);
          expect(url.origin).toBe(api);
          const bytes = await request.clone().text();
          if (url.pathname === '/v1/subjects:batchWrite') {
            for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands)
              runtime.commands.set(command.key, { command, actor: identity.bulk.accountId });
          }
          const response = await runtime.replay(request);
          const body = await response.clone().text();
          const key = request.headers.get('idempotency-key');
          exchanges.push({ path: url.pathname, key, bytes, status: response.status, body });
          if (key && request.method !== 'GET') {
            const prior = commands.get(key);
            const keys =
              url.pathname === '/v1/subjects:batchWrite'
                ? (JSON.parse(bytes) as BatchWriteRequest).commands.map((c) => c.key)
                : [key];
            if (prior) expect({ bytes, keys }).toEqual(prior);
            else commands.set(key, { bytes, keys });
          }
          return response;
        }) as typeof fetch,
      });
      return { result, captured: exchanges.slice(start) };
    }
    const interrupted = await invoke(new AbortController().signal);
    expect(interrupted.result.code).toBe(130);
    expect(interrupted.result.openHandles).toBe(0);
    expect(interrupted.captured.filter((e) => e.path.startsWith('/v1/'))).toEqual([]);
    let network = 0;
    const stagedReview = await runImportCli(
      ['diagnostics', '--source', 'openlibrary', '--state', state, '--record', edition.key, '--format', 'json'],
      {
        fetch: (async () => {
          network++;
          throw new Error('diagnostics must not use the network');
        }) as typeof fetch,
      },
    );
    expect(network).toBe(0);
    expect(stagedReview.code).toBe(0);
    expect(stagedReview.openHandles).toBe(0);
    const stagedBody = JSON.parse(stagedReview.stdout) as {
      coverage: string;
      live: boolean;
      records: { phase: string; diagnostics: { pointer: string; code: string }[] }[];
    };
    expect(stagedBody.coverage).toBe('recorded');
    expect(stagedBody.live).toBe(true);
    expect(stagedBody.records.some((row) => row.phase === 'staging')).toBe(true);
    expect(stagedBody.records.flatMap((row) => row.diagnostics)).toContainEqual({
      pointer: '/publish_date',
      code: 'unsupported_publication_date_format',
    });
    const resumed = await invoke();
    expect(resumed.result.code).toBe(0);
    const original = [...commands.entries()].map(([key, value]) => ({ key, ...value }));
    const completedReview = await runImportCli([
      'diagnostics',
      '--source',
      'openlibrary',
      '--state',
      state,
      '--record',
      edition.key,
      '--format',
      'json',
    ]);
    expect(completedReview.code).toBe(0);
    const completed = JSON.parse(completedReview.stdout) as { coverage: string; records: { phase: string }[] };
    expect(completed.coverage).toBe('recorded');
    expect(completed.records.map((row) => row.phase).sort()).toEqual(['application', 'staging']);
    edition.publish_date = 'May 1980';
    edition.revision = 12;
    await writeFile(dumpPath, `${line(edition)}\n`, { mode: 0o600 });
    const corrected = await invoke();
    expect(corrected.result.code).toBe(0);
    for (const prior of original) expect(commands.get(prior.key)).toEqual({ bytes: prior.bytes, keys: prior.keys });
    for (const prior of original) expect(await runtime.receipt(prior.keys[0]!)).toBeString();
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const binding = (() => {
      const db = new Database(state, { readonly: true });
      try {
        return db
          .query('SELECT state,subject FROM binding_records WHERE source=? AND external_id=?')
          .get('openlibrary', edition.key) as { state: string; subject: string } | null;
      } finally {
        db.close();
      }
    })();
    expect(binding).toMatchObject({ state: 'bound' });
    const id = binding!.subject;
    async function listing(property: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body as { candidates: Candidate[] }).candidates;
    }
    async function select(property: string) {
      const rows = await listing(property);
      expect(rows.length).toBeGreaterThan(0);
      const accepted = await editor.http(`/v1/subjects/${id}/candidates/${rows[0]!.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        expected_head: null,
        selection: [{ candidate: rows[0]!.id, rank: 'normal' }],
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }
    await select('schema:name');
    await select('schema:isbn');
    await select('schema:datePublished');
    const response = await runtime.request(`/v1/subjects/${id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { subject: Subject };
    return {
      converterRevision: converter_revision,
      interrupted: interrupted.result,
      stagedReview: stagedBody,
      resumed: resumed.result,
      corrected: corrected.result,
      originalRequests: original,
      subjectId: id,
      subject: body.subject,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
