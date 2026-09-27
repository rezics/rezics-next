import { createHash } from 'node:crypto';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { checkFirstPartyBundle, type FirstPartyBundle } from './first-party-bundle.ts';
import { firstPartyReceiptIri } from './receipt-family.ts';
import { ThemeDenied, ThemeInvalid, ThemePending, ThemeStale, ThemeUnavailable } from './activation.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTROL = 'urn:rezics:theme:control:first-party';
const INITIAL = 'urn:rezics:theme:control:initial';
const FAMILY = 'first-party-theme-v1';
export const FIRST_PARTY_COST = { graphReads: 1, commandGraphReads: 2, graphWrites: 1,
  maxFiles: 64, maxSlots: 32 } as const;

type Action = 'create' | 'revise' | 'review' | 'activate' | 'revoke' | 'control';
type Common = { action: Action; actingSubject: string; idempotencyKey: string };
export type FirstPartyCommand = Common & { theme?: string; owner?: string; hostZone?: string;
  expectedRevision?: string | null; bundle?: FirstPartyBundle; revision?: string;
  decision?: 'approved' | 'rejected'; reviewEvidenceDigest?: string;
  expectedActivation?: string | null;
  approvalExpiresAt?: string; disabled?: boolean; expectedControl?: string | null };

export interface FirstPartyView {
  theme: string; owner: string; hostZone: string; revision: string | null;
  dependencyDigest: string | null; bundle: FirstPartyBundle | null;
  submitter: string | null; review: string | null; reviewer: string | null;
  submitterPrincipal: string | null; reviewerPrincipal: string | null;
  decision: 'approved' | 'rejected' | null; reviewEvidenceDigest: string | null;
  activation: string | null; activationRevision: string | null;
  approvalExpiresAt: string | null; revoked: boolean;
  control: string | null; globallyDisabled: boolean; activationControl: string | null;
}

export async function readFirstPartyControl(env: WorkActivationEnvironment) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?disabled ?actor ?at WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(CONTROL)} a rv:FirstPartyThemeControlHead ;
      rv:controlHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:FirstPartyThemeControl ;
      rv:disabled ?disabled ; rv:changedBy ?actor ; rv:createdAt ?at . }
  } LIMIT 2`, 4096);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return { profile: 'first-party-control-v1' as const,
    control: null, disabled: false, changedBy: null, changedAt: null };
  if (rows.length !== 1 || !rows[0]?.head?.value || !rows[0]?.actor?.value
    || !rows[0]?.at?.value || !['true', 'false'].includes(rows[0]?.disabled?.value ?? '')) {
    throw new ThemeUnavailable('first-party execution control is ambiguous');
  }
  return { profile: 'first-party-control-v1' as const, control: rows[0].head.value,
    disabled: rows[0].disabled!.value === 'true', changedBy: rows[0].actor.value,
    changedAt: rows[0].at.value };
}

function id(value: string | null | undefined, label: string): string {
  if (!value || !NATIVE.test(value) || !UUID.test(value.slice(ID.length))) {
    throw new ThemeInvalid(`invalid ${label}`);
  }
  return value;
}
function optionalId(value: string | null | undefined, label: string): string | null {
  return value === null || value === undefined ? null : id(value, label);
}
function uuid(value: string | null | undefined, label: string): string {
  if (!value || !UUID.test(value)) throw new ThemeInvalid(`invalid ${label}`);
  return value;
}
function deterministicId(admission: RegisteredAdmission): string {
  const bytes = createHash('sha256').update(`${FAMILY}\0${admission.id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${ID}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function normalize(input: FirstPartyCommand): FirstPartyCommand {
  id(input.actingSubject, 'actor');
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)) throw new ThemeInvalid('invalid idempotency key');
  if (input.action !== 'control') uuid(input.theme, 'theme');
  if (input.action === 'create') {
    id(input.owner, 'owner'); id(input.hostZone, 'host Zone');
    if (input.owner !== input.actingSubject) throw new ThemeDenied('theme owner differs from actor');
  }
  if (input.action === 'revise') {
    optionalId(input.expectedRevision, 'expected revision');
    if (!input.bundle) throw new ThemeInvalid('bundle is required');
    const checked = checkFirstPartyBundle(input.bundle);
    return { ...input, bundle: checked.bundle };
  }
  if (input.action === 'review') {
    id(input.revision, 'revision');
    if (input.decision !== 'approved' && input.decision !== 'rejected') throw new ThemeInvalid('invalid review decision');
    if (!DIGEST.test(input.reviewEvidenceDigest ?? '')) throw new ThemeInvalid('review evidence digest is required');
  }
  if (input.action === 'activate') {
    id(input.revision, 'revision'); optionalId(input.expectedActivation, 'expected activation');
    const expiry = Date.parse(input.approvalExpiresAt ?? '');
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== input.approvalExpiresAt) {
      throw new ThemeInvalid('activation expiry must be an exact UTC instant');
    }
  }
  if (input.action === 'revoke') id(input.expectedActivation, 'activation');
  if (input.action === 'control') {
    optionalId(input.expectedControl, 'expected control');
    if (typeof input.disabled !== 'boolean') throw new ThemeInvalid('control requires disabled');
  }
  return input;
}
function scope(input: FirstPartyCommand): string {
  return input.action === 'control' ? 'theme:control:global'
    : input.action === 'create' ? 'theme:create:root'
      : `theme:${input.action}:${input.theme}`;
}
function readRow(row: Record<string, { value: string } | undefined>, name: string) {
  return row[name]?.value ?? null;
}

/** One bounded graph read. Only pointers in the current graph determine effective execution. */
export async function readFirstPartyTheme(env: WorkActivationEnvironment,
  themeUuid: string): Promise<FirstPartyView | null> {
  uuid(themeUuid, 'theme');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const theme = `${ID}${themeUuid}`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?owner ?host ?revision ?digest ?bundle
    ?submitter ?submitterPrincipal ?review ?reviewer ?reviewerPrincipal ?decision ?evidence
    ?activation ?activationRevision ?expiry ?revocation
    ?control ?disabled ?activationControl WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(theme)} a rv:FirstPartyTheme ; rv:themeOwner ?owner ;
      rv:hostZone ?host .
      OPTIONAL { ${iri(theme)} rv:themeRevisionHead ?revision }
      OPTIONAL { ${iri(theme)} rv:themeActivationHead ?activation }
      OPTIONAL { ${iri(CONTROL)} rv:controlHead ?control }
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:FirstPartyThemeRevision ;
      rv:dependencyDigest ?digest ; rv:bundle ?bundle ; rv:submittedBy ?submitter ;
      rv:submittedPrincipal ?submitterPrincipal . } }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?revision rv:reviewHead ?review }
      GRAPH ${iri(GRAPHS.revisions)} { ?review rv:reviewedBy ?reviewer ;
        rv:reviewerPrincipal ?reviewerPrincipal ; rv:decision ?decision ;
        rv:reviewEvidenceDigest ?evidence . } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?activation a rv:FirstPartyThemeActivation ;
      rv:revision ?activationRevision ; rv:approvalExpiresAt ?expiry ; rv:controlBasis ?activationControl . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?activation rv:revocation ?revocation } } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?control rv:disabled ?disabled } }
  } LIMIT 2`, 32_000);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ThemeUnavailable('first-party theme pointers are ambiguous');
  const row = rows[0]!;
  const owner = readRow(row, 'owner'), hostZone = readRow(row, 'host');
  if (!owner || !hostZone) throw new ThemeUnavailable('first-party theme identity is incomplete');
  const revision = readRow(row, 'revision');
  const rawBundle = readRow(row, 'bundle');
  let bundle: FirstPartyBundle | null = null;
  if (revision) {
    if (!rawBundle || !readRow(row, 'digest') || !readRow(row, 'submitter')) {
      throw new ThemeUnavailable('first-party revision is incomplete');
    }
    try {
      const checked = checkFirstPartyBundle(JSON.parse(rawBundle));
      if (checked.dependencyDigest !== readRow(row, 'digest') || checked.bundle.hostZone !== hostZone) {
        throw new ThemeUnavailable('first-party bundle digest or host differs');
      }
      bundle = checked.bundle;
    } catch { throw new ThemeUnavailable('first-party bundle is invalid'); }
  }
  const activation = readRow(row, 'activation');
  if (activation && (!readRow(row, 'activationRevision') || !readRow(row, 'expiry')
    || !readRow(row, 'activationControl'))) {
    throw new ThemeUnavailable('first-party activation is incomplete');
  }
  const control = readRow(row, 'control'), disabled = readRow(row, 'disabled');
  if (control && disabled !== 'true' && disabled !== 'false') {
    throw new ThemeUnavailable('first-party execution control is incomplete');
  }
  return { theme, owner, hostZone, revision, dependencyDigest: readRow(row, 'digest'), bundle,
    submitter: readRow(row, 'submitter'), submitterPrincipal: readRow(row, 'submitterPrincipal'),
    review: readRow(row, 'review'), reviewer: readRow(row, 'reviewer'),
    reviewerPrincipal: readRow(row, 'reviewerPrincipal'),
    reviewEvidenceDigest: readRow(row, 'evidence'),
    decision: readRow(row, 'decision') === `${RV}Approved`
      ? 'approved' : readRow(row, 'decision') === `${RV}Rejected` ? 'rejected' : null,
    activation, activationRevision: readRow(row, 'activationRevision'),
    approvalExpiresAt: readRow(row, 'expiry'), revoked: !!readRow(row, 'revocation'),
    control, globallyDisabled: disabled === 'true',
    activationControl: readRow(row, 'activationControl') };
}

export function firstPartyExecution(view: FirstPartyView | null, hostZone: string, now = Date.now()):
  { state: 'active'; package: FirstPartyBundle; revision: string; activation: string }
  | { state: 'fallback'; reason: 'none_approved' | 'globally_disabled' | 'revoked' | 'expired' } {
  if (view?.globallyDisabled) return { state: 'fallback', reason: 'globally_disabled' };
  if (!view || view.hostZone !== hostZone || !view.activation || !view.bundle
    || view.activationRevision !== view.revision || view.decision !== 'approved'
    || view.reviewer === view.submitter || !view.submitterPrincipal
    || !view.reviewerPrincipal || view.reviewerPrincipal === view.submitterPrincipal
    || view.activationControl !== (view.control ?? INITIAL)) {
    return { state: 'fallback', reason: 'none_approved' };
  }
  if (view.revoked) return { state: 'fallback', reason: 'revoked' };
  if (!view.approvalExpiresAt || !Number.isFinite(Date.parse(view.approvalExpiresAt))
    || Date.parse(view.approvalExpiresAt) <= now) {
    return { state: 'fallback', reason: 'expired' };
  }
  return { state: 'active', package: view.bundle, revision: view.revision!,
    activation: view.activation };
}

/** The web's package gate consumes the reviewed source digest. Older asset-only
 * approvals retain their existing active report until they are reviewed again. */
export function zonePackageExecution(view: FirstPartyView | null, hostZone: string, now = Date.now()) {
  const execution = firstPartyExecution(view, hostZone, now);
  return execution.state === 'active' && execution.package.packageDigest
    ? { state: 'package' as const, packageDigest: execution.package.packageDigest,
      revision: execution.revision, activation: execution.activation }
    : execution;
}

interface Terminal { outcome: 'succeeded' | 'cancelled'; reason: string | null;
  operation: string; receipt: string; requestDigest: string; admissionId: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string; actor: string;
  action: string; theme: string | null }
async function readTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<Terminal | null> {
  const receipt = firstPartyReceiptIri(admission.id);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?operation ?digest
    ?admission ?authority ?scope ?epoch ?sequence ?actor ?action ?theme WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome ?outcome ; rv:operation ?operation ;
      rv:requestDigest ?digest ; rv:admissionId ?admission ; rv:authorityEpoch ?authority ;
      rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
      rv:actor ?actor ; rv:action ?action .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:component ?theme }
    } } LIMIT 2`, 8_000);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ThemeUnavailable('first-party receipt is ambiguous');
  const row = rows[0]!;
  const get = (key: string) => readRow(row, key);
  const outcome = get('outcome') === `${RV}Succeeded` ? 'succeeded'
    : get('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || !get('operation') || !get('digest') || !get('admission') || !get('authority')
    || !get('scope') || !get('epoch') || !get('sequence') || !get('actor') || !get('action')) {
    throw new ThemeUnavailable('first-party receipt is incomplete');
  }
  return { outcome, reason: get('reason'), operation: get('operation')!, receipt,
    requestDigest: get('digest')!, admissionId: get('admission')!, authorityEpoch: get('authority')!,
    scope: get('scope')!, dataEpoch: get('epoch')!, sequence: get('sequence')!,
    actor: get('actor')!, action: get('action')!, theme: get('theme') };
}

function mutation(input: FirstPartyCommand, operation: string,
  principalId: string): { deletes: string; inserts: string; guard: string } {
  const theme = input.action === 'control' ? null : `${ID}${input.theme}`;
  const op = iri(operation), target = theme ? iri(theme) : iri(CONTROL);
  const ownerGuard = input.action === 'create' || input.action === 'control' ? ''
    : `GRAPH ${iri(GRAPHS.current)} { ${target} a rv:FirstPartyTheme ;
        rv:themeOwner ?themeOwner ; rv:hostZone ?hostZone . }
      ${input.action === 'review' ? '' : `FILTER(?themeOwner = ${iri(input.actingSubject)})`}`;
  if (input.action === 'create') return { deletes: '',
    inserts: `${target} a rv:FirstPartyTheme ; rv:themeOwner ${iri(input.owner!)} ;
      rv:hostZone ${iri(input.hostZone!)} .`,
    guard: `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${target} ?p ?o } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.hostZone!)} a rv:Zone ;
        rv:zoneState rv:Active ; rv:disclosure rv:Public . }` };
  if (input.action === 'revise') {
    const checked = checkFirstPartyBundle(input.bundle);
    const old = input.expectedRevision ? iri(input.expectedRevision) : null;
    return { deletes: old ? `${target} rv:themeRevisionHead ${old} .` : '',
      inserts: `${target} rv:themeRevisionHead ${op} .
        GRAPH ${iri(GRAPHS.revisions)} { ${op} a rv:FirstPartyThemeRevision ;
          rv:component ${target} ; rv:hostZone ?hostZone ; rv:submittedBy ${iri(input.actingSubject)} ;
          rv:submittedPrincipal ${lit(principalId)} ;
          rv:dependencyDigest ${lit(checked.dependencyDigest)} ;
          rv:bundle ${lit(JSON.stringify(checked.bundle))} ;
          ${old ? `rv:predecessor ${old} ;` : ''} rv:createdAt ?now . }`,
      guard: `${ownerGuard}
        FILTER(?hostZone = ${iri(checked.bundle.hostZone)})
        ${old ? `GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeRevisionHead ${old} . }`
          : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeRevisionHead ?old . } }`}` };
  }
  if (input.action === 'review') return { deletes: '',
    inserts: `${iri(input.revision!)} a rv:FirstPartyThemeReviewSlot ; rv:reviewHead ${op} .
      GRAPH ${iri(GRAPHS.revisions)} { ${op} a rv:FirstPartyThemeReview ;
        rv:component ${target} ; rv:revision ${iri(input.revision!)} ;
        rv:reviewedBy ${iri(input.actingSubject)} ; rv:reviewerPrincipal ${lit(principalId)} ;
        rv:decision rv:${input.decision === 'approved' ? 'Approved' : 'Rejected'} ;
        rv:reviewEvidenceDigest ${lit(input.reviewEvidenceDigest!)} ;
        rv:createdAt ?now . }`,
    guard: `${ownerGuard}
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.revision!)} a rv:FirstPartyThemeRevision ;
        rv:component ${target} ; rv:submittedBy ?submitter ;
        rv:submittedPrincipal ?submitterPrincipal . }
      FILTER(?submitter != ${iri(input.actingSubject)} && ?submitterPrincipal != ${lit(principalId)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.revision!)} rv:reviewHead ?old . } }` };
  if (input.action === 'activate') {
    const old = input.expectedActivation ? iri(input.expectedActivation) : null;
    return { deletes: old ? `${target} rv:themeActivationHead ${old} .` : '',
      inserts: `${target} rv:themeActivationHead ${op} .
        GRAPH ${iri(GRAPHS.revisions)} { ${op} a rv:FirstPartyThemeActivation ;
          rv:component ${target} ; rv:revision ${iri(input.revision!)} ;
          rv:review ?review ; rv:hostZone ?hostZone ;
          rv:controlBasis ?controlBasis ; rv:approvedBy ${iri(input.actingSubject)} ;
          rv:approvalExpiresAt ${lit(input.approvalExpiresAt!)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
          rv:createdAt ?now . }`,
      guard: `${ownerGuard}
        GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeRevisionHead ${iri(input.revision!)} .
          ${iri(input.revision!)} rv:reviewHead ?review .
        }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.revision!)} rv:submittedBy ?submitter ;
          rv:submittedPrincipal ?submitterPrincipal ; rv:hostZone ?hostZone .
          ?review rv:reviewedBy ?reviewer ; rv:reviewerPrincipal ?reviewerPrincipal ;
            rv:decision rv:Approved . }
        FILTER(?reviewer != ?submitter && ?reviewerPrincipal != ?submitterPrincipal)
        FILTER(NOW() < ${lit(input.approvalExpiresAt!)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
        GRAPH ${iri(GRAPHS.current)} { ?hostZone a rv:Zone ; rv:zoneState rv:Active ;
          rv:disclosure rv:Public . }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(CONTROL)} rv:controlHead ?control . } }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?control rv:disabled ?disabled . } }
        FILTER(!BOUND(?disabled) || ?disabled = false)
        BIND(COALESCE(?control, ${iri(INITIAL)}) AS ?controlBasis)
        ${old ? `GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeActivationHead ${old} . }`
          : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeActivationHead ?old . } }`}` };
  }
  if (input.action === 'revoke') return { deletes: '',
    inserts: `${iri(input.expectedActivation!)} a rv:FirstPartyThemeRevocationSlot ; rv:revocation ${op} .
      GRAPH ${iri(GRAPHS.revisions)} { ${op} a rv:FirstPartyThemeRevocation ;
        rv:component ${target} ; rv:activation ${iri(input.expectedActivation!)} ;
        rv:revokedBy ${iri(input.actingSubject)} ; rv:createdAt ?now . }`,
    guard: `${ownerGuard}
      GRAPH ${iri(GRAPHS.current)} { ${target} rv:themeActivationHead ${iri(input.expectedActivation!)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.expectedActivation!)} rv:revocation ?prior . } }` };
  const old = input.expectedControl ? iri(input.expectedControl) : null;
  return { deletes: old ? `${iri(CONTROL)} rv:controlHead ${old} .` : '',
    inserts: `${iri(CONTROL)} a rv:FirstPartyThemeControlHead ; rv:controlHead ${op} .
      GRAPH ${iri(GRAPHS.revisions)} { ${op} a rv:FirstPartyThemeControl ;
        rv:disabled ${input.disabled} ; rv:changedBy ${iri(input.actingSubject)} ;
        rv:createdAt ?now . }`,
    guard: old ? `GRAPH ${iri(GRAPHS.current)} { ${iri(CONTROL)} rv:controlHead ${old} . }`
      : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(CONTROL)} rv:controlHead ?old . } }` };
}

function update(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: FirstPartyCommand, digest: string, cancelled: false | 'stale' | 'denied'): string {
  const receipt = firstPartyReceiptIri(admission.id), operation = deterministicId(admission);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const target = input.action === 'control' ? CONTROL : `${ID}${input.theme}`;
  const change = cancelled ? { deletes: '', inserts: '', guard: '' }
    : mutation(input, operation, admission.principalId);
  const reason = cancelled === 'stale' ? 'rv:StaleHead' : 'rv:Unavailable';
  const eventKind = `FirstPartyTheme${input.action[0]!.toUpperCase()}${input.action.slice(1)}`
    + `${cancelled === 'stale' ? 'Stale' : cancelled === 'denied' ? 'Denied' : ''}Event`;
  return `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${change.deletes ? `GRAPH ${iri(GRAPHS.current)} { ${change.deletes} }` : ''} }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${change.inserts ? change.inserts.includes(`GRAPH ${iri(GRAPHS.revisions)}`)
        ? `GRAPH ${iri(GRAPHS.current)} { ${change.inserts.replace(
          `GRAPH ${iri(GRAPHS.revisions)}`, `} GRAPH ${iri(GRAPHS.revisions)}`)}`
        : `GRAPH ${iri(GRAPHS.current)} { ${change.inserts} }` : ''}
      ${cancelled ? '' : `GRAPH ${iri(GRAPHS.revisions)} { ${iri(operation)} rv:operationAction ${lit(input.action)} ;
        rv:actor ${iri(input.actingSubject)} ; rv:requestDigest ${lit(digest)} ;
        rv:admissionId ${lit(admission.id)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }`}
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:commandFamily ${lit(FAMILY)} ; rv:action ${lit(admission.action)} ;
        rv:operation ${iri(operation)} ; rv:actor ${iri(input.actingSubject)} ;
        rv:component ${iri(target)} ; rv:requestDigest ${lit(digest)} ;
        rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:${cancelled ? 'Cancelled' : 'Succeeded'} ;
        ${cancelled ? `rv:reason ${reason} ;` : ''}
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${eventKind} ;
          rv:ordinal 0 ; rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} . }
    }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)}
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ;
      rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${change.guard}
      BIND(NOW() AS ?now)
      BIND(?n + 1 AS ?next) }`;
}

/** Access admission, Jena graph, receipt and outbox are replayed as one command. */
export async function writeFirstPartyTheme(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, raw: FirstPartyCommand) {
  const input = normalize(raw);
  const digest = hash(JSON.stringify({ family: FAMILY, ...input }));
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [input.action === 'control' ? 'owner:operate'
    : 'theme:approve']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: scope(input), action: `theme.${input.action}`, idempotencyKey: input.idempotencyKey,
    requestDigest: digest });
  let terminal = await readTerminal(env, registered);
  if (!terminal && registered.state === 'sealed') throw new ThemePending('sealed theme admission lacks a graph receipt');
  if (!terminal) {
    let admission = registered;
    if (registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    const registeredAt = Date.parse(admission.registeredAt ?? new Date().toISOString());
    const expiry = Date.parse(input.approvalExpiresAt ?? '');
    const invalidExpiry = input.action === 'activate' && (expiry <= registeredAt
      || expiry > registeredAt + 90 * 86_400_000);
    if (admission.state === 'claimed' && admission.dispatchEligible && !invalidExpiry) {
      const operation = deterministicId(admission);
      const shape = `https://rezics.com/definition/theme-first-party-v1/${
        input.action === 'create' ? 'theme' : input.action === 'revise' ? 'revision'
          : input.action === 'activate' ? 'activation' : input.action === 'revoke'
            ? 'revocation' : input.action}-shape`;
      const validations = await profileValidations(env.fuseki, 'theme-first-party-v1', [{
        shape, focus: [input.action === 'create' ? `${ID}${input.theme}` : operation],
        graphs: [input.action === 'create' ? GRAPHS.current : GRAPHS.revisions],
      }, ...(input.action === 'review' ? [{
        shape: 'https://rezics.com/definition/theme-first-party-v1/review-slot-shape',
        focus: [input.revision!], graphs: [GRAPHS.current],
      }] : input.action === 'revoke' ? [{
        shape: 'https://rezics.com/definition/theme-first-party-v1/revocation-slot-shape',
        focus: [input.expectedActivation!], graphs: [GRAPHS.current],
      }] : input.action === 'control' ? [{
        shape: 'https://rezics.com/definition/theme-first-party-v1/control-head-shape',
        focus: [CONTROL], graphs: [GRAPHS.current],
      }] : [])]);
      const result = await env.fuseki.commandWithReceipt({ receipt: firstPartyReceiptIri(admission.id),
        digest, validations, deadlineMs: 10_000, update: update(env, admission, input, digest, false) });
      if (result.status === 'guard-unmatched') {
        await env.fuseki.commandWithReceipt({ receipt: firstPartyReceiptIri(admission.id),
          digest, validations: [], deadlineMs: 10_000, update: update(env, admission, input, digest, 'stale') });
      } else if (result.status !== 'committed') throw new ThemePending('theme graph outcome is pending');
    } else {
      await env.fuseki.commandWithReceipt({ receipt: firstPartyReceiptIri(admission.id),
        digest, validations: [], deadlineMs: 10_000, update: update(env, admission, input, digest, 'denied') });
    }
    terminal = await readTerminal(env, registered);
  }
  if (!terminal) throw new ThemePending('theme graph receipt is pending');
  if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
    || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope
    || terminal.actor !== input.actingSubject || terminal.action !== registered.action
    || terminal.theme !== (input.action === 'control' ? CONTROL : `${ID}${input.theme}`)) {
    throw new ThemeUnavailable('theme receipt differs from its Access admission');
  }
  try {
    await access.recordGraphOutcome(registered.id, { outcome: terminal.outcome, receipt: terminal.receipt,
      admissionId: terminal.admissionId, requestDigest: terminal.requestDigest,
      authorityEpoch: terminal.authorityEpoch, scope: terminal.scope,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence });
  } catch { throw new ThemePending('theme Access reconciliation is pending'); }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === `${RV}StaleHead`) throw new ThemeStale('theme command precondition changed');
    throw new ThemeDenied('theme command was not admitted');
  }
  return { profile: 'first-party-theme-result-v1' as const, theme: terminal.theme,
    operation: terminal.operation, receipt: terminal.receipt, replayed: registered.replayed,
    sourcePosition: { datasetId: 'product', dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence }, cost: FIRST_PARTY_COST };
}
