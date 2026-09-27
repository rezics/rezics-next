import { Value } from 'typebox/value';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { avatarImageEligible, DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../media/store.ts';
import type { GovernanceRules } from '../governance/rules.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict, PendingActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { checkedProfile, nativeId, publicProfile, REALM_PROFILE,
  RealmProfileInvalid, RealmProfileMissing, RealmProfileStale, RealmProfileUnavailable,
  type PublicProfile } from './schema.ts';

type Account = Pick<AccountAssertionVerifier, 'verify'>;
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;
const FAMILY = 'realm-public-profile-v1';
const MAX_GRAPH_READ_BYTES = 64 * 1024;

export interface ProfilePublicationInput {
  realm: string; expectedHead: string | null; actingSubject: string;
  idempotencyKey: string; profile: PublicProfile;
}
export interface ModeratorChoiceInput {
  realm: string; agent: string; expectedHead: string | null;
  public: boolean; actingSubject: string; idempotencyKey: string;
}
interface Terminal { outcome: 'succeeded' | 'cancelled'; reason?: string; receipt: string;
  admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
  dataEpoch: string; sequence: string; revision?: string; realm?: string }

export const receiptIri = (admissionId: string) =>
  `urn:rezics:receipt:${hash(`${admissionId}\0${FAMILY}`)}`;
export const moderatorSlot = (realm: string, agent: string) =>
  `urn:rezics:realm-public-moderator:${hash(`${realm}\0${agent}`)}`;

function guard(env: WorkActivationEnvironment) {
  return `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;
}
function receiptTriples(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  receipt: string, outcome: 'Succeeded' | 'Cancelled', extra = '') {
  return `${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
    rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:${outcome} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:sequence ?next ${extra ? `; ${extra}` : ''} .`;
}
function outboxTriples(env: WorkActivationEnvironment, receipt: string,
  operation?: string, action?: string, realm?: string) {
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  return `${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:sequence ?next ; rv:eventCount ${operation ? 1 : 0}${operation ? ` ; rv:event ${iri(event)}` : ''} .
    ${operation ? `${iri(event)} a rv:${action === 'realm.profile.publish'
      ? 'RealmPublicProfilePublishedEvent' : 'RealmModeratorPublicChoiceChangedEvent'} ; rv:ordinal 0 ;
      rv:action ${lit(action!)} ; rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ;
      rv:realm ${iri(realm!)} .` : ''}`;
}

async function readTerminal(env: WorkActivationEnvironment, admissionId: string): Promise<Terminal | null> {
  const receipt = receiptIri(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?kind ?digest
    ?id ?epoch ?scope ?dataEpoch ?sequence ?realm ?revision WHERE { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
      rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
      rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
    OPTIONAL { ${iri(receipt)} rv:reason ?reason }
    OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind }
    OPTIONAL { ${iri(receipt)} rv:realm ?realm ; rv:profileRevision ?revision }
  } } LIMIT 2`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.outcome || !row.digest || !row.id || !row.epoch
    || !row.scope || !row.dataEpoch || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RealmProfileUnavailable('Realm profile receipt is incomplete');
  }
  const outcome = row.outcome.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome) throw new RealmProfileUnavailable('Realm profile receipt outcome is invalid');
  return { outcome, receipt, admissionId: row.id.value, requestDigest: row.digest.value,
    authorityEpoch: row.epoch.value, scope: row.scope.value,
    dataEpoch: row.dataEpoch.value, sequence: row.sequence!.value,
    ...(row.reason || row.kind ? { reason: row.reason?.value ?? row.kind?.value } : {}),
    ...(row.realm ? { realm: row.realm.value } : {}),
    ...(row.revision ? { revision: row.revision.value } : {}) };
}

async function cancel(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'StaleHead' | 'InvalidProfile'): Promise<Terminal> {
  const receipt = receiptIri(admission.id);
  const prior = await readTerminal(env, admission.id);
  if (prior) return prior;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, admission, receipt,
        'Cancelled', reason ? `rv:reason rv:${reason}` : '')} }
      GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt)} } }
    WHERE { ${guard(env)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    update, validations: [], deadlineMs: 10_000 }); } catch { /* receipt resolves a lost response */ }
  const terminal = await readTerminal(env, admission.id);
  if (!terminal) throw new PendingActivation('Realm profile cancellation outcome is unknown');
  return terminal;
}

function checkedTerminal(terminal: Terminal, admission: RegisteredAdmission) {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('Realm profile receipt differs from admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === `${RV}StaleHead`) throw new RealmProfileStale('Realm profile head changed');
    if (terminal.reason === `${RV}InvalidProfile`) throw new RealmProfileInvalid('Realm profile was rejected');
    throw new AdmissionDenied('Realm profile admission was cancelled');
  }
  if (!terminal.revision || !terminal.realm) throw new RealmProfileUnavailable('Realm profile receipt lacks a revision');
  return terminal;
}

async function admit(env: WorkActivationEnvironment, account: Account, access: Access,
  request: Request, input: { action: string; scope: string; oauthScope: string; actingSubject: string;
    idempotencyKey: string; digest: string }) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [input.oauthScope]);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: input.scope, action: input.action, idempotencyKey: input.idempotencyKey,
    requestDigest: input.digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, input.digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    const terminal = await cancel(env, admission);
    await access.recordGraphOutcome(admission.id, terminal);
    checkedTerminal(terminal, registered);
  }
  return { registered, admission };
}

async function profileHead(env: WorkActivationEnvironment, realm: string): Promise<string | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ;
      rv:space ?space . ?space a rv:Space ; rv:realmCapability ${iri(realm)} ;
      rv:disclosure rv:Public . OPTIONAL { ${iri(realm)} rv:publicProfileHead ?head } }
  } LIMIT 2`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
  if (rows.length !== 1) throw new RealmProfileMissing('Realm is unavailable');
  return rows[0]!.head?.value ?? null;
}

async function imageSelection(media: MediaStore | undefined, selection: string | null,
  realm: string, context: string): Promise<void> {
  if (!selection) return;
  if (!media) throw new RealmProfileUnavailable('Media owner is unavailable');
  const basis = await media.avatarDelivery(selection);
  if (!basis || basis.target !== realm || basis.context !== context || !avatarImageEligible(basis)) {
    throw new RealmProfileInvalid('Realm image selection is unavailable');
  }
}

async function chosenModerators(env: WorkActivationEnvironment, realm: string,
  agents: readonly string[]): Promise<Set<string>> {
  if (!agents.length) return new Set();
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?agent WHERE {
    VALUES ?agent { ${agents.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?agent a rv:Agent .
      ?slot a rv:RealmModeratorPublicChoice ; rv:realm ${iri(realm)} ;
        rv:agent ?agent ; rv:choiceHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RealmModeratorChoiceRevision ;
      rv:component ?slot ; rv:publicChoice rv:Accepted . }
  } LIMIT ${agents.length + 1}`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
  if (rows.length > agents.length || rows.some(row => !row.agent)) {
    throw new RealmProfileUnavailable('Moderator choice relation is ambiguous');
  }
  return new Set(rows.map(row => row.agent!.value));
}

/** One profile CAS: O(R + M + payload bytes), R ≤ 12 and M ≤ 16; at most 20
 * graph calls including rejection reconciliation, two Media point reads and R
 * scoped governance head probes. No member or grant roster scan occurs. */
export async function publishRealmProfile(env: WorkActivationEnvironment, media: MediaStore | undefined,
  account: Account, access: Access, request: Request, input: ProfilePublicationInput,
  governance?: Pick<GovernanceRules, 'current'>) {
  if (!nativeId.test(input.realm) || !nativeId.test(input.actingSubject)
    || (input.expectedHead !== null && !nativeId.test(input.expectedHead))) {
    throw new RealmProfileInvalid('Realm profile identity is invalid');
  }
  const profile = checkedProfile(input.profile);
  const digest = hash(JSON.stringify({ family: FAMILY, action: 'publish', realm: input.realm,
    expectedHead: input.expectedHead, actingSubject: input.actingSubject, profile }));
  const scope = `realm:profile:${input.realm}`;
  const { registered, admission } = await admit(env, account, access, request, {
    action: 'realm.profile.publish', scope, oauthScope: 'realm:profile',
    actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey, digest });
  if (admission.state !== 'sealed' && !await readTerminal(env, admission.id)) {
    let head: string | null;
    try { head = await profileHead(env, input.realm); }
    catch (error) {
      if (!(error instanceof RealmProfileMissing)) throw error;
      const terminal = await cancel(env, admission, 'InvalidProfile');
      await access.recordGraphOutcome(admission.id, terminal);
      throw error;
    }
    if (head !== input.expectedHead) {
      const stale = await cancel(env, admission, 'StaleHead');
      await access.recordGraphOutcome(admission.id, stale);
      if (stale.outcome === 'cancelled') throw new RealmProfileStale('Realm profile head changed', head);
    }
    try {
      await imageSelection(media, profile.iconSelection, input.realm, DEFAULT_MEDIA_CONTEXT);
      await imageSelection(media, profile.bannerSelection, input.realm, input.realm);
      for (const rule of profile.rules) {
        if (!rule.governanceRule) continue;
        if (!governance) throw new RealmProfileUnavailable('Governance rule owner is unavailable');
        let current: Awaited<ReturnType<GovernanceRules['current']>>;
        try { current = await governance.current(rule.governanceRule.ref,
          `governance:realm:${input.realm}`); }
        catch { throw new RealmProfileUnavailable('Governance rule owner is unavailable'); }
        if (current?.revision !== rule.governanceRule.revision) {
          throw new RealmProfileInvalid('Linked governance rule revision is unavailable');
        }
      }
      const chosen = await chosenModerators(env, input.realm, profile.moderators);
      if (chosen.size !== profile.moderators.length) {
        throw new RealmProfileInvalid('Public moderator choice is missing');
      }
    } catch (error) {
      if (!(error instanceof RealmProfileInvalid || error instanceof RealmProfileUnavailable)) throw error;
      const invalid = await cancel(env, admission, 'InvalidProfile');
      await access.recordGraphOutcome(admission.id, invalid);
      checkedTerminal(invalid, registered);
      throw error;
    }
    const revision = `${ID}${Bun.randomUUIDv7()}`;
    const operation = `${ID}${Bun.randomUUIDv7()}`;
    const receipt = receiptIri(admission.id);
    const payload = JSON.stringify(profile);
    const expected = input.expectedHead;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${expected ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:publicProfileHead ${iri(expected)} }` : ''} }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:publicProfileHead ${iri(revision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RealmPublicProfileRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.realm)} ; rv:operation ${iri(operation)} ;
          ${expected ? `rv:predecessor ${iri(expected)} ;` : ''}
          rv:profilePayload ${lit(payload)} ; rv:modelRevision ${iri(REALM_PROFILE)} ;
          rv:shapeRevision ${iri(REALM_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, admission, receipt, 'Succeeded',
          `rv:realm ${iri(input.realm)} ; rv:profileRevision ${iri(revision)} ;
            rv:operation ${iri(operation)}`)} }
        GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt, operation, admission.action,
          input.realm)} } }
      WHERE { ${guard(env)}
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} a rv:Realm ; rv:realmState rv:Active ;
          rv:space ?space . ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ;
          rv:disclosure rv:Public .
          ${expected ? `${iri(input.realm)} rv:publicProfileHead ${iri(expected)} .` : ''} }
        ${expected ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.realm)} rv:publicProfileHead ?prior } }`}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        ${profile.moderators.map((agent, index) => `GRAPH ${iri(GRAPHS.current)} {
          ${iri(agent)} a rv:Agent . ${iri(moderatorSlot(input.realm, agent))} rv:choiceHead ?choice${index} . }
          GRAPH ${iri(GRAPHS.revisions)} { ?choice${index} rv:publicChoice rv:Accepted . }`).join('\n')}
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'realm-public-profile-v1', [{
      shape: `${REALM_PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] }]);
    try { await validatedCommand(env, { receipt, digest, update, validations,
      deadlineMs: 10_000 }, admission); } catch { /* receipt decides */ }
    if (!await readTerminal(env, admission.id) && await profileHead(env, input.realm) !== expected) {
      await cancel(env, admission, 'StaleHead');
    }
  }
  const terminal = await readTerminal(env, registered.id);
  if (!terminal) throw new PendingActivation('Realm profile outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  const complete = checkedTerminal(terminal, registered);
  if (complete.realm !== input.realm) throw new IdempotencyConflict('Realm profile receipt targets another Realm');
  return { realm: input.realm, revision: complete.revision!, receipt: complete.receipt,
    replayed: registered.replayed, sourcePosition: { dataEpoch: complete.dataEpoch,
      sequence: complete.sequence } };
}

/** A public role choice is made by that Agent, and no private grant is exposed. */
export async function choosePublicModerator(env: WorkActivationEnvironment, account: Account,
  access: Access, request: Request, input: ModeratorChoiceInput) {
  if (!nativeId.test(input.realm) || !nativeId.test(input.agent)
    || input.agent !== input.actingSubject
    || (input.expectedHead !== null && !nativeId.test(input.expectedHead))) {
    throw new RealmProfileInvalid('Public moderator choice identity is invalid');
  }
  const digest = hash(JSON.stringify({ family: FAMILY, action: 'choose', realm: input.realm,
    agent: input.agent, expectedHead: input.expectedHead, public: input.public }));
  const slot = moderatorSlot(input.realm, input.agent);
  const { registered, admission } = await admit(env, account, access, request, {
    action: 'realm.moderator.choose',
    scope: `realm:moderator-choice:${input.realm.slice(-36)}:${input.agent.slice(-36)}`,
    oauthScope: 'realm:public-role', actingSubject: input.agent,
    idempotencyKey: input.idempotencyKey, digest });
  if (admission.state !== 'sealed' && !await readTerminal(env, admission.id)) {
    try { await profileHead(env, input.realm); }
    catch (error) {
      if (!(error instanceof RealmProfileMissing)) throw error;
      const terminal = await cancel(env, admission, 'InvalidProfile');
      await access.recordGraphOutcome(admission.id, terminal);
      throw error;
    }
    const agent = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} a rv:Agent } }`, MAX_GRAPH_READ_BYTES);
    if (agent.boolean !== true) {
      const terminal = await cancel(env, admission, 'InvalidProfile');
      await access.recordGraphOutcome(admission.id, terminal);
      throw new RealmProfileMissing('Agent is unavailable');
    }
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { OPTIONAL { ${iri(slot)} rv:choiceHead ?head } }
    } LIMIT 2`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
    const head = rows[0]?.head?.value ?? null;
    if (head !== input.expectedHead) {
      const stale = await cancel(env, admission, 'StaleHead');
      await access.recordGraphOutcome(admission.id, stale);
      if (stale.outcome === 'cancelled') throw new RealmProfileStale('Moderator choice head changed', head);
    }
    const revision = `${ID}${Bun.randomUUIDv7()}`;
    const operation = `${ID}${Bun.randomUUIDv7()}`;
    const receipt = receiptIri(admission.id);
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${head ? `GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:choiceHead ${iri(head)} }` : ''} }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:RealmModeratorPublicChoice ;
          rv:realm ${iri(input.realm)} ; rv:agent ${iri(input.agent)} ;
          rv:choiceHead ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RealmModeratorChoiceRevision, rv:RevisionAnchor ;
          rv:component ${iri(slot)} ; rv:operation ${iri(operation)} ;
          ${head ? `rv:predecessor ${iri(head)} ;` : ''}
          rv:publicChoice rv:${input.public ? 'Accepted' : 'Declined'} ;
          rv:modelRevision ${iri(REALM_PROFILE)} ; rv:shapeRevision ${iri(REALM_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, admission, receipt, 'Succeeded',
          `rv:realm ${iri(input.realm)} ; rv:profileRevision ${iri(revision)} ;
            rv:operation ${iri(operation)}`)} }
        GRAPH ${iri(GRAPHS.outbox)} { ${outboxTriples(env, receipt, operation, admission.action,
          input.realm)} } }
      WHERE { ${guard(env)}
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} a rv:Realm ; rv:realmState rv:Active ;
          rv:space ?space . ?space a rv:Space ; rv:disclosure rv:Public ;
          rv:realmCapability ${iri(input.realm)} . ${iri(input.agent)} a rv:Agent .
          ${head ? `${iri(slot)} rv:choiceHead ${iri(head)} .` : ''} }
        ${head ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(slot)} rv:choiceHead ?prior } }`}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'realm-public-profile-v1', [
      { shape: `${REALM_PROFILE}/moderator-slot-shape`, focus: [slot],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${REALM_PROFILE}/moderator-choice-shape`, focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    try { await validatedCommand(env, { receipt, digest, update,
      validations, deadlineMs: 10_000 }, admission); }
    catch { /* receipt resolves a lost graph response */ }
    if (!await readTerminal(env, admission.id)) {
      const current = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:choiceHead ?head }
      } LIMIT 2`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
      if ((current[0]?.head?.value ?? null) !== head) await cancel(env, admission, 'StaleHead');
      else throw new PendingActivation('Moderator choice outcome is unknown');
    }
  }
  const terminal = await readTerminal(env, registered.id);
  if (!terminal) throw new PendingActivation('Moderator choice outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  const complete = checkedTerminal(terminal, registered);
  return { realm: input.realm, agent: input.agent, revision: complete.revision!,
    receipt: complete.receipt, replayed: registered.replayed,
    sourcePosition: { dataEpoch: complete.dataEpoch, sequence: complete.sequence } };
}

export async function readCurrentProfile(env: WorkActivationEnvironment, realm: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?payload WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm .
      OPTIONAL { ${iri(realm)} rv:publicProfileHead ?revision } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RealmPublicProfileRevision ;
      rv:component ${iri(realm)} ; rv:profilePayload ?payload . } }
  } LIMIT 2`, MAX_GRAPH_READ_BYTES)).results?.bindings ?? [];
  if (rows.length !== 1) throw new RealmProfileUnavailable('Realm public profile is ambiguous');
  if (!rows[0]?.revision) return null;
  if (!rows[0].payload) {
    throw new RealmProfileUnavailable('Realm public profile is ambiguous');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rows[0].payload.value); } catch { /* rejected below */ }
  if (!Value.Check(publicProfile, parsed)) throw new RealmProfileUnavailable('Realm public profile is invalid');
  try { checkedProfile(parsed); } catch { throw new RealmProfileUnavailable('Realm public profile is invalid'); }
  return { revision: rows[0].revision.value, profile: parsed };
}

export { chosenModerators };
