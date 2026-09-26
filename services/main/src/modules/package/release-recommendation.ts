import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { readComponentState, RevisionCorrupt } from '../work/history.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';

export const PACKAGE_RECOMMENDATION_PROFILE =
  'https://rezics.com/definition/main-package-release-recommendation-v1';
const SET_SHAPE = `${PACKAGE_RECOMMENDATION_PROFILE}/set-shape`;
const ITEM_SHAPE = `${PACKAGE_RECOMMENDATION_PROFILE}/recommendation-shape`;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const MAX_RECOMMENDATIONS = 16;

export type PackageReleaseRecommendation = {
  ecosystem: string;
  packageName: string;
  selector: { kind: 'version-constraint' | 'exact-release'; value: string };
};
export interface MainPackageRecommendationSet {
  work: string;
  mainVersion: string;
  revision: string | null;
  recommendations: PackageReleaseRecommendation[];
  sourcePosition?: { datasetId: 'product'; dataEpoch: string; sequence: string };
}
export interface SetMainPackageRecommendationsInput {
  work: string;
  mainVersion: string;
  expectedRevision: string | null;
  recommendations: PackageReleaseRecommendation[];
  actingSubject: string;
  idempotencyKey: string;
}

export class PackageRecommendationInvalid extends Error {}
export class PackageRecommendationUnavailable extends Error {}
export class PackageRecommendationStale extends Error {}
export class PackageRecommendationConflict extends Error {}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function checkedRecommendations(input: unknown): PackageReleaseRecommendation[] {
  if (!Array.isArray(input) || input.length > MAX_RECOMMENDATIONS) {
    throw new PackageRecommendationInvalid('recommendation set exceeds the 16 item limit');
  }
  const seen = new Set<string>();
  return input.map((raw, position) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PackageRecommendationInvalid(`recommendation ${position} is malformed`);
    }
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['ecosystem', 'packageName', 'selector'].includes(key))) {
      throw new PackageRecommendationInvalid(`recommendation ${position} has unknown fields`);
    }
    const selector = value.selector as Record<string, unknown> | null;
    if (typeof value.ecosystem !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.ecosystem)
      || typeof value.packageName !== 'string' || value.packageName.length > 256
      || /[\u0000-\u0020]/.test(value.packageName)
      || !selector || typeof selector !== 'object' || Array.isArray(selector)
      || Object.keys(selector).some(key => !['kind', 'value'].includes(key))
      || !['version-constraint', 'exact-release'].includes(String(selector.kind))
      || typeof selector.value !== 'string' || selector.value.length < 1 || selector.value.length > 256
      || /[\u0000-\u001f\u007f]/.test(selector.value)) {
      throw new PackageRecommendationInvalid(`recommendation ${position} is malformed`);
    }
    const identity = `${value.ecosystem}\0${value.packageName}`;
    if (seen.has(identity)) throw new PackageRecommendationInvalid('package coordinate is duplicated');
    seen.add(identity);
    return { ecosystem: value.ecosystem, packageName: value.packageName,
      selector: { kind: selector.kind as PackageReleaseRecommendation['selector']['kind'], value: selector.value } };
  });
}

export function mainPackageRecommendationsDigest(input: SetMainPackageRecommendationsInput): string {
  const recommendations = checkedRecommendations(input.recommendations);
  if (!nativeId.test(input.work) || !nativeId.test(input.mainVersion) || !nativeId.test(input.actingSubject)
    || (input.expectedRevision !== null && !nativeId.test(input.expectedRevision))
    || !keyPattern.test(input.idempotencyKey)) {
    throw new PackageRecommendationInvalid('invalid Main Version recommendation intent');
  }
  return hash(stable({ family: 'main-package-release-recommendation-v1', work: input.work,
    mainVersion: input.mainVersion, expectedRevision: input.expectedRevision, recommendations }));
}

export function packageRecommendationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0main-package-release-recommendation`)}`;
}

interface RecommendationTerminal extends GraphTerminalProof {
  reason?: 'stale-head' | 'main-unavailable' | 'cancelled';
  work?: string;
  mainVersion?: string;
  revision?: string;
  expectedRevision?: string | null;
}

export async function readPackageRecommendationTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<RecommendationTerminal | null> {
  const receipt = packageRecommendationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?work ?main ?revision ?prior WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:mainVersion ?main ;
        rv:packageRecommendationRevision ?revision .
        OPTIONAL { ${iri(receipt)} rv:expectedRecommendationHead ?prior } }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const get = (key: string) => row[key]?.value;
  const outcome = get('outcome') === `${RV}Succeeded` ? 'succeeded'
    : get('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reasonValue = row.reason?.value;
  const reason = reasonValue === `${RV}StaleHead` ? 'stale-head'
    : reasonValue === `${RV}MainUnavailable` ? 'main-unavailable'
      : reasonValue === `${RV}Cancelled` ? 'cancelled' : undefined;
  if (rows.length !== 1 || !outcome || !get('digest') || !get('id') || !get('epoch')
    || !get('scope') || !get('dataEpoch') || !/^\d+$/.test(get('sequence') ?? '')
    || (reasonValue && !reason)
    || (outcome === 'succeeded' && (!get('work') || !get('main') || !get('revision') || reason))
    || (outcome === 'cancelled' && (get('work') || get('main') || get('revision') || !reason))) {
    throw new RevisionCorrupt('package recommendation receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt, admissionId: get('id')!,
    requestDigest: get('digest')!, authorityEpoch: get('epoch')!, scope: get('scope')!,
    dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(outcome === 'succeeded' ? { work: get('work'), mainVersion: get('main'),
      revision: get('revision'), expectedRevision: get('prior') ?? null } : {}) };
}

function receiptMatches(terminal: RecommendationTerminal, admission: RegisteredAdmission): boolean {
  return terminal.admissionId === admission.id && terminal.requestDigest === admission.requestDigest
    && terminal.authorityEpoch === admission.authorityEpoch && terminal.scope === admission.scope;
}

async function sealRecommendationCancelled(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, reason: 'stale-head' | 'main-unavailable' | 'cancelled'):
  Promise<RecommendationTerminal> {
  const receipt = packageRecommendationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0terminal`)}`;
  await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:reason rv:${reason === 'stale-head' ? 'StaleHead' : reason === 'main-unavailable' ? 'MainUnavailable' : 'Cancelled'} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
  const terminal = await readPackageRecommendationTerminal(env, admission.id);
  if (!terminal || !receiptMatches(terminal, admission)) {
    throw new Error('package recommendation terminal receipt is unavailable');
  }
  return terminal;
}

export async function sealPackageRecommendationAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<RecommendationTerminal> {
  if (admission.action !== 'package.recommendation.set') throw new Error('unsupported package recommendation action');
  const previous = await readPackageRecommendationTerminal(env, admission.id);
  if (previous) {
    if (!receiptMatches(previous, admission)) throw new IdempotencyConflict('package recommendation receipt differs');
    return previous;
  }
  return sealRecommendationCancelled(env, admission, 'cancelled');
}

async function mainRecommendationHead(env: WorkActivationEnvironment, work: string, mainVersion: string):
  Promise<{ head: string | null; valid: boolean }> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a <https://schema.org/CreativeWork> ; rv:mainVersion ${iri(mainVersion)} .
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ${iri(work)} .
      OPTIONAL { ${iri(mainVersion)} rv:packageRecommendationHead ?head }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || (rows[0]?.head && !nativeId.test(rows[0].head.value))) {
    return { head: null, valid: false };
  }
  return { head: rows[0]?.head?.value ?? null, valid: true };
}

async function activatePackageRecommendations(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SetMainPackageRecommendationsInput,
  recommendations: PackageReleaseRecommendation[]): Promise<void> {
  const receipt = packageRecommendationReceiptIri(admission.id);
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const predecessor = input.expectedRevision;
  const manifest = prepareComponent(env.objectDirectory, revision, {
    work: input.work, mainVersion: input.mainVersion, predecessor, recommendations,
  }, PACKAGE_RECOMMENDATION_PROFILE);
  const items = recommendations.map((recommendation, position) => {
    const item = `urn:rezics:package-recommendation:${hash(`${revision}\0${position}`)}`;
    const kind = recommendation.selector.kind === 'exact-release' ? 'ExactRelease' : 'VersionConstraint';
    return { iri: item, recommendation, position, kind };
  });
  const insertItems = items.map(item => `${iri(item.iri)} a rv:PackageReleaseRecommendation ;
    rv:ecosystem ${lit(item.recommendation.ecosystem)} ;
    rv:packageName ${lit(item.recommendation.packageName)} ;
    rv:selectorKind rv:${item.kind} ; rv:selector ${lit(item.recommendation.selector.value)} ;
    rv:position ${item.position} .`).join('\n');
  const predecessorDelete = predecessor ? `rv:packageRecommendationHead ${iri(predecessor)}`
    : 'rv:packageRecommendationHead ?prior';
  const predecessorFilter = predecessor
    ? `FILTER(?prior = ${iri(predecessor)})`
    : 'FILTER(!BOUND(?prior))';
  const predecessorRevision = predecessor ? `rv:predecessor ${iri(predecessor)} ;` : '';
  const predecessorReceipt = predecessor ? `rv:expectedRecommendationHead ${iri(predecessor)} ;` : '';
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.mainVersion)} ${predecessorDelete} . } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.mainVersion)} rv:packageRecommendationHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor, rv:PackageReleaseRecommendationSet ;
          rv:component ${iri(input.mainVersion)} ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.mainVersion)} ; ${predecessorRevision}
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(PACKAGE_RECOMMENDATION_PROFILE)} ;
          rv:shapeRevision ${iri(PACKAGE_RECOMMENDATION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ${items.map(item => `; rv:recommendation ${iri(item.iri)}`).join(' ')} .
        ${insertItems}
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:outcome rv:Succeeded ; rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:packageRecommendationRevision ${iri(revision)} ; ${predecessorReceipt}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
          rv:event ${iri(`urn:rezics:event:${hash(`${operation}\0recommendations`)}`)} .
        ${iri(`urn:rezics:event:${hash(`${operation}\0recommendations`)}`)}
          a rv:PackageReleaseRecommendationSetEvent ; rv:ordinal 0 ;
          rv:action "package.recommendation.set" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ;
        rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork ;
        rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        OPTIONAL { ${iri(input.mainVersion)} rv:packageRecommendationHead ?prior } }
      ${predecessorFilter}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations: CommandValidation[] = await profileValidations(env.fuseki,
    'main-package-release-recommendation-v1', [
      { shape: SET_SHAPE, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
      ...items.map(item => ({ shape: ITEM_SHAPE, focus: [item.iri],
        graphs: [GRAPHS.current, GRAPHS.revisions] })),
    ]);
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
    validations, update, deadlineMs: 10_000 }, admission);
  if (result.status !== 'committed') {
    await assertNotInvalidProfileReceipt(env.fuseki, receipt);
    throw new CommandRejected(result);
  }
}

export async function setAdmittedMainPackageRecommendations(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: SetMainPackageRecommendationsInput):
  Promise<MainPackageRecommendationSet & { receipt: string; replayed: boolean }> {
  const recommendations = checkedRecommendations(input.recommendations);
  const digest = mainPackageRecommendationsDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit', 'package:recommendation-set']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'package.recommendation.set',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealPackageRecommendationAdmission(env, admission);
      } else {
        const current = await mainRecommendationHead(env, input.work, input.mainVersion);
        if (!current.valid) await sealRecommendationCancelled(env, admission, 'main-unavailable');
        else if (current.head !== input.expectedRevision) {
          await sealRecommendationCancelled(env, admission, 'stale-head');
        } else {
          try { await activatePackageRecommendations(env, admission, input, recommendations); }
          catch (error) {
            if (error instanceof IdempotencyConflict) throw error;
            if (error instanceof CommandRejected) {
              if (error.result.status !== 'guard-unmatched') throw error;
              const after = await mainRecommendationHead(env, input.work, input.mainVersion);
              if (!after.valid || after.head === input.expectedRevision) throw error;
              await sealRecommendationCancelled(env, admission, 'stale-head');
            }
            const terminal = await readPackageRecommendationTerminal(env, admission.id);
            if (!terminal) {
              const after = await mainRecommendationHead(env, input.work, input.mainVersion);
              if (after.valid && after.head !== input.expectedRevision) {
                await sealRecommendationCancelled(env, admission, 'stale-head');
              }
            }
          }
        }
      }
    }
    const terminal = await readPackageRecommendationTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    if (!receiptMatches(terminal, registered)) throw new PackageRecommendationConflict('recommendation receipt differs');
    if (terminal.outcome === 'cancelled') {
      if (terminal.reason === 'stale-head') throw new PackageRecommendationStale('recommendation head is stale');
      throw new PackageRecommendationUnavailable('recommendation command was unavailable or cancelled');
    }
    if (terminal.work !== input.work || terminal.mainVersion !== input.mainVersion
      || terminal.expectedRevision !== input.expectedRevision || !terminal.revision) {
      throw new PackageRecommendationConflict('recommendation receipt targets another intent');
    }
    return { ...(await readMainPackageRecommendations(env, input.mainVersion, terminal.revision)),
      receipt: terminal.receipt, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof CommandRejected || error instanceof PackageRecommendationStale
      || error instanceof PackageRecommendationUnavailable
      || error instanceof PackageRecommendationConflict || error instanceof IdempotencyConflict) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}

export async function readMainPackageRecommendations(env: WorkActivationEnvironment,
  mainVersion: string, exactRevision?: string): Promise<MainPackageRecommendationSet> {
  if (!nativeId.test(mainVersion) || (exactRevision !== undefined && !nativeId.test(exactRevision))) {
    throw new PackageRecommendationInvalid('invalid Main Version recommendation reference');
  }
  const association = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work .
      OPTIONAL { ${iri(mainVersion)} rv:packageRecommendationHead ?head }
    }
  } LIMIT 2`);
  const linked = association.results?.bindings ?? [];
  if (linked.length !== 1 || !linked[0]?.work?.value || !nativeId.test(linked[0].work.value)) {
    throw new PackageRecommendationUnavailable('Main Version is unavailable');
  }
  const work = linked[0].work.value;
  const revision = exactRevision ?? linked[0].head?.value ?? null;
  if (!revision) return { work, mainVersion, revision: null, recommendations: [] };
  const rows = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?manifest ?predecessor ?recommendation ?ecosystem ?name ?kind ?selector ?position ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:RevisionAnchor, rv:PackageReleaseRecommendationSet ;
        rv:component ${iri(mainVersion)} ; rv:work ${iri(work)} ; rv:mainVersion ${iri(mainVersion)} ;
        rv:manifest ?manifest ; rv:sequence ?sequence .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      OPTIONAL { ${iri(revision)} rv:recommendation ?recommendation .
        ?recommendation a rv:PackageReleaseRecommendation ; rv:ecosystem ?ecosystem ;
          rv:packageName ?name ; rv:selectorKind ?kind ; rv:selector ?selector ; rv:position ?position }
    }
  } ORDER BY ?position LIMIT ${MAX_RECOMMENDATIONS + 1}`);
  const bindings = rows.results?.bindings ?? [];
  if (!bindings.length || bindings.length > MAX_RECOMMENDATIONS
    || bindings.some(row => !row.manifest || !row.sequence || !/^\d+$/.test(row.sequence.value))) {
    throw new PackageRecommendationUnavailable('exact recommendation revision is unavailable');
  }
  const mapped: PackageReleaseRecommendation[] = bindings.filter(row => row.recommendation).map(row => {
    const kind = row.kind?.value === `${RV}ExactRelease` ? 'exact-release'
      : row.kind?.value === `${RV}VersionConstraint` ? 'version-constraint' : null;
    if (!kind || !row.ecosystem || !row.name || !row.selector || !row.position) {
      throw new RevisionCorrupt('package recommendation item is incomplete');
    }
    return { ecosystem: row.ecosystem.value, packageName: row.name.value,
      selector: { kind, value: row.selector.value } };
  });
  const state = readComponentState(env.objectDirectory, bindings[0]!.manifest!.value,
    revision, PACKAGE_RECOMMENDATION_PROFILE) as { work?: unknown; mainVersion?: unknown;
      predecessor?: unknown; recommendations?: unknown };
  if (state.work !== work || state.mainVersion !== mainVersion
    || (state.predecessor ?? null) !== (bindings[0]!.predecessor?.value ?? null)
    || stable(state.recommendations) !== stable(mapped)) {
    throw new RevisionCorrupt('recommendation graph differs from its exact manifest');
  }
  const positionResult = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?position WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:recommendation ?item .
      ?item rv:position ?position . } } LIMIT ${MAX_RECOMMENDATIONS + 1}`);
  const positions = (positionResult.results?.bindings ?? []).map(row => Number(row.position?.value));
  if (positions.length !== mapped.length || positions.some((position, index) => position !== index)) {
    throw new RevisionCorrupt('recommendation ordering is incomplete');
  }
  const latest = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(mainVersion)} a rv:MainVersion ; rv:work ${iri(work)} . } }`);
  if (latest.boolean !== true) throw new PackageRecommendationUnavailable('Main Version changed during exact read');
  return { work, mainVersion, revision, recommendations: mapped,
    sourcePosition: { datasetId: 'product', dataEpoch: env.lineage.dataEpoch,
      sequence: bindings[0]!.sequence!.value } };
}
