import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const encoder = new TextEncoder();
const rows = [
  { id: 91001, type: 1, name: 'Checkpoint book' },
  { id: 91002, type: 2, name: 'Checkpoint anime' },
  { id: 91004, type: 4, name: 'Checkpoint game' },
  { id: 91003, type: 3, name: 'Checkpoint soundtrack', date: '2024-04-01' },
  { id: 91006, type: 6, name: 'Checkpoint film', platform: 6002, date: '2024-05' },
] as const;
const expectedTypes: Record<number, string> = {
  91001: 'schema:Book',
  91002: 'schema:TVSeries',
  91004: 'schema:VideoGame',
  91003: 'schema:MusicAlbum',
  91006: 'schema:Movie',
};

function dump() {
  return encoder.encode(
    rows
      .map((row) =>
        JSON.stringify({
          ...row,
          name_cn: `中文 ${row.id}`,
          score: 8.2,
          score_details: { '8': 12 },
          rank: 4,
        }),
      )
      .join('\n') + '\n',
  );
}

export async function runBangumiStagingJourney() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/bangumi-staging-');
    const keyPath = join(directory, 'account.jwk');
    const state = join(directory, 'bangumi.sqlite');
    const dumpPath = join(directory, 'bangumi.jsonl');
    const support = identitySupport(runtime.identity);
    await support.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
    await writeFile(dumpPath, dump());
    const api = 'https://bangumi-staging.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const scopes = [...IMPORTER_SCOPES, 'subject:read'];
    const argv = (mode: 'checkpoint-staging' | 'resume-staging' | 'ordinary', generation = '1') => [
      '--source',
      'bangumi',
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
      runtime.identity.bulk.accountId,
      '--client',
      runtime.identity.client.clientId,
      ...(mode === 'resume-staging'
        ? ['--resume-staging', '--generation', generation]
        : mode === 'checkpoint-staging'
          ? ['--checkpoint-staging']
          : []),
    ];
    let conversions = 0;
    let native = 0;
    let sealed = false;
    const bodies: string[] = [];
    const controller = new AbortController();
    const interrupted = await runImportCli(argv('checkpoint-staging'), {
      signal: controller.signal,
      testOrigin: api,
      observer: {
        onCoordinator({ importer, registration }) {
          const convert = registration.convert.bind(registration);
          (registration as { convert: typeof convert }).convert = (input, context) => {
            if (!context.subjectId) conversions++;
            const result = convert(input, context);
            if (conversions === 2) controller.abort(new DOMException('interrupt staging', 'AbortError'));
            return result;
          };
          const seal = importer.session.store.seal.bind(importer.session.store);
          importer.session.store.seal = (run, request) => {
            const value = seal(run, request);
            if (value.status === 'ready') sealed = true;
            return value;
          };
        },
      },
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === auth) return support.host.service.handler(request);
        native++;
        expect(sealed).toBe(true);
        return runtime.replay(request);
      }) as typeof fetch,
    });
    const prefixConversions = conversions;
    const preSealNative = native;
    conversions = 0;
    native = 0;
    const resumed = await runImportCli(
      argv('resume-staging', interrupted.stderr.match(/generation (\d+)/)?.[1] ?? '1'),
      {
        testOrigin: api,
        observer: {
          onCoordinator({ registration }) {
            const convert = registration.convert.bind(registration);
            (registration as { convert: typeof convert }).convert = (input, context) => {
              if (!context.subjectId) conversions++;
              return convert(input, context);
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) return support.host.service.handler(request);
          expect(url.origin).toBe(api);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...scopes].sort());
          const text = await request.clone().text();
          bodies.push(text);
          if (url.pathname === '/v1/subjects:batchWrite') {
            const body = JSON.parse(text) as BatchWriteRequest;
            expect(body.commands.length).toBeGreaterThan(0);
          }
          return runtime.replay(request);
        }) as typeof fetch,
      },
    );
    const observer = await openApiObserver(runtime);
    const session = new ImportSession(state, { create: false });
    const subjects: { id: string; type: string; sourceRecords: boolean }[] = [];
    try {
      for (const row of rows) {
        const bound = session.bindings.claim({ source: 'bangumi', external_id: String(row.id) });
        expect(bound?.state).toBe('bound');
        const view = await observer.http(`/v1/subjects/${bound!.subject}`);
        expect(view.status).toBe(200);
        const subject = view.body.subject as {
          type: string;
          sourceRecords?: { source: string; external_id: string }[];
        };
        subjects.push({
          id: bound!.subject,
          type: subject.type,
          sourceRecords: Boolean(
            subject.sourceRecords?.some(
              (record) => record.source === 'bangumi' && record.external_id === String(row.id),
            ),
          ),
        });
        expect(subject.type).toBe(expectedTypes[row.id]);
      }
    } finally {
      session.close();
    }
    const reopen = await runImportCli(argv('ordinary'), {
      testOrigin: api,
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === auth) return support.host.service.handler(request);
        return runtime.replay(request);
      }) as typeof fetch,
    });
    return {
      interrupted: { code: interrupted.code, stderr: interrupted.stderr },
      resumed: { code: resumed.code, stdout: resumed.stdout },
      reopen: { code: reopen.code },
      prefixConversions,
      resumeConversions: conversions,
      totalRecords: rows.length,
      preSealNative,
      bodies,
      subjects,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
