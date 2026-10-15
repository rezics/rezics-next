import { foregroundCounted } from './support/query-cost-meter.ts';
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { classificationContextDigest, createClassificationContext }
  from '../../../services/main/src/modules/classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE, classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { PrivateContextSelections } from '../../../services/main/src/modules/context/private-selection.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, createWorkActivationEnvironment, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import type { ContextRouteDependencies } from '../../../services/main/src/routes/contexts.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { changeSemanticComponent, semanticChangeDigest } from '../../../services/main/src/modules/semantic/change.ts';

export const shortId = (uri: string) => uri.split('/').at(-1)!;
export const nativeId = () => `${ID}${Bun.randomUUIDv7()}`;
export const RV = 'https://rezics.com/vocab/';

/**
 * Real Account tokens, Access admission, Main routes and QA Jena for the Context and Statement
 * owner. The Fuseki proxy counts reads per request and can lose one command response.
 */
export async function contextFixture(apps: Record<string, string>,
  objectDirectory = resolve('.temp', `context-${randomUUID()}`)) {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const account = await ratingAccount(apps,
    'openid context:write context:select context:read statement:write statement:decide work:create work:edit work:read classification:decide rating:configure rating:submit');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 2 });
  const native = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
  let loseResponse: string | null = null;
  let localDecisionReadFault: 'missing-outcome' | 'failed-read' | null = null;
  let missingContextRevision: string | null = null;
  let statementReadFault: 'missing-pin-context' | 'missing-head' | null = null;
  let queries = 0;
  const fuseki = new Proxy(native, { get(target, property) {
    if (property === 'query') return async (text: string, maxResponseBytes?: number) => {
      if (!foregroundCounted()) return target.query(text, maxResponseBytes);
      queries++;
      if (localDecisionReadFault && text.includes('SELECT ?epoch ?sequence ?localSlot')) {
        const fault = localDecisionReadFault;
        localDecisionReadFault = null;
        if (fault === 'failed-read') throw new Error('injected local decision read failure');
        const result = await target.query(text, maxResponseBytes);
        for (const row of result.results?.bindings ?? []) delete row.localOutcome;
        return result;
      }
      if (missingContextRevision && text.includes('SELECT ?revision ?base ?depth')
        && text.includes(`BIND(<${missingContextRevision}> AS ?revision)`)) {
        const requestedRevision = missingContextRevision;
        missingContextRevision = null;
        const result = await target.query(text, maxResponseBytes);
        return { ...result, results: { ...result.results, bindings: (result.results?.bindings ?? [])
          .filter(row => row.revision?.value !== requestedRevision) } };
      }
      if (statementReadFault && text.includes('SELECT ?epoch ?sequence ?subject ?predicate ?object')) {
        const fault = statementReadFault;
        statementReadFault = null;
        const result = await target.query(text, maxResponseBytes);
        for (const row of result.results?.bindings ?? []) {
          if (fault === 'missing-pin-context') delete row.context;
          else delete row.headRevision;
        }
        return result;
      }
      return target.query(text, maxResponseBytes);
    };
    if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
      const result = await target.commandWithReceipt(envelope);
      if (loseResponse && envelope.update.includes(loseResponse)) {
        loseResponse = null;
        throw new Error('lost graph acknowledgement');
      }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as FusekiClient;
  const env: WorkActivationEnvironment = createWorkActivationEnvironment({ referenceFencePool: contentPool, fuseki,
    lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
    objectDirectory });
  const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
  access.configureBaseline(fuseki);
  const selections = new PrivateContextSelections(accessPool);
  const dependencies: MainWorkDependencies & ContextRouteDependencies = { environment: env,
    statementSeek: new StatementSeek(accessPool,env),
    platformAccess: new AccessExposure(accessPool),
    account: account.verifier, access, accessPolicy: new AccessPolicyOwner(accessPool),
    contextSelections: selections, judgments: new AccessJudgments(accessPool) };
  const app = createMainApp(fuseki, dependencies);
  const classificationContexts = new Map<string, {
    concept: string; senseRevision: string; context: string; semanticRevision: string }>();
  const classificationStatements = new Map<string, {
    concept: string; senseRevision: string; statement: string; meaningKey: string }>();
  const classificationDecisionGrants = new Set<string>();
  let classificationContextCreateGranted = false;
  let classificationStatementRecordGranted = false;

  const principalA = randomUUID();
  const principalB = randomUUID();
  const actorA = nativeId();
  const actorB = nativeId();
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3), ($4, $2, $5)`, [principalA, account.issuer, account.a.id, principalB, account.b.id]);
  await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent'), ($2, 'agent')`,
    [actorA, actorB]);
  /** Represent `actor` for `action` and grant it `scope`; returns the grant ID for revocation. */
  const grant = async (scope: string, action: string, actor = actorA, principal = principalA) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principal, actor, action]);
    const id = randomUUID();
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [id, actor, scope, action]);
    return id;
  };
  const revoke = async (grantId: string) => {
    await accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grantId]);
  };
  const call = (method: string, path: string, body?: object, key: string = randomUUID(),
    token: string | null = account.tokenA) => app.handle(new Request(`http://main.local${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const result = await response.json();
    if (response.status !== status) console.error('context fixture response', response.status, result);
    expect(response.status).toBe(status);
    return result as T;
  };

  // Setup-only owners outside this domain use their module commands with synthetic admissions.
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actorA, scope, action,
      idempotencyKey: `context-fixture-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const realm = async (name: string) => {
    const input = { name: `${name} ${randomUUID()}`, actingSubject: actorA };
    const created = await createRealmSpace(env, admission('space:create:root', 'space.create',
      spaceCreationDigest(input)), input);
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm creation failed');
    const contextInput = { realm: created.realm, actingSubject: actorA };
    const context = await createClassificationContext(env, admission(`classification:context:${created.realm}`,
      'classification.context.configure', classificationContextDigest(contextInput)), contextInput);
    if (context.outcome !== 'succeeded' || !context.context) throw new Error('Realm acceptance scope failed');
    return { realm: created.realm, acceptanceContext: context.context };
  };
  const work = async (title: string) => {
    const full = `${title} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title: full,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(full)) });
    return created;
  };
  /** The retained Global acceptance scope is created by its existing v1 owner command. */
  const globalAcceptance = async () => {
    const input = { label: `Context fixture ${randomUUID()}`, actingSubject: actorA };
    const created = await createClassificationProposition(env, admission('classification:define:global',
      'classification.proposition.define', classificationPropositionDigest(input)), input);
    if (created.outcome !== 'succeeded') throw new Error('Global acceptance scope failed');
  };
  const property = async () => {
    const state = { component: 'definition' as const, kind: 'property' as const,
      lifecycle: 'active' as const, successor: null, roles: [] };
    const saved = await changeSemanticComponent(env, { expectedHead: null, state,
      admission: admission('semantic:create:root', 'semantic.change', semanticChangeDigest(undefined, null, state)) });
    await grant(`semantic:read:${saved.component}`, 'semantic.read');
    await grant(`semantic:read:${saved.component}`, 'semantic.read', actorB, principalB);
    return { predicate: saved.component, relationDefinition: saved.revision };
  };
  const decideClassification = async (input: { mainVersion: string; sense: string;
    senseRevision: string; concept: string; acceptance: { kind: 'global' } | { kind: 'realm'; realm: string };
    expectedDecisionHead: string | null; outcome: 'accepted' | 'rejected' }) => {
    let interpretation = classificationContexts.get(input.sense);
    if (interpretation && (interpretation.concept !== input.concept
      || interpretation.senseRevision !== input.senseRevision)) {
      throw new Error('classification sense changed its retained meaning');
    }
    if (!interpretation) {
      if (!classificationContextCreateGranted) {
        await grant('context:create:root', 'context.create');
        classificationContextCreateGranted = true;
      }
      const created = await json<{ context: string; semanticRevision: string }>(await call('POST',
        '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
          entries: [{ target: input.concept, relation: CLASSIFIED_AS, state: 'defined',
            definition: input.senseRevision, applicability: [] }], actingSubject: actorA }), 201);
      interpretation = { concept: input.concept, senseRevision: input.senseRevision,
        context: created.context, semanticRevision: created.semanticRevision };
      classificationContexts.set(input.sense, interpretation);
    }

    const supportKey = `${input.mainVersion}\0${input.sense}`;
    let support = classificationStatements.get(supportKey);
    if (support && (support.concept !== input.concept || support.senseRevision !== input.senseRevision)) {
      throw new Error('classification support changed its retained meaning');
    }
    if (!support) {
      if (!classificationStatementRecordGranted) {
        await grant(`statement:speak:${actorA}`, 'statement.record');
        classificationStatementRecordGranted = true;
      }
      const written = await json<{ statement: string; meaningKey: string }>(await call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: input.mainVersion,
        predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
        value: { kind: 'resource', iri: input.concept }, applicability: [],
        interpretation: { kind: 'explicit', context: interpretation.context,
          semanticRevision: interpretation.semanticRevision }, evidence: [], actingSubject: actorA,
      }), 201);
      support = { concept: input.concept, senseRevision: input.senseRevision,
        statement: written.statement, meaningKey: written.meaningKey };
      classificationStatements.set(supportKey, support);
    }

    const scope = input.acceptance.kind === 'global' ? 'classification:decide:global'
      : `classification:decide:${input.acceptance.realm}`;
    await accessPool.query(`INSERT INTO access.judgment_aggregate
      (statement, context_key, spoiler_none) VALUES ($1, $2, 8)
      ON CONFLICT (statement, context_key) DO NOTHING`, [support.statement,
        input.acceptance.kind === 'global' ? 'global' : input.acceptance.realm]);
    if (!classificationDecisionGrants.has(scope)) {
      await grant(scope, 'statement.decide');
      classificationDecisionGrants.add(scope);
    }
    return json<{ decision: string }>(await call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1',
      target: { kind: 'qualified-fact', meaningKey: support.meaningKey, support: [support.statement] },
      acceptance: input.acceptance, expectedDecisionHead: input.expectedDecisionHead,
      outcome: input.outcome, actingSubject: actorA,
    }), 201);
  };
  return { account, access, accessPool, env, app, selections, principalA, principalB, actorA, actorB,
    admission, grant, revoke, decideClassification,
    call, json, realm, work, globalAcceptance, property,
    queries: () => queries, resetQueries: () => { queries = 0; },
    loseNextResponse: (marker: string) => { loseResponse = marker; },
    faultNextLocalDecisionRead: (fault: 'missing-outcome' | 'failed-read') => { localDecisionReadFault = fault; },
    faultNextContextChainRead: (revision: string) => { missingContextRevision = revision; },
    faultNextStatementRead: (fault: 'missing-pin-context' | 'missing-head') => { statementReadFault = fault; },
    close: async () => { await account.close(); await accessPool.end(); await contentPool.end(); } };
}

export type ContextFixture = Awaited<ReturnType<typeof contextFixture>>;
