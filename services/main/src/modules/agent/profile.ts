import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { CommandOutcomeUnknown, type CommandResult } from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { avatarImageEligible, DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../media/store.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment }
  from '../work/activate.ts';
import { validLocalizedText, type LocalizedText } from '../display-language/select.ts';
import { agentLocalizedName } from './localized-name.ts';

export class AgentProfileInvalid extends Error {}
export class AgentProfileDenied extends Error {}
export class AgentProfileStale extends Error {
  constructor(readonly currentHead: string) { super('Agent profile changed'); }
}
export class AgentProfileConflict extends Error {}
export class AgentProfileValidationFailed extends Error {}
export class AgentProfileUnavailable extends Error {}

const violationIri = (text: string, pattern: RegExp): string | null => {
  pattern.lastIndex = 0;
  return pattern.exec(text)?.[1] ?? null;
};

/** Path and constraint only. Report values and focus labels stay out of the problem and the log. */
export function agentProfileViolation(report: unknown): { path: string | null; constraint: string | null } {
  if (typeof report !== 'string' || !report) return { path: null, constraint: null };
  const path = violationIri(report, /sh:resultPath\s+<([^>\s]+)>/g)
    ?? violationIri(report, /<http:\/\/www\.w3\.org\/ns\/shacl#resultPath>\s+<([^>\s]+)>/g);
  const component = violationIri(report, /sh:sourceConstraintComponent\s+<([^>\s]+)>/g)
    ?? violationIri(report, /<http:\/\/www\.w3\.org\/ns\/shacl#sourceConstraintComponent>\s+<([^>\s]+)>/g);
  const line = report.split('\n').map(item => item.trim()).find(item => item
    && !item.startsWith('sh:resultPath') && !item.startsWith('sh:sourceConstraintComponent')
    && !item.startsWith('<') && !item.includes('"'));
  const policy = line && line.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9 :._/-]*$/.test(line)
    ? (line.split(/:\s+(?:https?:|urn:)/)[0] ?? line).trim() : null;
  return { path, constraint: component ?? (policy || null) };
}

function validationDetail(report: unknown): string {
  const violation = agentProfileViolation(report);
  console.error(JSON.stringify({ event: 'agent-profile-validation-failed',
    path: violation.path, constraint: violation.constraint }));
  const parts = [violation.path, violation.constraint].filter((part): part is string => !!part);
  return parts.length ? `Agent profile failed model validation: ${parts.join(' ')}`
    : 'Agent profile failed model validation';
}

export interface AgentBio { text: string; language: string }
export interface AgentProfileInput {
  agent: string; expectedHead: string; displayName: string;
  avatarSelection: string | null; bio: AgentBio | null; idempotencyKey: string;
  localizedName?: LocalizedText;
}
export interface AgentProfileResult {
  profile: 'agent-public-profile-v1' | 'agent-public-profile-v2'; agent: string; revision: string; receipt: string;
  replayed: boolean; sourcePosition: { dataEpoch: string; sequence: string };
}

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-agent-revision)?$/;
const key = /^[A-Za-z0-9:_./-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const controls = /\p{Cc}/u;
const nameControls = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
export const AGENT_PROFILE_COST = { graphQueries: 8, graphCommands: 1, mediaPointReads: 1,
  accessQueries: 4, nameCharacters: 200, bioCharacters: 500 } as const;

export function checkedAgentProfile(input: AgentProfileInput): AgentProfileInput {
  const displayName = input.displayName.trim();
  const bio = input.bio && { text: input.bio.text.trim(), language: input.bio.language };
  if (!native.test(input.agent) || !headId.test(input.expectedHead) || !key.test(input.idempotencyKey)
    || !displayName || displayName.length > AGENT_PROFILE_COST.nameCharacters
    || nameControls.test(displayName) || (input.avatarSelection !== null && !uuid.test(input.avatarSelection))
    || (input.localizedName && (!validLocalizedText(input.localizedName, AGENT_PROFILE_COST.nameCharacters)
      || input.localizedName.labels[input.localizedName.original] !== displayName
      || Object.values(input.localizedName.labels).some(label => nameControls.test(label))))
    || (bio && (!bio.text || bio.text.length > AGENT_PROFILE_COST.bioCharacters
      || controls.test(bio.text) || bio.language.length > 35
      || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(bio.language)))) {
    throw new AgentProfileInvalid('Agent profile is invalid');
  }
  return { ...input, displayName, bio };
}

interface Terminal { digest: string; agent: string; revision: string; epoch: string; sequence: string }
const receiptFor = (principalId: string, idempotencyKey: string) =>
  `urn:rezics:receipt:agent-profile:${hash(`${principalId}\0${idempotencyKey}`)}`;

async function terminal(env: WorkActivationEnvironment, receipt: string): Promise<Terminal | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?agent ?revision ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ?digest ; rv:agent ?agent ; rv:profileRevision ?revision ;
      rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.digest || !row.agent || !row.revision || !row.epoch
    || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new AgentProfileUnavailable('Agent profile receipt is incomplete');
  }
  return { digest: row.digest.value, agent: row.agent.value, revision: row.revision.value,
    epoch: row.epoch.value, sequence: row.sequence!.value };
}

async function currentHead(env: WorkActivationEnvironment, agent: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?base ?profile ?name ?localizedName ?originalNameLanguage WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(agent)} a rv:Agent ; rv:head ?base ; rdfs:label ?name .
      OPTIONAL { ${iri(agent)} rv:publicProfileHead ?profile }
      OPTIONAL { ${iri(agent)} rv:localizedName ?localizedName }
      OPTIONAL { ${iri(agent)} rv:originalNameLanguage ?originalNameLanguage }
      FILTER NOT EXISTS { ${iri(agent)} a rv:AgentTombstone }
      FILTER NOT EXISTS { ${iri(agent)} rv:profileDisclosure rv:Private }
      FILTER NOT EXISTS { ${iri(agent)} rv:protectionHead ?protection } }
    GRAPH ${iri(GRAPHS.revisions)} { ?base a rv:RevisionAnchor ; rv:component ${iri(agent)} ;
      rv:modelRevision <https://rezics.com/definition/agent-provision-v1> .
      FILTER NOT EXISTS { ?base a rv:ErasedRevision } }
  } LIMIT 21`, 32_768)).results?.bindings ?? [];
  if (!rows.length || rows.length > 20 || !rows[0]?.base || !rows[0].name) {
    throw new AgentProfileDenied('Agent is unavailable');
  }
  const first = rows[0]!;
  if (rows.some(row => row.base?.value !== first.base?.value || row.profile?.value !== first.profile?.value
    || row.name?.value !== first.name?.value)) throw new AgentProfileUnavailable('Agent profile is ambiguous');
  let localizedName: LocalizedText | null;
  try { localizedName = agentLocalizedName(rows, first.name!.value); }
  catch { throw new AgentProfileUnavailable('Organization names are invalid'); }
  return { head: first.profile?.value ?? first.base!.value,
    name: first.name!.value, localizedName };
}

/** One indexed Access controller check and one bounded graph CAS; no Agent roster scan.
 * Access locks remain held until the graph command finishes, fencing concurrent revocation. */
export class AgentPublicProfiles {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment,
    private readonly media: Pick<MediaStore, 'avatarDelivery'>) {}

  async change(principal: VerifiedPrincipal, raw: AgentProfileInput): Promise<AgentProfileResult> {
    const input = checkedAgentProfile(raw);
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (!fence?.open) throw new AgentProfileUnavailable('Access recovery hold');
      const actor = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!actor) throw new AgentProfileDenied('Agent controller is unavailable');
      const receipt = receiptFor(actor.id, input.idempotencyKey);
      const digest = hash(JSON.stringify({ family: input.localizedName ? 'agent-public-profile-v2'
        : 'agent-public-profile-v1', agent: input.agent,
        expectedHead: input.expectedHead, displayName: input.displayName,
        avatarSelection: input.avatarSelection, bio: input.bio,
        ...(input.localizedName ? { localizedName: input.localizedName } : {}) }));
      const prior = await terminal(this.env, receipt);
      if (prior) {
        if (prior.digest !== digest || prior.agent !== input.agent) {
          throw new AgentProfileConflict('Idempotency key binds another profile change');
        }
        await client.query('COMMIT');
        return { profile: input.localizedName ? 'agent-public-profile-v2' : 'agent-public-profile-v1', agent: input.agent,
          revision: prior.revision, receipt, replayed: true,
          sourcePosition: { dataEpoch: prior.epoch, sequence: prior.sequence } };
      }
      const control = await client.query(`SELECT 1 FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
        WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = 'agent.control'
          AND r.active AND r.valid_until > clock_timestamp()
        LIMIT 1 FOR SHARE OF r, s`, [actor.id, input.agent]);
      if (control.rowCount !== 1) throw new AgentProfileDenied('Agent controller is unavailable');
      const current = await currentHead(this.env, input.agent);
      if (current.head !== input.expectedHead) throw new AgentProfileStale(current.head);
      let localizedName = input.localizedName;
      if (!localizedName && current.localizedName) {
        localizedName = { ...current.localizedName,
          labels: { ...current.localizedName.labels,
            [current.localizedName.original]: input.displayName } };
      }
      if (input.localizedName) {
        const kind = await this.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:agentKind rv:OrganizationAgent } }`, 8192);
        if (kind.boolean !== true) throw new AgentProfileInvalid('Only organizations have translated names');
      }
      if (input.avatarSelection) {
        const image = await this.media.avatarDelivery(input.avatarSelection);
        if (!image || image.target !== input.agent || image.context !== DEFAULT_MEDIA_CONTEXT
          || !avatarImageEligible(image)) throw new AgentProfileInvalid('Avatar selection is unavailable');
      }
      const revision = `${ID}${randomUUID()}`;
      const operation = `urn:rezics:operation:agent-profile:${hash(receipt)}`;
      const event = `urn:rezics:event:${hash(receipt)}`;
      const batch = `urn:rezics:outbox:${hash(receipt)}`;
      const model = localizedName ? 'agent-profile-v2' : 'agent-profile-v1';
      const modelIri = `https://rezics.com/definition/${model}`;
      const nameLiterals = localizedName && Object.entries(localizedName.labels)
        .map(([language, value]) => `${lit(value)}@${language}`).join(', ');
      const localizedTriples = localizedName
        ? ` ; rv:profileNameFormat rv:LocalizedNameV2 ;
            rv:originalNameLanguage ${lit(localizedName.original)} ;
            rv:localizedName ${nameLiterals}` : '';
      const initial = input.expectedHead === (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?base WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:head ?base }
      } LIMIT 2`, 8192)).results?.bindings?.[0]?.base?.value;
      const expected = initial ? '' : `${iri(input.agent)} rv:publicProfileHead ${iri(input.expectedHead)} .`;
      const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rdfs:label ?oldName .
            ${expected} ${iri(input.agent)} rv:profileBio ?oldBio .
            ${iri(input.agent)} rv:profileAvatarSelection ?oldAvatar .
            ${iri(input.agent)} rv:localizedName ?oldLocalizedName .
            ${iri(input.agent)} rv:originalNameLanguage ?oldOriginalNameLanguage .
            ${iri(input.agent)} rv:profileNameFormat ?oldNameFormat . } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rdfs:label ${lit(input.displayName)} ;
            rv:publicProfileHead ${iri(revision)}
            ${input.bio ? `; rv:profileBio ${lit(input.bio.text)}@${input.bio.language}` : ''}
            ${localizedTriples}
            ${input.avatarSelection ? `; rv:profileAvatarSelection ${lit(input.avatarSelection)}` : ''} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:AgentPublicProfileRevision, rv:RevisionAnchor ;
            rv:component ${iri(input.agent)} ; rv:operation ${iri(operation)} ;
            rv:predecessor ${iri(input.expectedHead)} ;
            ${localizedName ? `rv:originalNameLanguage ${lit(localizedName.original)} ;
              rv:localizedName ${nameLiterals} ;` : ''}
            rv:modelRevision ${iri(modelIri)} ;
            rv:shapeRevision ${iri(modelIri)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
            rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
            rv:outcome rv:Succeeded ; rv:agent ${iri(input.agent)} ; rv:profileRevision ${iri(revision)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
            rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ; rv:sequence ?next ;
            rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:AgentPublicProfileChangedEvent ; rv:ordinal 0 ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ;
            rv:agent ${iri(input.agent)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} ; rv:sequence ?n . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} a rv:Agent ; rv:head ?base ;
            rdfs:label ?oldName . OPTIONAL { ${iri(input.agent)} rv:profileBio ?oldBio }
            OPTIONAL { ${iri(input.agent)} rv:profileAvatarSelection ?oldAvatar }
            OPTIONAL { ${iri(input.agent)} rv:localizedName ?oldLocalizedName }
            OPTIONAL { ${iri(input.agent)} rv:originalNameLanguage ?oldOriginalNameLanguage }
            OPTIONAL { ${iri(input.agent)} rv:profileNameFormat ?oldNameFormat }
            ${expected} }
          ${initial ? `FILTER(?base = ${iri(input.expectedHead)}) FILTER NOT EXISTS {
            GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:publicProfileHead ?prior } }` : ''}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} a rv:AgentTombstone } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:profileDisclosure rv:Private } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:protectionHead ?protection } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      const validations = await profileValidations(this.env.fuseki, model, [{
        shape: `${modelIri}/profile-shape`, focus: [input.agent], graphs: [GRAPHS.current] },
        ...(localizedName ? [{ shape: `${modelIri}/revision-shape`,
          focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] }] : [])]);
      let command: CommandResult | undefined;
      try { command = await this.env.fuseki.commandWithReceipt({ receipt, digest, update,
        validations, deadlineMs: 10_000 }); }
      catch (error) { if (!(error instanceof CommandOutcomeUnknown)) throw error; }
      const saved = await terminal(this.env, receipt);
      if (!saved) {
        if (command?.status === 'invalid') {
          throw new AgentProfileValidationFailed(validationDetail(command.report));
        }
        if (command?.status === 'unknown-profile') {
          throw new AgentProfileUnavailable('Agent profile shape is unavailable');
        }
        const now = await currentHead(this.env, input.agent);
        if (now.head !== input.expectedHead) throw new AgentProfileStale(now.head);
        if (command?.status === 'guard-unmatched' || command?.status === 'conflict') {
          throw new AgentProfileConflict('Agent profile graph basis changed');
        }
        throw new AgentProfileUnavailable('Agent profile outcome is unknown');
      }
      if (saved.digest !== digest || saved.agent !== input.agent) {
        throw new AgentProfileConflict('Idempotency key binds another profile change');
      }
      await client.query('COMMIT');
      return { profile: input.localizedName ? 'agent-public-profile-v2' : 'agent-public-profile-v1', agent: input.agent,
        revision: saved.revision, receipt, replayed: false,
        sourcePosition: { dataEpoch: saved.epoch, sequence: saved.sequence } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new AgentProfileUnavailable('Agent profile owner timed out');
      }
      throw error;
    } finally { client.release(); }
  }
}
