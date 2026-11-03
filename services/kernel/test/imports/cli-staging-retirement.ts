import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import entity from '../../../../specs/fixtures/imports/wikidata/entity.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { applyStagingRetirementPlan } from '../../../importer/src/staging-retirement.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const encoder = new TextEncoder();

function dump(ids: readonly number[], title: string) {
  const records = ids.map((n) => {
    const record = structuredClone(entity);
    record.id = `Q${n}`;
    record.lastrevid = 24681012 + n;
    record.labels.en.value = `${title} ${n}`;
    return record;
  });
  return encoder.encode(`[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`);
}

export async function runCliStagingRetirementJourney() {
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
    directory = await mkdtemp(join(tmpdir(), 'import-cli-staging-retirement-'));
    const state = join(directory, 'state.sqlite');
    const planPath = join(directory, 'retire.json');
    const keyPath = join(directory, 'account.jwk');
    const baselinePath = join(directory, 'baseline.json');
    const capturePath = join(directory, 'capture.json');
    const correctedPath = join(directory, 'corrected.json');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
    await writeFile(baselinePath, dump([900001, 900002], 'Baseline'));
    await writeFile(capturePath, dump([900001, 900002, 900003, 900004], 'Capture'));
    await writeFile(correctedPath, dump([900001, 900002, 900005], 'Corrected'));
    const native = identitySupport(runtime.identity);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const api = 'https://cli-staging-retirement.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const commands = new Map<string, BatchCommand>();

    const argv = (dumpFile: string, extra: string[] = []) => [
      '--source',
      'wikidata',
      '--dump',
      dumpFile,
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
      ...extra,
    ];

    const fetchLive = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) return native.host.service.handler(request);
      expect(url.origin).toBe(api);
      const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
      expect(claims.sub).toBe(runtime.identity.bulk.accountId);
      expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
      if (url.pathname === '/v1/subjects:batchWrite') {
        const body = JSON.parse(await request.clone().text()) as BatchWriteRequest;
        for (const command of body.commands ?? []) {
          const previous = commands.get(command.key);
          if (previous) expect(command).toEqual(previous);
          commands.set(command.key, command);
        }
      }
      const response = await runtime.replay(request);
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return response;
    }) as typeof fetch;

    const baseline = await runImportCli(argv(baselinePath), { testOrigin: api, fetch: fetchLive });
    expect(baseline.code).toBe(0);
    const session = new ImportSession(state);
    const baselineId = session.store.database
      .query('SELECT generation FROM run_sources WHERE source=?')
      .get('wikidata') as { generation: string };
    session.close();
    const controller = new AbortController();
    const interrupted = await runImportCli(argv(capturePath, ['--checkpoint-staging']), {
      signal: controller.signal,
      testOrigin: api,
      observer: {
        onCoordinator({ registration }) {
          const convert = registration.convert.bind(registration);
          let n = 0;
          (registration as { convert: typeof convert }).convert = (input, context) => {
            n++;
            const result = convert(input, context);
            if (n === 2) controller.abort(new DOMException('interrupt staging', 'AbortError'));
            return result;
          };
        },
      },
      fetch: fetchLive,
    });
    expect(interrupted.code).toBe(130);
    const generation = interrupted.stderr.match(/generation (\d+)/)?.[1];
    expect(generation).toBeDefined();
    let network = 0;
    const fetchBoundary = (async () => {
      network++;
      throw new Error('staging retirement must not use the network');
    }) as unknown as typeof fetch;
    const reviewed = await runImportCli(
      ['retire-staging', '--state', state, '--source', 'wikidata', '--generation', generation!, '--json'],
      { fetch: fetchBoundary },
    );
    expect(reviewed.code).toBe(0);
    expect(JSON.parse(reviewed.stdout).eligible).toBe(true);
    const planned = await runImportCli(
      [
        'retire-staging',
        '--state',
        state,
        '--source',
        'wikidata',
        '--generation',
        generation!,
        '--output',
        planPath,
        '--json',
      ],
      { fetch: fetchBoundary },
    );
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout) as { planId: string };
    let crashed = false;
    try {
      await applyStagingRetirementPlan(
        { state, plan: planPath, confirm: plan.planId },
        {
          pageSize: 1,
          observer: {
            beforePage() {
              if (!crashed) {
                crashed = true;
                throw new Error('interrupt-cleanup');
              }
            },
          },
        },
      );
    } catch (error) {
      expect((error as Error).message).toBe('interrupt-cleanup');
    }
    const applied = await runImportCli(
      ['retire-staging', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).status).toBe('complete');
    const inspect = await runImportCli([
      'inspect',
      '--state',
      state,
      '--source',
      'wikidata',
      '--generation',
      generation!,
      '--json',
    ]);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation.status).toBe('retired');
    const resumeOld = await runImportCli(argv(capturePath, ['--resume-staging', '--generation', generation!]), {
      testOrigin: api,
      fetch: fetchLive,
    });
    expect(resumeOld.code).toBe(2);
    expect(resumeOld.stderr).toContain('deliberately retired');
    const after = new ImportSession(state);
    const pins = after.store.database
      .query('SELECT generation,present_count,sequence FROM run_sources WHERE source=?')
      .get('wikidata') as { generation: string; present_count: number; sequence: number };
    expect(pins.generation).toBe(baselineId.generation);
    after.close();
    const corrected = await runImportCli(argv(correctedPath), { testOrigin: api, fetch: fetchLive });
    expect(corrected.code).toBe(0);
    const final = new ImportSession(state);
    const advanced = final.store.database
      .query('SELECT generation FROM run_sources WHERE source=?')
      .get('wikidata') as { generation: string };
    expect(advanced.generation).not.toBe(baselineId.generation);
    final.close();
    expect(network).toBe(0);
    return { reviewed, applied, inspect, resumeOld, corrected, baselineId: baselineId.generation, network, close };
  } catch (error) {
    await close();
    throw error;
  }
}
