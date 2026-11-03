import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import workSource from '../../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../../specs/fixtures/imports/open-library/edition.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const encoder = new TextEncoder();

function openLibraryDump() {
  const row = (id: number, title: string) => {
    const key = `/works/OL${id}W`;
    return `/type/work\t${key}\t1\t2020-01-01T00:00:00.000000\t${JSON.stringify({ type: { key: '/type/work' }, key, revision: 1, title })}\n`;
  };
  return encoder.encode(`${row(900001, 'Harbor Work')}${row(900002, 'Second Work')}${row(900003, 'Third Work')}${row(900004, 'Fourth Work')}`);
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

function tsv(record: { type: { key: string }; key: string; revision: number; last_modified?: { value: string } }) {
  const date = record.last_modified?.value ?? '2025-01-01T00:00:00Z';
  return `${[record.type.key, record.key, record.revision, date, JSON.stringify(record)].join('\t')}\n`;
}

export async function runCompressedStagingResumeJourney() {
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
    directory = await mkdtemp('/dev/shm/import-cli-gz-staging-');
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
    const api = 'https://cli-compressed-staging.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const credentials = [
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
    ];
    const run = async (args: string[], interruptAt?: number) => {
      const controller = new AbortController();
      let conversions = 0;
      let native = 0;
      let sealed = false;
      const result = await runImportCli(args, {
        signal: controller.signal,
        testOrigin: api,
        observer: {
          onCoordinator({ importer, registration }) {
            const convert = registration.convert.bind(registration);
            (registration as { convert: typeof convert }).convert = (input, context) => {
              conversions++;
              const value = convert(input, context);
              if (interruptAt !== undefined && conversions === interruptAt)
                controller.abort(new DOMException('interrupt staging', 'AbortError'));
              return value;
            };
            const seal = importer.session.store.seal.bind(importer.session.store);
            importer.session.store.seal = (runId, request) => {
              const next = seal(runId, request);
              if (next.status === 'ready') sealed = true;
              return next;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) return support.host.service.handler(request);
          native++;
          expectSealed(sealed);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expectAccount(claims.sub, runtime.identity.bulk.accountId);
          if (url.pathname === '/v1/subjects:batchWrite') {
            const body = JSON.parse(await request.clone().text()) as BatchWriteRequest;
            if (body.commands.length === 0) throw new Error('empty native batch');
          }
          return runtime.replay(request);
        }) as typeof fetch,
      });
      return { result, conversions, native };
    };

    const sources: {
      name: string;
      interrupted: { code: number; stderr: string };
      resumed: { code: number };
      prefixConversions: number;
      resumeConversions: number;
      totalRecords: number;
      preSealNative: number;
    }[] = [];
    for (const source of ['openlibrary', 'wikidata'] as const) {
      const state = join(directory, `${source}.sqlite`);
      const dumpPath = join(directory, `${source}.gz`);
      await writeFile(state, '', { flag: 'wx', mode: 0o600 });
      await writeFile(dumpPath, gzipSync(source === 'openlibrary' ? openLibraryDump() : wikidataDump()));
      const flags = (mode: 'checkpoint-staging' | 'resume-staging') => [
        '--source',
        source,
        '--dump',
        dumpPath,
        '--compression',
        'gzip',
        '--state',
        state,
        ...credentials,
        ...(mode === 'resume-staging' ? ['--resume-staging', '--generation', '1'] : ['--checkpoint-staging']),
      ];
      const interrupted = await run(flags('checkpoint-staging'), 2);
      const resumed = await run(flags('resume-staging'));
      sources.push({
        name: source,
        interrupted: { code: interrupted.result.code, stderr: interrupted.result.stderr },
        resumed: { code: resumed.result.code },
        prefixConversions: interrupted.conversions,
        resumeConversions: resumed.conversions,
        totalRecords: 4,
        preSealNative: interrupted.native,
      });
    }

    const setDir = join(directory, 'set');
    await mkdir(setDir, { recursive: true, mode: 0o700 });
    const authorRow = tsv({
      type: { key: '/type/author' },
      key: '/authors/OL900000001A',
      revision: 1,
      last_modified: { value: '2025-01-01T00:00:00Z' },
    });
    const extraWorks = [1, 2, 3].map((n) => ({
      ...workSource,
      key: `/works/OL90000001${n}W`,
      title: `Compressed work ${n}`,
      covers: [],
    }));
    await writeFile(join(setDir, 'authors.txt.gz'), gzipSync(Buffer.from(authorRow)), { mode: 0o600 });
    await writeFile(join(setDir, 'works.txt'), [{ ...workSource, covers: [] }, ...extraWorks].map(tsv).join(''), {
      mode: 0o600,
    });
    await writeFile(join(setDir, 'editions.txt.gz'), gzipSync(Buffer.from(tsv({ ...editionSource, covers: [] }))), {
      mode: 0o600,
    });
    const manifest = join(setDir, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        version: 2,
        source: 'openlibrary',
        members: [
          { family: 'author', path: 'authors.txt.gz', compression: 'gzip' },
          { family: 'work', path: 'works.txt', compression: 'none' },
          { family: 'edition', path: 'editions.txt.gz', compression: 'gzip' },
        ],
      }),
      { mode: 0o600 },
    );
    const setState = join(directory, 'dump-set.sqlite');
    await writeFile(setState, '', { flag: 'wx', mode: 0o600 });
    const setFlags = (mode: 'checkpoint-staging' | 'resume-staging') => [
      '--source',
      'openlibrary',
      '--dump-set',
      manifest,
      '--state',
      setState,
      ...credentials,
      ...(mode === 'resume-staging' ? ['--resume-staging', '--generation', '1'] : ['--checkpoint-staging']),
    ];
    const setInterrupted = await run(setFlags('checkpoint-staging'), 2);
    const setResumed = await run(setFlags('resume-staging'));
    sources.push({
      name: 'dump-set',
      interrupted: { code: setInterrupted.result.code, stderr: setInterrupted.result.stderr },
      resumed: { code: setResumed.result.code },
      prefixConversions: setInterrupted.conversions,
      resumeConversions: setResumed.conversions,
      totalRecords: 5,
      preSealNative: setInterrupted.native,
    });
    return { sources, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function expectSealed(sealed: boolean) {
  if (!sealed) throw new Error('native batch before seal');
}

function expectAccount(sub: unknown, account: string) {
  if (sub !== account) throw new Error('native batch used a different account');
}
