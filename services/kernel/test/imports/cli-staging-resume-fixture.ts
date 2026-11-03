import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

type Source = 'openlibrary' | 'wikidata';
const encoder = new TextEncoder();

function openLibraryDump() {
  const row = (id: number, title: string) => {
    const key = `/works/OL${id}W`;
    return `/type/work\t${key}\t1\t2020-01-01T00:00:00.000000\t${JSON.stringify({ type: { key: '/type/work' }, key, revision: 1, title })}\n`;
  };
  return encoder.encode(
    `${row(900001, 'Harbor Work')}${row(900002, 'Second Work')}${row(900003, 'Third Work')}${row(900004, 'Fourth Work')}`,
  );
}

function wikidataDump() {
  const records = [1, 2, 3, 4].map((n) => {
    const record = structuredClone(entity);
    record.id = `Q${800000 + n}`;
    record.lastrevid = 24681012 + n;
    record.labels.en.value = `Checkpoint book ${n}`;
    return record;
  });
  return encoder.encode(`[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`);
}

export async function runStagingResumeJourney() {
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
    directory = await mkdtemp('/dev/shm/import-cli-staging-');
    const keyPath = join(directory, 'account.jwk');
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
    const api = 'https://cli-staging-resume.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const sources: {
      source: Source;
      interrupted: { code: number; stderr: string };
      resumed: { code: number };
      prefixConversions: number;
      resumeConversions: number;
      totalRecords: number;
      preSealNative: number;
      subjectIds: string[];
    }[] = [];
    for (const source of ['openlibrary', 'wikidata'] as const) {
      const state = join(directory, `${source}.sqlite`);
      const dumpPath = join(directory, `${source}.dump`);
      await writeFile(state, '', { flag: 'wx', mode: 0o600 });
      await writeFile(dumpPath, source === 'openlibrary' ? openLibraryDump() : wikidataDump());
      const argv = (mode: 'checkpoint-staging' | 'resume-staging', generation = '1') => [
        '--source',
        source,
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
        ...(mode === 'resume-staging' ? ['--resume-staging', '--generation', generation] : ['--checkpoint-staging']),
      ];
      let conversions = 0;
      let native = 0;
      let sealed = false;
      const controller = new AbortController();
      const interrupted = await runImportCli(argv('checkpoint-staging'), {
        signal: controller.signal,
        testOrigin: api,
        observer: {
          onCoordinator({ importer, registration }) {
            const convert = registration.convert.bind(registration);
            (registration as { convert: typeof convert }).convert = (input, context) => {
              conversions++;
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
      const resumed = await runImportCli(argv('resume-staging', interrupted.stderr.match(/generation (\d+)/)?.[1] ?? '1'), {
        testOrigin: api,
        observer: {
          onCoordinator({ registration }) {
            const convert = registration.convert.bind(registration);
            (registration as { convert: typeof convert }).convert = (input, context) => {
              conversions++;
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
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          if (url.pathname === '/v1/subjects:batchWrite') {
            const body = JSON.parse(await request.clone().text()) as BatchWriteRequest;
            expect(body.commands.length).toBeGreaterThan(0);
          }
          return runtime.replay(request);
        }) as typeof fetch,
      });
      sources.push({
        source,
        interrupted: { code: interrupted.code, stderr: interrupted.stderr },
        resumed: { code: resumed.code },
        prefixConversions,
        resumeConversions: conversions,
        totalRecords: 4,
        preSealNative,
        subjectIds: [],
      });
    }
    return { sources, close };
  } catch (error) {
    await close();
    throw error;
  }
}
