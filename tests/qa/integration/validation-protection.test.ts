import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ProtectionAdmissionSigner, signProtectionAdmission }
  from '../../../services/main/src/modules/access/protection-admission.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { ratingAccount } from '../support/rating-account.ts';

const RV = 'https://rezics.com/vocab/';
const CURRENT = 'urn:rezics:graph:current';
const RECEIPTS = 'urn:rezics:graph:receipts';
const OUTBOX = 'urn:rezics:graph:outbox';
const iri = (value: string) => `<${value}>`;
const shortId = (value: string) => value.split('/').at(-1)!;

type EditorialState = { contentHead: string; protectionHead: string | null; controlHead: string | null;
  controlEpoch: string; protectionMode: string };
type TitleState = { contentHead: string; basis: { head: string | null; epoch: string; protection: string | null } };
type GraphWrite = { receipt: string; replayed: boolean; protectionRevision?: string; sourcePosition: { sequence: string } };
type Saved = { event: string; command: CommandEnvelope };

async function fixture(apps: Record<string, string>) {
  const account = await ratingAccount(apps, 'openid work:create work:edit work:read work:protect work:correct work:review');
  const pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const native = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
  const commands: Saved[] = [];
  let hook: { marker: string; run: (command: CommandEnvelope) => Promise<CommandEnvelope | CommandResult> } | null = null;
  const fuseki = new Proxy(native, { get(target, property) {
    if (property === 'commandWithReceipt') return async (command: CommandEnvelope): Promise<CommandResult> => {
      const event = /a rv:(Work(?:TitleControl|Protection(?:Tightened|Relaxed|Confirmed))Event)/.exec(command.update)?.[1] ?? '';
      if (event) commands.push({ event, command });
      if (hook && command.update.includes(hook.marker)) {
        const selected = hook; hook = null;
        const result = await selected.run(command);
        return 'status' in result ? result : target.commandWithReceipt(result);
      }
      return target.commandWithReceipt(command);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as FusekiClient;
  const environment = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
    objectDirectory: resolve('.temp', `validation-protection-${randomUUID()}`) };
  const access = new AccessAdmissionRegistry(pool, apps.FUSEKI_TITLE_ADMISSION_KEY);
  const signer = new ProtectionAdmissionSigner(pool, apps.FUSEKI_TITLE_ADMISSION_KEY);
  const app = createMainApp(fuseki, { environment, account: account.verifier, access, protectionSigner: signer });
  const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  const principal = randomUUID();
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principal, account.issuer, account.a.id]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const grant = async (scope: string, action: string) => {
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principal, actor, action]);
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  };
  const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(new Request(
    `http://main.local${path}`, { method, headers: { authorization: `Bearer ${account.tokenA}`,
      'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const value = await response.json();
    if (response.status !== status) console.error('validation protection response', response.status, value);
    expect(response.status).toBe(status);
    return value as T;
  };
  await grant('work:create:root', 'work.create');
  const create = async () => {
    const written = await json<{ work: string; workRevision: string; mainVersion: string }>(await call('POST', '/v1/works',
      { profile: 'metadata-only-v1', language: 'en', title: `Validation Work ${randomUUID()}`, actingSubject: actor }), 201);
    await grant(`work:read:${written.work}`, 'work.read');
    await grant(`work:edit:${written.work}`, 'work.edit');
    await grant(`work:protect:${written.work}`, 'work.protection.tighten');
    return written;
  };
  const editorial = async (work: string) => json<EditorialState>(await call('GET',
    `/v1/works/${shortId(work)}/editorial-state?actingSubject=${encodeURIComponent(actor)}`), 200);
  const title = async (work: string) => json<TitleState>(await call('GET',
    `/v1/works/${shortId(work)}/title-control?actingSubject=${encodeURIComponent(actor)}`), 200);
  const protect = (work: string, basis: EditorialState, action: 'tighten' | 'relax' = 'tighten') => ({
    profile: 'work-title-protection-v1', action, work, expectedHead: basis.contentHead,
    expectedProtection: basis.protectionHead, expectedControl: basis.controlHead,
    expectedControlEpoch: basis.controlEpoch, expectedRuleRevision: PROTECTION_RULE,
    actingSubject: actor, reason: 'Review changed title', evidence: [],
  });
  const successful = async (receipt: string) => (await native.query(`PREFIX rv: ${iri(RV)} ASK {
    GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} rv:outcome rv:Succeeded } }`)).boolean === true;
  const cancelled = async (receipt: string) => (await native.query(`PREFIX rv: ${iri(RV)} ASK {
    GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} rv:outcome rv:Cancelled } }`)).boolean === true;
  const event = async (receipt: string, kind: string) => (await native.query(`PREFIX rv: ${iri(RV)} ASK {
    GRAPH ${iri(OUTBOX)} { ?event a rv:${kind} ; rv:receipt ${iri(receipt)} } }`)).boolean === true;
  return { account, pool, native, commands, actor, grant, call, json, create, editorial, title, protect,
    successful, cancelled, event,
    intercept: (marker: string, run: (command: CommandEnvelope) => Promise<CommandEnvelope | CommandResult>) => {
      hook = { marker, run };
    },
    close: async () => { await pool.end(); await account.close(); } };
}

function barrier() {
  let entered!: () => void, release!: () => void;
  return { ready: new Promise<void>(resolve => { entered = resolve; }),
    waiting: new Promise<void>(resolve => { release = resolve; }),
    entered: () => entered(), release: () => release() };
}

async function reached(ready: Promise<void>, pending: Promise<Response>, label: string): Promise<void> {
  await Promise.race([ready, pending.then(response => {
    throw new Error(`${label} settled before the command barrier: ${response.status}`);
  }), Bun.sleep(10_000).then(() => { throw new Error(`${label} did not reach the command barrier`); })]);
}

test('MODEL18/MODEL23: real protection and edit routes serialize absent protection and one success receipt', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const f = await fixture(Bun.env as Record<string, string>);
  try {
    const first = await f.create();
    const before = await f.editorial(first.work);
    const firstTitle = await f.title(first.work);
    expect(before.protectionHead).toBeNull();
    const editBody = { profile: 'metadata-only-v1', work: first.work, expectedHead: before.contentHead,
      title: 'Prepared unprotected edit', titleControl: firstTitle.basis, actingSubject: f.actor };
    const heldEdit = barrier();
    f.intercept('WorkTitleControlEvent', async command => { heldEdit.entered(); await heldEdit.waiting; return command; });
    const pendingEdit = f.call('POST', '/v1/content-edits', editBody);
    await reached(heldEdit.ready, pendingEdit, 'Work edit');
    const protectedWrite = await f.json<GraphWrite>(await f.call('POST', '/v1/work-title-protections',
      f.protect(first.work, before)), 201);
    heldEdit.release();
    expect((await pendingEdit).status).toBe(409);
    const lostEdit = f.commands.find(item => item.event === 'WorkTitleControlEvent'
      && item.command.update.includes(iri(first.work)))!.command;
    expect(await f.successful(protectedWrite.receipt)).toBe(true);
    expect(await f.successful(lostEdit.receipt)).toBe(false);
    expect(await f.cancelled(lostEdit.receipt)).toBe(true);
    expect(await f.event(lostEdit.receipt, 'WorkTitleControlEvent')).toBe(true);
    expect(await f.editorial(first.work)).toMatchObject({ contentHead: before.contentHead,
      protectionHead: protectedWrite.protectionRevision });
    expect((await f.call('POST', '/v1/content-edits', editBody)).status).toBe(409);

    const second = await f.create();
    const secondBefore = await f.editorial(second.work);
    const secondTitle = await f.title(second.work);
    const heldProtection = barrier();
    f.intercept('WorkProtectionTightenedEvent', async command => {
      heldProtection.entered(); await heldProtection.waiting; return command;
    });
    const pendingProtection = f.call('POST', '/v1/work-title-protections', f.protect(second.work, secondBefore));
    await reached(heldProtection.ready, pendingProtection, 'Work protection');
    const edited = await f.json<{ revision: string }>(await f.call('POST', '/v1/content-edits', {
      profile: 'metadata-only-v1', work: second.work, expectedHead: secondBefore.contentHead,
      title: 'Edit won first', titleControl: secondTitle.basis, actingSubject: f.actor }), 200);
    heldProtection.release();
    expect((await pendingProtection).status).toBe(409);
    const lostProtection = f.commands.find(item => item.event === 'WorkProtectionTightenedEvent'
      && item.command.update.includes(iri(second.work)))!.command;
    expect(await f.successful(lostProtection.receipt)).toBe(false);
    expect(await f.event(lostProtection.receipt, 'WorkProtectionTightenedEvent')).toBe(false);
    expect(await f.editorial(second.work)).toMatchObject({ contentHead: edited.revision, protectionHead: null });
  } finally { await f.close(); }
}, 180_000);

test('MODEL15/MODEL16/MODEL17/MODEL24/MODEL27: protected Work rejects missing basis, footprint bypass and deadline', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const apps = Bun.env as Record<string, string>;
  const f = await fixture(apps);
  try {
    const created = await f.create();
    const before = await f.editorial(created.work);
    const first = f.protect(created.work, before);
    const { expectedControl: _missingControl, ...withoutControl } = first;
    expect((await f.call('POST', '/v1/work-title-protections', withoutControl)).status).toBe(400);
    const { expectedProtection: _missingProtection, ...withoutProtection } = first;
    expect((await f.call('POST', '/v1/work-title-protections', withoutProtection)).status).toBe(400);
    expect((await f.call('POST', '/v1/work-title-protections', { ...first, sourceOrigin: 'human' })).status).toBe(400);
    expect((await f.call('POST', '/v1/work-title-protections', { ...first, scope: 'resource-wide' })).status).toBe(400);
    const protection = await f.json<GraphWrite>(await f.call('POST', '/v1/work-title-protections', first), 201);
    const protectedState = await f.editorial(created.work);
    expect(protectedState.protectionHead).toBe(protection.protectionRevision);
    await f.grant(`work:protect:${created.work}`, 'work.protection.relax');
    const relax = f.protect(created.work, protectedState, 'relax');
    const triples = [
      `${iri(created.work)} a <https://schema.org/CreativeWork> .`,
      `${iri(created.work)} <${RV}mainVersion> ${iri(created.mainVersion)} .`,
      `${iri(created.mainVersion)} a <${RV}MainVersion> .`,
    ];
    for (const triple of triples) {
      f.intercept('WorkProtectionRelaxedEvent', async command => {
        const changed = { ...command, update: command.update.replace('DELETE {',
          `DELETE { GRAPH ${iri(CURRENT)} { ${triple} }`) };
        const claims = JSON.parse(command.titleAdmission!.payload) as string[];
        changed.titleAdmission = signProtectionAdmission({ id: claims[1]!, action: claims[2]!,
          scope: claims[3]!, authorityEpoch: claims[4]! }, changed, claims[8]!, claims[9] || null,
        apps.FUSEKI_TITLE_ADMISSION_KEY);
        return changed;
      });
      expect((await f.call('POST', '/v1/work-title-protections', relax)).status).toBe(409);
      expect((await f.editorial(created.work)).protectionHead).toBe(protection.protectionRevision);
      const last = f.commands.filter(item => item.event === 'WorkProtectionRelaxedEvent').at(-1)!.command;
      expect(await f.successful(last.receipt)).toBe(false);
      expect(await f.cancelled(last.receipt)).toBe(true);
      expect(await f.event(last.receipt, 'WorkProtectionRelaxedEvent')).toBe(false);
      expect((await f.native.query(`ASK { GRAPH ${iri(CURRENT)} { ${triple} } }`)).boolean).toBe(true);
    }
    expect((await f.native.query(`ASK { GRAPH ${iri(CURRENT)} {
      ${iri(created.mainVersion)} a <${RV}MainVersion> . } }`)).boolean).toBe(true);

    f.intercept('WorkProtectionRelaxedEvent', async command => ({ status: 'deadline' }));
    const pending = await f.call('POST', '/v1/work-title-protections', relax);
    expect(pending.status).toBe(202);
    const deadlineCommand = f.commands.filter(item => item.event === 'WorkProtectionRelaxedEvent').at(-1)!.command;
    expect(await f.successful(deadlineCommand.receipt)).toBe(false);
    expect((await f.editorial(created.work)).protectionHead).toBe(protection.protectionRevision);
  } finally { await f.close(); }
}, 180_000);
