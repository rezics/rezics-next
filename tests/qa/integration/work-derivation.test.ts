import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, GRAPHS, ID, RV, iri, lit, metadataWorkRequestDigest,
  type WorkActivationEnvironment, type WorkActivationReceipt } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const EXACT = 'https://rezics.com/definition/work-derivation-v1';
const UNRESOLVED = 'https://rezics.com/definition/work-derivation-unresolved-v1';
const kindTerm = { adaptation: 'Adaptation', 'new-recording': 'NewRecording',
  'software-fork': 'SoftwareFork' } as const;

function qaEnvironment(label: string): { env: WorkActivationEnvironment; actor: string; close: () => void } {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { env: { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') }, actor: ID + randomUUID(),
  close: () => rmSync(directory, { recursive: true, force: true }) };
}

async function work(env: WorkActivationEnvironment, actor: string, title: string): Promise<WorkActivationReceipt> {
  return activateMetadataWork(env, { title, admission: { id: randomUUID(), actingSubject: actor,
    scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
    requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString() } });
}

async function install(env: WorkActivationEnvironment, actor: string, input: {
  target: WorkActivationReceipt; source: WorkActivationReceipt; kind: keyof typeof kindTerm;
  unresolved?: boolean; corrects?: string; evidence: string; sequence: string;
}): Promise<string> {
  const derivation = ID + randomUUID();
  const unresolved = input.unresolved === true;
  const profile = unresolved ? UNRESOLVED : EXACT;
  await env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(derivation)} a rv:${unresolved ? 'UnresolvedWorkDerivation' : 'WorkDerivation'} ;
      rv:targetWork ${iri(input.target.work)} ;
      rv:targetMainVersion ${iri(input.target.mainVersion)} ;
      rv:targetMainRevision ${iri(input.target.mainRevision)} ;
      rv:sourceWork ${iri(input.source.work)} ;
      rv:sourceMainVersion ${iri(input.source.mainVersion)} ;
      ${unresolved ? 'rv:sourceVersionStatus rv:Unresolved'
        : `rv:sourceMainRevision ${iri(input.source.mainRevision)}`} ;
      rv:derivationKind rv:${kindTerm[input.kind]} ;
      rv:evidence ${lit(input.evidence)} ; rv:linkedBy ${iri(actor)} ;
      rv:modelRevision <${profile}> ; rv:shapeRevision <${profile}> ;
      rv:sequence ${lit(input.sequence)}${input.corrects ? ` ; rv:corrects ${iri(input.corrects)}` : ''} .
  } }`);
  return derivation;
}

function reader(env: WorkActivationEnvironment) {
  const app = createMainApp(env.fuseki, { environment: env,
    account: { verify: async () => ({ issuer: 'https://qa-derivation.test', subject: randomUUID() }) },
    access: {} as never });
  return async (main: string, revision: string) => {
    const response = await app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/work-derivations`));
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ complete: true; derivations: Array<Record<string, unknown>> }>;
  };
}

test('WORK04: admitted exact Work derivations retain kind, source and target revisions', async () => {
  const { env, actor, close } = qaEnvironment('work-derivation-exact');
  try {
    const source = await work(env, actor, `Source ${randomUUID()}`);
    const target = await work(env, actor, `Adaptation ${randomUUID()}`);
    const derivation = await install(env, actor, { target, source, kind: 'adaptation',
      evidence: 'https://creator.example/continuity/exact', sequence: '1' });
    const read = reader(env);
    expect(await read(target.mainVersion, target.mainRevision)).toMatchObject({ complete: true,
      derivations: [{ derivation, targetWork: target.work, sourceWork: source.work,
        sourceMainVersion: source.mainVersion, sourceMainRevision: source.mainRevision,
        sourceVersionStatus: 'exact', kind: 'adaptation', status: 'effective',
        corrects: null, supersededBy: null }] });
    expect(await read(source.mainVersion, source.mainRevision)).toMatchObject({ complete: true, derivations: [] });
    const retired = await createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => ({ issuer: 'qa', subject: actor }) }, access: {} as never })
      .handle(new Request('http://main.local/v1/work-derivations', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: '{}' }));
    expect(retired.status).toBe(404);
  } finally { close(); }
}, 120_000);

test('WORK04: multi-source and corrected continuity stay exact per retained revision', async () => {
  const { env, actor, close } = qaEnvironment('work-derivation-corrected');
  try {
    const first = await work(env, actor, `First source ${randomUUID()}`);
    const second = await work(env, actor, `Second source ${randomUUID()}`);
    const target = await work(env, actor, `Corrected target ${randomUUID()}`);
    const original = await install(env, actor, { target, source: first, kind: 'adaptation',
      evidence: 'https://creator.example/continuity/original', sequence: '1' });
    const other = await install(env, actor, { target, source: second, kind: 'new-recording',
      evidence: 'https://creator.example/continuity/other', sequence: '2' });
    const correction = await install(env, actor, { target, source: first, kind: 'software-fork',
      evidence: 'https://creator.example/continuity/correction', sequence: '3', corrects: original });
    const page = await reader(env)(target.mainVersion, target.mainRevision);
    expect(page.derivations).toEqual(expect.arrayContaining([
      expect.objectContaining({ derivation: original, sourceWork: first.work, kind: 'adaptation',
        status: 'superseded', supersededBy: correction }),
      expect.objectContaining({ derivation: other, sourceWork: second.work, kind: 'new-recording',
        status: 'effective', corrects: null, supersededBy: null }),
      expect.objectContaining({ derivation: correction, sourceWork: first.work, kind: 'software-fork',
        sourceMainRevision: first.mainRevision, status: 'effective', corrects: original }),
    ]));
    expect(page.derivations).toHaveLength(3);
  } finally { close(); }
}, 120_000);

test('WORK04: an unresolved source version stays distinct and resolves later without rewriting history', async () => {
  const { env, actor, close } = qaEnvironment('work-derivation-unresolved');
  try {
    const source = await work(env, actor, `Unresolved source ${randomUUID()}`);
    const target = await work(env, actor, `Resolved target ${randomUUID()}`);
    const unresolved = await install(env, actor, { target, source, kind: 'adaptation', unresolved: true,
      evidence: 'https://creator.example/continuity/unresolved', sequence: '1' });
    const resolved = await install(env, actor, { target, source, kind: 'adaptation',
      evidence: 'https://creator.example/continuity/resolved', sequence: '2', corrects: unresolved });
    const page = await reader(env)(target.mainVersion, target.mainRevision);
    expect(page.derivations).toEqual(expect.arrayContaining([
      expect.objectContaining({ derivation: unresolved, sourceVersionStatus: 'unresolved',
        sourceMainRevision: null, status: 'superseded', supersededBy: resolved }),
      expect.objectContaining({ derivation: resolved, sourceVersionStatus: 'exact',
        sourceMainRevision: source.mainRevision, status: 'effective', corrects: unresolved }),
    ]));
    expect(page.derivations).toHaveLength(2);
  } finally { close(); }
}, 120_000);
