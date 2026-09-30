import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { ACTIVE_ACCESS_BOUNDS_SQL,
  accessBoundsFromRow, type ProfileRow } from '../../operations/bounds.ts';
import type { VerifiedPrincipal } from './admission.ts';
import { directWorkCreateProof } from './direct-principal.ts';
import { groupWorkCreateProof, groupWorkCreateSubjects, GroupUnavailable } from './groups.ts';
import { RoleUnavailable } from './roles.ts';
import { roleWorkCreateProof, roleWorkCreateSubjects } from './role-proof.ts';
import { baselineMemberProof, newBaselineProof } from './baseline.ts';
import { ensureBaselineScopeGate } from './scope-gates.ts';
import { AccessTopology } from './topology.ts';
import { ControlUnavailable } from './topology-control.ts';
import { agentLocalizedName } from '../agent/localized-name.ts';
import { selectDisplayName, type DisplayName } from '../display-language/select.ts';

export class ActingContextDenied extends Error {}
export class ActingContextInvalid extends Error {}
export class ActingContextStale extends Error {}
export class ActingContextUnavailable extends Error {}

export const WORK_CREATE_CONTEXT = {
  task: 'work.create', scope: 'work:create:root', action: 'work.create',
} as const;

/** The selected proof branch is part of a command's authority context. */
export type ActingAuthorityPath = 'represented-agent' | 'direct-principal';

export interface ActingContextDiscovery {
  profile: 'work-create-acting-contexts-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  scope: typeof WORK_CREATE_CONTEXT.scope;
  authorityEpoch: string;
  contexts: ActingContextOption[];
  directContexts: ActingContextOption[];
  preferredActingSubject: string | null;
  savedPreference: { actingSubject: string; eligible: boolean } | null;
  preferenceRevision: string | null;
  complete: true;
}

export interface ActingContextOption {
  actingSubject: string;
  displayName: string | null;
  handle: string | null;
  kind: 'person' | 'pen-name' | 'organization' | 'service' | null;
}

export interface AgentDiscoveryOption extends Omit<ActingContextOption, 'displayName'> {
  displayName: Pick<DisplayName, 'value' | 'language' | 'direction'> | null;
}

export interface AgentDiscovery {
  profile: 'agent-discovery-v1';
  items: AgentDiscoveryOption[];
  complete: true;
}

export interface ActingContextPreference {
  profile: 'work-create-acting-context-preference-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  actingSubject: string | null;
  revision: string;
  replayed: boolean;
}

export interface SetActingContextPreference {
  actingSubject: string | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}

export interface ActingContextCheck {
  profile: 'work-create-acting-context-check-v1';
  task: typeof WORK_CREATE_CONTEXT.task;
  scope: typeof WORK_CREATE_CONTEXT.scope;
  actingSubject: string;
  authorityPath: ActingAuthorityPath;
  authorityEpoch: string;
  decision: 'eligible-now';
  reusable: false;
}

export interface ContentDraftContextCheck {
  profile: 'content-draft-acting-context-check-v1';
  task: 'content.draft';
  scope: string;
  resource: string;
  actingSubject: string;
  authorityEpoch: string;
  decision: 'eligible-now';
  reusable: false;
}

const agentId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
const revisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>,
  isolation: 'REPEATABLE READ' | 'READ COMMITTED' = 'REPEATABLE READ'): Promise<T> {
  const client = await pool.connect();
  try {
    // Discovery/check use one stable snapshot; preference writes serialize on
    // the principal row and lock their authority dependencies before mutation.
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    if (error instanceof GroupUnavailable || error instanceof RoleUnavailable
      || error instanceof ControlUnavailable) {
      throw new ActingContextUnavailable(error.message);
    }
    if (error && typeof error === 'object' && 'code' in error
      && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
      throw new ActingContextUnavailable('authority snapshot changed or timed out');
    }
    throw error;
  } finally { client.release(); }
}

export async function currentGate(client: PoolClient): Promise<{
  authority_epoch: string; open: boolean; dispatch_open: boolean;
}> {
  await identityReadFence(client);
  const gate = await client.query<{
    authority_epoch: string; open: boolean; dispatch_open: boolean;
  }>(
    'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
    [WORK_CREATE_CONTEXT.scope]);
  if (gate.rowCount !== 1) throw new ActingContextUnavailable('Work creation scope is unavailable');
  return gate.rows[0]!;
}

export async function identityReadFence(client: PoolClient): Promise<void> {
  const recovery = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (recovery.rows[0]?.open !== true) {
    throw new ActingContextUnavailable('Access is held for recovery');
  }
}

/** The one task-independent predicate used by discovery and saved identity
 * choices. Two bounded candidate reads plus the topology owner's bounded path
 * evaluation. Distinct Agents share one output bound across all sources. */
export async function actableSubjects(client: PoolClient, principalId: string): Promise<string[]> {
  const row = (await client.query<ProfileRow>(ACTIVE_ACCESS_BOUNDS_SQL)).rows[0];
  if (!row) throw new ActingContextUnavailable('operational bounds profile is not activated');
  const bounds = accessBoundsFromRow(row);
  const represented = await AccessTopology.representedAgents(client, principalId);
  // Provision is a terminal creation receipt, never current authority. Its
  // Agent appears only while a live mandate (or attribution) still covers it.
  const other = await client.query<{ subject: string }>(`SELECT DISTINCT a.agent_subject AS subject
    FROM access.principal_agent_attribution a JOIN access.authority_subject s ON s.id = a.agent_subject
    WHERE a.principal_id = $1 AND a.active AND a.valid_until > clock_timestamp()
      AND s.kind = 'agent' AND s.active ORDER BY a.agent_subject LIMIT $2`,
  [principalId, bounds.actingContexts + 1]);
  const subjects = [...new Set([...represented, ...other.rows.map(value => value.subject)])].sort();
  if (subjects.length > bounds.actingContexts) {
    throw new ActingContextUnavailable('Agent discovery exceeds supported limit');
  }
  // Share locks prevent a revoked attribution or inactive Agent
  // from racing a saved choice's commit. Recheck after acquiring the locks.
  const attributions = await client.query<{ agent_subject: string }>(`SELECT agent_subject
    FROM access.principal_agent_attribution WHERE principal_id = $1 AND active
      AND valid_until > clock_timestamp() AND agent_subject = ANY($2::text[]) FOR SHARE`,
  [principalId, subjects]);
  const live = new Set([...represented, ...attributions.rows.map(value => value.agent_subject)]);
  const agents = await client.query<{ id: string }>(`SELECT id FROM access.authority_subject
    WHERE id = ANY($1::text[]) AND kind = 'agent' AND active ORDER BY id FOR SHARE`, [[...live]]);
  return agents.rows.map(value => value.id);
}

async function activePrincipal(client: PoolClient, principal: VerifiedPrincipal): Promise<string | null> {
  const result = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [principal.issuer, principal.subject]);
  return result.rows[0]?.id ?? null;
}

export async function eligibleSubject(client: PoolClient, principalId: string,
  actingSubject: string, emailVerified = false): Promise<boolean> {
  if (emailVerified
    && !(await client.query('SELECT id FROM access.policy WHERE scope_id = $1', [WORK_CREATE_CONTEXT.scope])).rowCount
    && await baselineMemberProof(client, principalId, actingSubject)) return true;
  const subject = await client.query(`SELECT id FROM access.authority_subject
    WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [actingSubject]);
  const represented = await client.query(`SELECT id FROM access.representation
    WHERE principal_id = $1 AND subject_id = $2 AND action = $3
      AND active AND valid_until > clock_timestamp()
    ORDER BY id LIMIT 1 FOR SHARE`,
  [principalId, actingSubject, WORK_CREATE_CONTEXT.action]);
  const granted = await client.query(`SELECT id FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
      AND active AND valid_until > clock_timestamp()
    ORDER BY id LIMIT 1 FOR SHARE`,
  [actingSubject, WORK_CREATE_CONTEXT.scope, WORK_CREATE_CONTEXT.action]);
  if (subject.rowCount !== 1 || represented.rowCount !== 1) return false;
  return granted.rowCount === 1
    || await groupWorkCreateProof(client, actingSubject) !== null
    || await roleWorkCreateProof(client, actingSubject) !== null;
}

/** A private read model for the first supported task. Discovery is a bounded
 * convenience view; a selected Agent is checked again with its complete path
 * and every later command must still run ordinary Access admission. */
export class AccessActingContexts {
  constructor(private readonly pool: Pool, private readonly environment?: WorkActivationEnvironment) {}

  async discoverAgents(principal: VerifiedPrincipal, languages: readonly string[] = []): Promise<AgentDiscovery> {
    const subjects = await transaction(this.pool, async client => {
      await identityReadFence(client);
      const principalId = await activePrincipal(client, principal);
      return principalId ? actableSubjects(client, principalId) : [];
    });
    const labels = await this.agentLabels(subjects, languages);
    return { profile: 'agent-discovery-v1', complete: true,
      items: subjects.map(actingSubject => ({ actingSubject, kind: null, handle: null,
        displayName: null, ...labels.get(actingSubject) })) };
  }

  /** One graph batch of at most 20 localized labels per Agent (50 Agents),
   * one current-handle batch, 1 MiB graph budget; malformed or excess labels
   * fail closed. Missing descriptions remain nullable for older Agents. */
  private async agentLabels(subjects: readonly string[], languages: readonly string[]):
    Promise<Map<string, Omit<AgentDiscoveryOption, 'actingSubject'>>> {
    const labels = new Map<string, Omit<AgentDiscoveryOption, 'actingSubject'>>();
    if (!subjects.length || !this.environment) return labels;
    try {
      await assertGraphAdmissionOpen(this.environment.fuseki, this.environment.lineage);
      const rows = (await this.environment.fuseki.query(`PREFIX rv: <${RV}>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?agent ?label ?kind ?nativeHandle ?legacyHandle ?localizedName ?originalNameLanguage WHERE {
          VALUES ?agent { ${subjects.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} {
            ?agent a rv:Agent ; rv:agentKind ?kind ; rdfs:label ?label .
            OPTIONAL { ?agent rv:profileHandle ?nativeHandle }
            OPTIONAL { ?agent rv:handle ?legacyHandle }
            OPTIONAL { ?agent rv:localizedName ?localizedName }
            OPTIONAL { ?agent rv:originalNameLanguage ?originalNameLanguage }
          }
        } LIMIT ${subjects.length * 20 + 1}`, 1_048_576)).results?.bindings ?? [];
      if (rows.length > subjects.length * 20 || rows.some(row => !subjects.includes(row.agent?.value ?? ''))) {
        throw new Error('Agent label batch overflow or unexpected subject');
      }
      const claims = await this.pool.query<{ agent_id: string; handle: string }>(`SELECT agent_id, handle
        FROM access.agent_handle WHERE agent_id = ANY($1::text[]) AND state = 'current'`, [subjects]);
      const handles = new Map(claims.rows.map(row => [row.agent_id, row.handle]));
      const kinds: Record<string, AgentDiscoveryOption['kind']> = {
        [`${RV}PersonAgent`]: 'person', [`${RV}PenNameAgent`]: 'pen-name',
        [`${RV}OrganizationAgent`]: 'organization', [`${RV}ServiceAgent`]: 'service',
      };
      for (const subject of subjects) {
        const matched = rows.filter(row => row.agent?.value === subject);
        const first = matched[0];
        if (!first) continue;
        const name = first.label?.value;
        const kind = kinds[first.kind?.value ?? ''];
        const handle = handles.get(subject) ?? first.nativeHandle?.value ?? first.legacyHandle?.value ?? null;
        if (matched.length > 20 || !name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)
          || !kind || matched.some(row => row.label?.value !== name || row.kind?.value !== first.kind?.value
            || row.nativeHandle?.value !== first.nativeHandle?.value || row.legacyHandle?.value !== first.legacyHandle?.value)
          || (handle !== null && (!handle || handle.length > 128 || /[\u0000-\u001f\u007f]/.test(handle)))) {
          throw new Error('Agent description is ambiguous');
        }
        const localized = agentLocalizedName(matched, name);
        const selected = selectDisplayName(localized ?? new Map([[first.label?.['xml:lang'] || 'und', name]]), languages);
        if (!selected) throw new Error('Agent label has no language');
        labels.set(subject, { kind, handle, displayName: { value: selected.value,
          language: selected.language, direction: selected.direction } });
      }
      return labels;
    } catch { throw new ActingContextUnavailable('Agent descriptions are unavailable'); }
  }

  /** One public graph read and one bounded current-handle batch for at most 50
   * eligible Agents. Missing public descriptions remain null. */
  private async publicLabels(subjects: readonly string[]): Promise<Map<string, Omit<ActingContextOption, 'actingSubject'>>> {
    const labels = new Map<string, Omit<ActingContextOption, 'actingSubject'>>();
    if (!subjects.length || !this.environment) return labels;
    if (subjects.length > 50 || subjects.some(subject => !agentId.test(subject))) {
      throw new ActingContextUnavailable('Agent label batch exceeds supported limit');
    }
    try {
      await assertGraphAdmissionOpen(this.environment.fuseki, this.environment.lineage);
      const rows = (await this.environment.fuseki.query(`PREFIX rv: <${RV}>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?agent ?label ?kind ?nativeHandle ?legacyHandle WHERE {
          VALUES ?agent { ${subjects.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} {
            ?agent a rv:Agent ; rv:agentKind ?kind ; rdfs:label ?label .
            OPTIONAL { ?agent rv:profileHandle ?nativeHandle }
            OPTIONAL { ?agent rv:handle ?legacyHandle }
          }
        } LIMIT ${subjects.length + 1}`, 65_536)).results?.bindings ?? [];
      if (rows.length > subjects.length) throw new Error('Agent descriptions are ambiguous');
      const allowed = new Set(subjects);
      const claims = await this.pool.query<{ agent_id: string; handle: string }>(`SELECT agent_id, handle
        FROM access.agent_handle WHERE agent_id = ANY($1::text[]) AND state = 'current'`, [subjects]);
      const currentHandles = new Map(claims.rows.map(row => [row.agent_id, row.handle]));
      const kinds: Record<string, ActingContextOption['kind']> = {
        [`${RV}PersonAgent`]: 'person', [`${RV}PenNameAgent`]: 'pen-name',
        [`${RV}OrganizationAgent`]: 'organization', [`${RV}ServiceAgent`]: 'service',
      };
      for (const row of rows) {
        const agent = row.agent?.value;
        const name = row.label?.value;
        const kind = row.kind?.value;
        const handle = currentHandles.get(agent ?? '')
          ?? row.nativeHandle?.value ?? row.legacyHandle?.value ?? null;
        if (!agent || !allowed.has(agent) || labels.has(agent) || !name
          || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)
          || !kind || !(kind in kinds)
          || (handle !== null && (handle.length < 1 || handle.length > 128
            || /[\u0000-\u001f\u007f]/.test(handle)))) {
          throw new Error('Agent description is invalid');
        }
        labels.set(agent, { displayName: name, handle, kind: kinds[kind]! });
      }
      return labels;
    } catch {
      throw new ActingContextUnavailable('public Agent descriptions are unavailable');
    }
  }

  async discover(principal: VerifiedPrincipal): Promise<ActingContextDiscovery> {
    const discovered = await transaction<ActingContextDiscovery>(this.pool, async client => {
      const gate = await currentGate(client);
      const principalId = await activePrincipal(client, principal);
      const preference = principalId ? (await client.query<{
        acting_subject: string | null; revision: string;
      }>(`SELECT acting_subject, revision FROM access.acting_context_preference
          WHERE principal_id = $1 AND task = $2`,
      [principalId, WORK_CREATE_CONTEXT.task])).rows[0] : undefined;
      if (!gate.open || !gate.dispatch_open || !principalId) return {
        profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts: [], directContexts: [], preferredActingSubject: null,
        savedPreference: preference?.acting_subject
          ? { actingSubject: preference.acting_subject, eligible: false } : null,
        preferenceRevision: preference?.revision ?? null, complete: true,
      };
      // Read the persisted profile and bounded candidates in one statement.
      // LEFT JOIN retains the profile when there are no represented Agents.
      const result = await client.query<ProfileRow & { acting_subject: string | null }>(`
        SELECT b.*, candidates.acting_subject FROM (${ACTIVE_ACCESS_BOUNDS_SQL}) b
        LEFT JOIN LATERAL (
          SELECT DISTINCT s.id AS acting_subject
          FROM access.representation r
          JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
          WHERE r.principal_id = $1 AND r.action = $2 AND r.active
            AND r.valid_until > clock_timestamp()
          ORDER BY s.id LIMIT b.acting_contexts + 1
        ) candidates ON true ORDER BY candidates.acting_subject NULLS LAST`,
      [principalId, WORK_CREATE_CONTEXT.action]);
      if (!result.rows[0]) {
        throw new ActingContextUnavailable('operational bounds profile is not activated');
      }
      const bounds = accessBoundsFromRow(result.rows[0]);
      const candidateSubjects = result.rows.flatMap(row => row.acting_subject ? [row.acting_subject] : []);
      if (candidateSubjects.length > bounds.actingContexts) {
        throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
      }
      const granted = await client.query<{ recipient_subject: string }>(`
        SELECT DISTINCT recipient_subject FROM access.permission_grant
        WHERE recipient_subject = ANY($1::text[]) AND scope_id = $2 AND action = $3
          AND active AND valid_until > clock_timestamp()`,
      [candidateSubjects, WORK_CREATE_CONTEXT.scope, WORK_CREATE_CONTEXT.action]);
      const directGranted = new Set(granted.rows.map(row => row.recipient_subject));
      const groupGranted = await groupWorkCreateSubjects(client,
        candidateSubjects.filter(subject => !directGranted.has(subject)), bounds);
      const roleGranted = await roleWorkCreateSubjects(client,
        candidateSubjects.filter(subject => !directGranted.has(subject)
          && !groupGranted.has(subject)));
      let representedSubjects = candidateSubjects
        .filter(subject => directGranted.has(subject) || groupGranted.has(subject)
          || roleGranted.has(subject));
      if (principal.emailVerified === true) {
        // A bounded private candidate lookup; every candidate still needs its
        // exact live control proof. Overflow fails closed, never truncates.
        const provisioned = (await client.query<{ agent_id: string }>(`SELECT agent_id
          FROM access.agent_provision WHERE principal_id = $1 AND state = 'active' AND agent_kind = 'person'
          ORDER BY agent_id LIMIT $2`, [principalId, bounds.actingContexts + 1])).rows;
        if (provisioned.length > bounds.actingContexts) {
          throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
        }
        for (const row of provisioned) {
          if (await eligibleSubject(client, principalId, row.agent_id, true)) representedSubjects.push(row.agent_id);
        }
        representedSubjects = [...new Set(representedSubjects)].sort();
      }
      const direct = await client.query<{ acting_subject: string }>(`
        SELECT DISTINCT s.id AS acting_subject
        FROM access.principal_agent_attribution a
        JOIN access.authority_subject s ON s.id = a.agent_subject
        WHERE a.principal_id = $1 AND a.action = $2 AND a.active
          AND a.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
        ORDER BY s.id LIMIT $3`,
      [principalId, WORK_CREATE_CONTEXT.action, bounds.actingContexts + 1]);
      if (direct.rows.length > bounds.actingContexts
        || representedSubjects.length + direct.rows.length > bounds.actingContexts) {
        throw new ActingContextUnavailable('acting context discovery exceeds supported limit');
      }
      const directSubjects: string[] = [];
      for (const row of direct.rows) {
        if (await directWorkCreateProof(client, principalId, row.acting_subject)) {
          directSubjects.push(row.acting_subject);
        }
      }
      const option = (actingSubject: string): ActingContextOption => ({ actingSubject,
        displayName: null, handle: null, kind: null });
      const contexts = representedSubjects.map(option);
      const directContexts = directSubjects.map(option);
      const preferredEligible = contexts.some(row => row.actingSubject === preference?.acting_subject);
      return { profile: 'work-create-acting-contexts-v1', task: WORK_CREATE_CONTEXT.task,
        scope: WORK_CREATE_CONTEXT.scope, authorityEpoch: gate.authority_epoch,
        contexts, directContexts,
        preferredActingSubject: preferredEligible ? preference!.acting_subject : null,
        savedPreference: preference?.acting_subject
          ? { actingSubject: preference.acting_subject, eligible: preferredEligible } : null,
        preferenceRevision: preference?.revision ?? null,
        complete: true };
    });
    const subjects = [...new Set([...discovered.contexts, ...discovered.directContexts]
      .map(option => option.actingSubject))];
    const labels = await this.publicLabels(subjects);
    return { ...discovered,
      contexts: discovered.contexts.map(option => ({ ...option, ...labels.get(option.actingSubject) })),
      directContexts: discovered.directContexts.map(option => ({ ...option, ...labels.get(option.actingSubject) })) };
  }

  async check(principal: VerifiedPrincipal, actingSubject: string,
    expectedAuthorityEpoch: string,
    authorityPath: ActingAuthorityPath = 'represented-agent'):
    Promise<ActingContextCheck> {
    if (!agentId.test(actingSubject) || !epoch.test(expectedAuthorityEpoch)) {
      throw new ActingContextInvalid('invalid selected context');
    }
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      if (gate.authority_epoch !== expectedAuthorityEpoch) {
        throw new ActingContextStale('Work creation authority epoch changed');
      }
      if (!gate.open || !gate.dispatch_open) {
        throw new ActingContextDenied('Work creation scope or dispatch is closed');
      }
      const principalId = await activePrincipal(client, principal);
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const eligible = authorityPath === 'direct-principal'
        ? await directWorkCreateProof(client, principalId, actingSubject) !== null
        : await eligibleSubject(client, principalId, actingSubject, principal.emailVerified === true);
      if (!eligible) {
        throw new ActingContextDenied('selected context has no complete authority path');
      }
      return { profile: 'work-create-acting-context-check-v1',
        task: WORK_CREATE_CONTEXT.task, scope: WORK_CREATE_CONTEXT.scope,
        actingSubject, authorityPath, authorityEpoch: gate.authority_epoch,
        decision: 'eligible-now', reusable: false };
    });
  }

  /** Preflight one exact, represented Content draft permission. Admission
   * repeats these checks when the edit is registered. */
  async checkContentDraft(principal: VerifiedPrincipal, resource: string,
    actingSubject: string, expectedAuthorityEpoch: string): Promise<ContentDraftContextCheck> {
    if (!agentId.test(resource) || !agentId.test(actingSubject) || !epoch.test(expectedAuthorityEpoch)) {
      throw new ActingContextInvalid('invalid Content draft context');
    }
    const scope = `content:draft:${resource}`;
    if (scope.length > 256) throw new ActingContextInvalid('Content draft scope is too long');
    return transaction(this.pool, async client => {
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new ActingContextUnavailable('Access is held for recovery');
      await ensureBaselineScopeGate(client, scope);
      const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [scope])).rows[0];
      if (!gate) throw new ActingContextUnavailable('Content draft scope is unavailable');
      if (gate.authority_epoch !== expectedAuthorityEpoch) {
        throw new ActingContextStale('Content draft authority epoch changed');
      }
      if (!gate.open || !gate.dispatch_open) throw new ActingContextDenied('Content draft scope is closed');
      const principalId = await activePrincipal(client, principal);
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const baseline = await newBaselineProof(client, this.environment?.fuseki, {
        principal, actingSubject, action: 'content.draft', scope,
        idempotencyKey: 'preflight', requestDigest: '0'.repeat(64),
      }, principalId);
      const eligible = await client.query(`SELECT 1
        FROM access.authority_subject s
        JOIN access.representation r ON r.subject_id = s.id AND r.principal_id = $1
          AND r.action = 'content.draft' AND r.active AND r.valid_until > clock_timestamp()
        JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $2
          AND g.action = 'content.draft' AND g.active AND g.valid_until > clock_timestamp()
        WHERE s.id = $3 AND s.kind = 'agent' AND s.active LIMIT 1`,
      [principalId, scope, actingSubject]);
      if (!baseline && eligible.rowCount !== 1) throw new ActingContextDenied('selected context has no Content draft permission');
      return { profile: 'content-draft-acting-context-check-v1', task: 'content.draft',
        scope, resource, actingSubject, authorityEpoch: gate.authority_epoch,
        decision: 'eligible-now', reusable: false };
    });
  }

  async setPreference(principal: VerifiedPrincipal,
    input: SetActingContextPreference): Promise<ActingContextPreference> {
    if ((input.actingSubject !== null && !agentId.test(input.actingSubject))
      || (input.expectedRevision !== null && !revisionId.test(input.expectedRevision))
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
      throw new ActingContextInvalid('invalid acting context preference');
    }
    const digest = createHash('sha256').update(JSON.stringify({
      task: WORK_CREATE_CONTEXT.task, actingSubject: input.actingSubject,
      expectedRevision: input.expectedRevision,
    })).digest('hex');
    return transaction(this.pool, async client => {
      const gate = await currentGate(client);
      const principalRow = await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
      [principal.issuer, principal.subject]);
      const principalId = principalRow.rows[0]?.id;
      if (!principalId) throw new ActingContextDenied('principal is not admitted');
      const receipt = (await client.query<{
        request_digest: string; acting_subject: string | null; revision: string;
      }>(`SELECT request_digest, acting_subject, revision
          FROM access.acting_context_preference_receipt
          WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, input.idempotencyKey])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== digest) {
          throw new ActingContextStale('preference idempotency key was reused');
        }
        return { profile: 'work-create-acting-context-preference-v1',
          task: WORK_CREATE_CONTEXT.task, actingSubject: receipt.acting_subject,
          revision: receipt.revision, replayed: true };
      }
      const prior = (await client.query<{ revision: string }>(`
        SELECT revision FROM access.acting_context_preference
        WHERE principal_id = $1 AND task = $2 FOR UPDATE`,
      [principalId, WORK_CREATE_CONTEXT.task])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) {
        throw new ActingContextStale('acting context preference revision changed');
      }
      if (input.actingSubject !== null) {
        if (!gate.open || !gate.dispatch_open
          || !await eligibleSubject(client, principalId, input.actingSubject, principal.emailVerified === true)) {
          throw new ActingContextDenied('preferred Agent is unavailable for this task');
        }
      }
      const revision = randomUUID();
      const written = await client.query(`INSERT INTO access.acting_context_preference
        (principal_id, task, acting_subject, revision) VALUES ($1,$2,$3,$4)
        ON CONFLICT (principal_id, task) DO UPDATE
          SET acting_subject = EXCLUDED.acting_subject, revision = EXCLUDED.revision
          WHERE access.acting_context_preference.revision = $5`,
      [principalId, WORK_CREATE_CONTEXT.task, input.actingSubject, revision,
        input.expectedRevision]);
      if (written.rowCount !== 1) {
        throw new ActingContextStale('acting context preference revision changed');
      }
      await client.query(`INSERT INTO access.acting_context_preference_receipt
        (principal_id, idempotency_key, request_digest, task, acting_subject, revision)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [principalId, input.idempotencyKey, digest, WORK_CREATE_CONTEXT.task,
        input.actingSubject, revision]);
      return { profile: 'work-create-acting-context-preference-v1',
        task: WORK_CREATE_CONTEXT.task, actingSubject: input.actingSubject,
        revision, replayed: false };
    }, 'READ COMMITTED');
  }
}
