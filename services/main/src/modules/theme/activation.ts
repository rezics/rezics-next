import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired,
  type AccessAdmissionRegistry, type RegisteredAdmission } from '../access/admission.ts';
import { CommandOutcomeUnknown, CommandRejected, type CommandResult } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { themeReceiptIri } from './receipt-family.ts';
import { ThemeStore, ThemeStoreConflict, ThemeStoreUnavailable,
  type ThemeActivationRecord, type ThemeCapabilities } from './store.ts';

export const THEME_APPROVE_SCOPE = 'theme:approve';
export const THEME_READ_SCOPE = 'theme:read';
export const THEME_ACTIVATION_FAMILY = 'theme-activation-v1';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const THEME_PROFILE = 'https://rezics.com/definition/theme-activation-v1';

export interface ThemeActivationIntent {
  theme: string;
  owner: string;
  expectedRevision: string | null;
  dependencyDigest: string;
  origin: string;
  capabilities: ThemeCapabilities;
  approvalExpiresAt: string;
  actingSubject: string;
}

export interface ThemeTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head' | 'unavailable' | 'invalid-profile';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  record?: ThemeActivationRecord;
}

export class ThemeInvalid extends Error {}
export class ThemeStale extends Error {}
export class ThemeDenied extends Error {}
export class ThemePending extends Error {}
export class ThemeUnavailable extends Error {}

export function canonicalCapabilities(value: ThemeCapabilities): ThemeCapabilities {
  if (!value || value.data !== 'public-only' || value.secrets !== false
    || !Array.isArray(value.networkOrigins) || value.networkOrigins.length > 16
    || new Set(value.networkOrigins).size !== value.networkOrigins.length
    || !Number.isInteger(value.cpuMs) || value.cpuMs < 100 || value.cpuMs > 5000
    || !Number.isInteger(value.memoryMiB) || value.memoryMiB < 16 || value.memoryMiB > 256) {
    throw new ThemeInvalid('theme capabilities exceed the admitted sandbox profile');
  }
  const networkOrigins = value.networkOrigins.map(origin => normalizeOrigin(origin)).sort();
  return { data: 'public-only', secrets: false, networkOrigins,
    cpuMs: value.cpuMs, memoryMiB: value.memoryMiB };
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ThemeInvalid('invalid HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || url.origin !== value) {
    throw new ThemeInvalid('theme origins must be exact HTTPS origins');
  }
  return url.origin;
}

function canonicalIntent(input: ThemeActivationIntent): ThemeActivationIntent {
  if (!UUID.test(input.theme) || !NATIVE.test(input.owner) || !NATIVE.test(input.actingSubject)
    || (input.expectedRevision !== null && !UUID.test(input.expectedRevision))
    || !DIGEST.test(input.dependencyDigest)) throw new ThemeInvalid('invalid theme activation identity or digest');
  if (input.owner !== input.actingSubject) throw new ThemeDenied('only the theme owner can approve an activation');
  const origin = normalizeOrigin(input.origin);
  const capabilities = canonicalCapabilities(input.capabilities);
  if (capabilities.networkOrigins.some(item => item.length > 512)) throw new ThemeInvalid('invalid network origin');
  const expiry = Date.parse(input.approvalExpiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== input.approvalExpiresAt) {
    throw new ThemeInvalid('approval expiry must be an exact UTC timestamp');
  }
  return { ...input, origin, capabilities };
}

function intentDigest(input: ThemeActivationIntent): string {
  const capabilities = canonicalCapabilities(input.capabilities);
  return hash(JSON.stringify({ profile: THEME_ACTIVATION_FAMILY,
    theme: input.theme, owner: input.owner, expectedRevision: input.expectedRevision,
    dependencyDigest: input.dependencyDigest, origin: input.origin, capabilities,
    approvalExpiresAt: input.approvalExpiresAt, actingSubject: input.actingSubject }));
}

function uuidFor(value: string): string {
  const bytes = createHash('sha256').update(`rezics-theme-v1\0${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function activationRevision(admission: RegisteredAdmission): string {
  return uuidFor(`revision\0${admission.id}`);
}
function approvalId(admission: RegisteredAdmission): string {
  return uuidFor(`approval\0${admission.id}`);
}
function operationId(admission: RegisteredAdmission): string {
  return `urn:rezics:operation:${hash(`${admission.id}\0${THEME_ACTIVATION_FAMILY}`)}`;
}
function nativeUuid(value: string): string {
  if (!NATIVE.test(value) || !UUID.test(value.slice(ID.length))) {
    throw new ThemeUnavailable('theme receipt contains an invalid native identifier');
  }
  return value.slice(ID.length);
}
function batchAndEvent(receipt: string) {
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  return { batch, event: `urn:rezics:event:${hash(`${batch}\0event`)}` };
}

interface ReceiptRow {
  outcome: string;
  reason?: string;
  rejectionKind?: string;
  digest: string;
  admission: string;
  authority: string;
  scope: string;
  epoch: string;
  sequence: string;
  theme?: string;
  revision?: string;
  predecessor?: string;
  owner?: string;
  dependencyDigest?: string;
  capabilityDigest?: string;
  capabilities?: string;
  origin?: string;
  runtime?: string;
  approval?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalExpiresAt?: string;
  approvalGeneration?: string;
}

async function readReceipt(env: WorkActivationEnvironment, admissionId: string): Promise<ThemeTerminal | null> {
  const receipt = themeReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?rejectionKind ?digest ?admission ?authority ?scope ?epoch ?sequence
    ?theme ?revision ?predecessor ?owner ?dependencyDigest ?capabilityDigest ?capabilities ?origin ?runtime
    ?approval ?approvedBy ?approvedAt ?approvalExpiresAt ?approvalGeneration WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
      rv:admissionId ?admission ; rv:authorityEpoch ?authority ; rv:admittedScope ?scope ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?rejectionKind }
      OPTIONAL {
        ${iri(receipt)} rv:component ?theme ; rv:revision ?revision .
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:predecessor ?predecessor . } }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:themeOwner ?owner ;
          rv:dependencyDigest ?dependencyDigest ; rv:capabilityDigest ?capabilityDigest ; rv:capabilities ?capabilities ;
          rv:origin ?origin ; rv:runtime ?runtime ; rv:approvalId ?approval ; rv:approvedBy ?approvedBy ;
          rv:approvedAt ?approvedAt ; rv:approvalExpiresAt ?approvalExpiresAt ; rv:approvalGeneration ?approvalGeneration . }
        }
      }
    }
  } LIMIT 2`, 24_000);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ThemeUnavailable('theme activation receipt is ambiguous');
  const row = Object.fromEntries(Object.entries(rows[0]!).map(([key, binding]) => [key, binding?.value])) as Partial<ReceiptRow>;
  const outcome = row.outcome === `${RV}Succeeded` ? 'succeeded'
    : row.outcome === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = row.reason === `${RV}StaleHead` ? 'stale-head'
    : row.reason === `${RV}Unavailable` ? 'unavailable'
      : row.reason === `${RV}InvalidProfile` || row.rejectionKind === `${RV}InvalidProfile`
        ? 'invalid-profile' : undefined;
  if (!outcome || !row.digest || !row.admission || !row.authority || !row.scope || !row.epoch
    || !/^[0-9]+$/.test(row.sequence ?? '') || (outcome === 'succeeded'
      && (!row.theme || !row.revision || !row.owner || !row.dependencyDigest || !row.capabilityDigest
        || !row.capabilities || !row.origin || !row.runtime || !row.approval || !row.approvedBy
        || !row.approvedAt || !row.approvalExpiresAt || !row.approvalGeneration))) {
    throw new ThemeUnavailable('theme activation receipt is incomplete');
  }
  const terminal: ThemeTerminal = { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: row.admission, requestDigest: row.digest, authorityEpoch: row.authority,
    scope: row.scope, dataEpoch: row.epoch, sequence: row.sequence! };
  if (outcome === 'succeeded') {
    let capabilities: ThemeCapabilities;
    try { capabilities = JSON.parse(row.capabilities!) as ThemeCapabilities; }
    catch { throw new ThemeUnavailable('theme capability receipt is malformed'); }
    terminal.record = { theme: nativeUuid(row.theme!), revision: nativeUuid(row.revision!),
      predecessor: row.predecessor ? nativeUuid(row.predecessor) : null,
      approvalGeneration: row.approvalGeneration!, owner: row.owner!, dependencyDigest: row.dependencyDigest!,
      capabilityDigest: row.capabilityDigest!, capabilities, origin: row.origin!,
      runtime: row.runtime as ThemeActivationRecord['runtime'], approvalId: nativeUuid(row.approval!),
      approvedBy: row.approvedBy!, approvedAt: row.approvedAt!, approvalExpiresAt: row.approvalExpiresAt!,
      graphReceipt: receipt, graphDataEpoch: row.epoch!, graphSequence: row.sequence! };
  }
  return terminal;
}

function successUpdate(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: ThemeActivationIntent, digest: string): string {
  const receipt = themeReceiptIri(admission.id), { batch, event } = batchAndEvent(receipt);
  const revisionId = activationRevision(admission);
  const revision = `${ID}${revisionId}`;
  const approval = `${ID}${approvalId(admission)}`;
  const theme = `${ID}${input.theme}`;
  const predecessor = input.expectedRevision ? `${ID}${input.expectedRevision}` : null;
  const approvedAt = admission.registeredAt ?? new Date().toISOString();
  const capabilities = JSON.stringify(input.capabilities);
  const capabilitiesDigest = capabilityDigest(input.capabilities);
  const datetime = (value: string) => `${JSON.stringify(value)}^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
  const predecessorTriple = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
  const predecessorGuard = predecessor
    ? `FILTER(?oldHead = ${iri(predecessor)})
      GRAPH ${iri(GRAPHS.revisions)} { ?oldHead rv:approvalGeneration ?previousGeneration . }`
    : 'FILTER(!BOUND(?oldHead))';
  const generationTriple = input.expectedRevision
    ? 'rv:approvalGeneration ?nextApprovalGeneration ;'
    : 'rv:approvalGeneration 1 ;';
  const generationBind = input.expectedRevision
    ? 'BIND(?previousGeneration + 1 AS ?nextApprovalGeneration)'
    : '';
  return `PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(theme)} rv:themeHead ?oldHead }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(theme)} a rv:CustomTheme ; rv:themeHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ThemeActivation, rv:RevisionAnchor ;
        rv:component ${iri(theme)} ; ${predecessorTriple} rv:themeOwner ${iri(input.owner)} ;
        rv:dependencyDigest ${lit(input.dependencyDigest)} ; rv:capabilityDigest ${lit(capabilitiesDigest)} ;
        rv:capabilities ${lit(capabilities)} ; rv:origin ${lit(input.origin)} ;
        rv:runtime "worker-isolated-v1" ;
        rv:approvalId ${iri(approval)} ; rv:approvedBy ${iri(input.actingSubject)} ;
        rv:approvedAt ${datetime(approvedAt)} ; rv:approvalExpiresAt ${datetime(input.approvalExpiresAt)} ;
        ${generationTriple} rv:operation ${iri(operationId(admission))} ; rv:modelRevision ${iri(THEME_PROFILE)} ;
        rv:shapeRevision ${iri(THEME_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:commandFamily ${lit(THEME_ACTIVATION_FAMILY)} ; rv:action ${lit(admission.action)} ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Succeeded ; rv:component ${iri(theme)} ; rv:revision ${iri(revision)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ThemeActivationEvent ; rv:ordinal 0 ; rv:action ${lit(admission.action)} ;
          rv:receipt ${iri(receipt)} ; rv:component ${iri(theme)} ; rv:revision ${iri(revision)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(theme)} rv:themeHead ?oldHead . } }
      ${predecessorGuard}
      ${generationBind}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
}

function terminalUpdate(env: WorkActivationEnvironment, admission: RegisteredAdmission, digest: string,
  reason: 'stale-head' | 'unavailable'): string {
  const receipt = themeReceiptIri(admission.id), { batch, event } = batchAndEvent(receipt);
  const stale = reason === 'stale-head';
  return `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:commandFamily ${lit(THEME_ACTIVATION_FAMILY)} ; rv:action ${lit(admission.action)} ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:reason rv:${stale ? 'StaleHead' : 'Unavailable'} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${stale ? 'ThemeActivationStaleEvent' : 'ThemeActivationCancelledEvent'} ;
          rv:ordinal 0 ; rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
}

async function readThemeGraph(env: WorkActivationEnvironment, theme: string) {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?owner ?dependencyDigest ?capabilityDigest
    ?origin ?runtime ?approval ?approvedBy ?approvedAt ?approvalExpiresAt ?approvalGeneration WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(`${ID}${theme}`)} a rv:CustomTheme ; rv:themeHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ThemeActivation ; rv:component ${iri(`${ID}${theme}`)} ;
      rv:themeOwner ?owner ; rv:dependencyDigest ?dependencyDigest ; rv:capabilityDigest ?capabilityDigest ;
      rv:origin ?origin ; rv:runtime ?runtime ; rv:approvalId ?approval ; rv:approvedBy ?approvedBy ;
      rv:approvedAt ?approvedAt ; rv:approvalExpiresAt ?approvalExpiresAt ; rv:approvalGeneration ?approvalGeneration . }
  } LIMIT 2`, 4096);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new ThemeUnavailable('theme current head is ambiguous');
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  if (!value('head') || !value('owner') || !value('dependencyDigest') || !value('capabilityDigest')
    || !value('origin') || !value('runtime') || !value('approval') || !value('approvedBy')
    || !value('approvedAt') || !value('approvalExpiresAt') || !value('approvalGeneration')) {
    throw new ThemeUnavailable('theme graph approval is incomplete');
  }
  return { head: value('head')!, owner: value('owner')!, dependencyDigest: value('dependencyDigest')!,
    capabilityDigest: value('capabilityDigest')!, origin: value('origin')!, runtime: value('runtime')!,
    approvalId: value('approval')!, approvedBy: value('approvedBy')!, approvedAt: value('approvedAt')!,
    approvalExpiresAt: value('approvalExpiresAt')!, approvalGeneration: value('approvalGeneration')! };
}

function proof(admission: RegisteredAdmission, terminal: ThemeTerminal) {
  return { outcome: terminal.outcome, receipt: terminal.receipt, admissionId: admission.id,
    requestDigest: terminal.requestDigest, authorityEpoch: terminal.authorityEpoch,
    scope: terminal.scope, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
}

function assertTerminalMatches(terminal: ThemeTerminal, admission: RegisteredAdmission, digest: string) {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new ThemeUnavailable('theme activation receipt differs from its admission');
  }
}

/** Account approves; Access gates the exact theme; Jena atomically advances its activation head. */
export async function activateTheme(env: WorkActivationEnvironment, store: ThemeStore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, raw: ThemeActivationIntent & { idempotencyKey: string }) {
  const input = canonicalIntent(raw);
  const digest = intentDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [THEME_APPROVE_SCOPE]);
  const scope = `theme:approve:${input.theme}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'theme.approve', idempotencyKey: raw.idempotencyKey, requestDigest: digest });
  let terminal = await readReceipt(env, registered.id);
  if (!terminal && registered.state === 'sealed') throw new ThemePending('sealed Access admission has no graph receipt');
  if (!terminal) {
    let admission = registered;
    let denied = false;
    if (admission.dispatchEligible) {
      try { admission = await access.claim(admission.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
        denied = true;
      }
    } else denied = true;

    const registeredAt = Date.parse(admission.registeredAt ?? new Date().toISOString());
    const expiry = Date.parse(input.approvalExpiresAt);
    if (expiry <= registeredAt || expiry > registeredAt + 90 * 24 * 60 * 60 * 1000) denied = true;
    if (!denied && admission.state === 'claimed' && admission.dispatchEligible) {
      const revision = activationRevision(admission);
      const validations = await profileValidations(env.fuseki, 'theme-activation-v1', [
        { shape: 'https://rezics.com/definition/theme-activation-v1/theme-shape',
          focus: [`${ID}${input.theme}`], graphs: [GRAPHS.current, GRAPHS.revisions] },
        { shape: 'https://rezics.com/definition/theme-activation-v1/activation-shape',
          focus: [`${ID}${revision}`], graphs: [GRAPHS.revisions] },
      ]);
      const current = await store.read(input.theme);
      const contentHead = current?.revision ?? null;
      if (contentHead !== input.expectedRevision) {
        const cancelled = await env.fuseki.commandWithReceipt({ receipt: themeReceiptIri(admission.id), digest,
          validations: [], deadlineMs: 10_000,
          update: terminalUpdate(env, admission, digest, 'stale-head') });
        if (cancelled.status !== 'committed') throw new ThemePending('stale theme activation awaits a terminal receipt');
        terminal = await readReceipt(env, admission.id);
      } else {
        const result = await validatedCommand(env, { receipt: themeReceiptIri(admission.id), digest,
          validations, deadlineMs: 10_000, update: successUpdate(env, admission, input, digest) }, admission);
        if (result.status === 'guard-unmatched') {
          const cancelled = await env.fuseki.commandWithReceipt({ receipt: themeReceiptIri(admission.id), digest,
            validations: [], deadlineMs: 10_000, update: terminalUpdate(env, admission, digest, 'stale-head') });
          if (cancelled.status !== 'committed') throw new ThemePending('stale theme activation awaits a terminal receipt');
          terminal = await readReceipt(env, admission.id);
        } else if (result.status !== 'committed') {
          if (result.status === 'invalid') {
            terminal = await readReceipt(env, admission.id);
          } else if (result.status === 'conflict') throw new AdmissionConflict('theme idempotency receipt conflicts');
          else throw new CommandRejected(result as Exclude<CommandResult, { status: 'committed' }>);
        }
      }
    } else {
      await env.fuseki.commandWithReceipt({ receipt: themeReceiptIri(admission.id), digest,
        validations: [], deadlineMs: 10_000,
        update: terminalUpdate(env, admission, digest, 'unavailable') });
    }
    terminal ??= await readReceipt(env, admission.id);
  }
  if (!terminal) throw new CommandOutcomeUnknown('theme activation receipt is unavailable');
  assertTerminalMatches(terminal, registered, digest);
  if (terminal.outcome === 'succeeded') {
    if (!terminal.record) throw new ThemeUnavailable('theme activation record is missing');
    try { await store.record(terminal.record); }
    catch (error) {
      if (error instanceof ThemeStoreConflict) throw new ThemePending('theme activation awaits Content projection');
      if (error instanceof ThemeStoreUnavailable) throw new ThemePending('theme activation awaits Content availability');
      throw new ThemePending('theme activation awaits Content projection');
    }
  }
  try { await access.recordGraphOutcome(registered.id, proof(registered, terminal)); }
  catch { throw new ThemePending('theme activation awaits Access receipt reconciliation'); }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'stale-head') throw new ThemeStale('theme activation basis changed');
    if (terminal.reason === 'invalid-profile') throw new ThemeInvalid('theme activation failed model validation');
    throw new ThemeDenied('theme approval was not admitted');
  }
  return { ...terminal.record!, replayed: registered.replayed, active: Date.parse(terminal.record!.approvalExpiresAt) > Date.now() };
}

/** Fail closed when Content and the live Jena head disagree after partial recovery. */
export async function readTheme(env: WorkActivationEnvironment, store: ThemeStore, theme: string) {
  if (!UUID.test(theme)) throw new ThemeInvalid('invalid theme id');
  const record = await store.read(theme);
  if (!record) return null;
  const graphHead = await readThemeGraph(env, theme);
  if (!graphHead || graphHead.head !== `${ID}${record.revision}`
    || graphHead.owner !== record.owner || graphHead.dependencyDigest !== record.dependencyDigest
    || graphHead.capabilityDigest !== record.capabilityDigest || graphHead.origin !== record.origin
    || graphHead.runtime !== record.runtime || graphHead.approvalId !== `${ID}${record.approvalId}`
    || graphHead.approvedBy !== record.approvedBy
    || Date.parse(graphHead.approvedAt) !== Date.parse(record.approvedAt)
    || Date.parse(graphHead.approvalExpiresAt) !== Date.parse(record.approvalExpiresAt)
    || graphHead.approvalGeneration !== record.approvalGeneration) {
    throw new ThemeUnavailable('theme graph head differs from retained approval history');
  }
  const expired = Date.parse(record.approvalExpiresAt) <= Date.now();
  return { ...record, state: expired ? 'expired' as const : 'active' as const, active: !expired };
}

function capabilityDigest(value: ThemeCapabilities): string {
  return hash(JSON.stringify(canonicalCapabilities(value)));
}
