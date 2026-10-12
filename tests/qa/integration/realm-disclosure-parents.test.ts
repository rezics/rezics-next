import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import {
  captureDisclosure,
  configureDisclosure,
  configureDisclosureAncestrySource,
  DISCLOSURE_CHANNELS,
  DisclosureStore,
  DisclosureUnavailable,
  disclose,
  fenceDisclosure,
  resolveDisclosureSelections,
  type DisclosureAncestryEvidence,
  type DisclosureAncestrySource,
  type DisclosureChannel,
  type DisclosureRelationshipBasis,
  type DisclosureTarget,
  type OwnerEstablishedGraphParent,
  type OwnerEstablishedGraphParents,
} from '../../../services/main/src/modules/disclosure/read.ts';
import {
  ANONYMOUS_VIEWER,
  type Viewer,
} from '../../../services/main/src/modules/suitability/policy.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface PlanNode {
  'Node Type': string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Relation Name'?: string;
  'Rows Removed by Filter'?: number;
  'Subplan Name'?: string;
  'CTE Name'?: string;
  Plans?: PlanNode[];
}
function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

/** Committed owner-policy fixture. Admission/Realm shape validation is owned by
 * governance tests; these rows exercise the real Access read and final cut. */
async function restriction(
  pool: Pool,
  principalId: string,
  actor: string,
  resource: string,
  component: 'record' | 'title' | 'name' | 'publication',
  revision: string | null = null,
  effect: 'disclosure' | 'search' = 'disclosure',
) {
  const caseId = randomUUID(), decisionId = randomUUID();
  let fenceId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,$3,'private')`,
      [caseId, resource, component],
    );
    await client.query(
      `INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
      authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
      evidence_digest,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform',
      'governance:platform',0,$5,$1::text,$5,'urn:rezics:rule:disclosure-parent','1',$5,$5,'private',$6::jsonb)`,
      [
        decisionId,
        caseId,
        principalId,
        actor,
        digest(decisionId),
        {
          ...fixtureReasons,
          rule: {
            ref: 'urn:rezics:rule:disclosure-parent',
            revision: '1',
            digest: digest(decisionId),
          },
        },
      ],
    );
    await client.query(
      `INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
      VALUES ($1,1,'graph',$2,$3,$4,$5,$5,$6)`,
      [
        decisionId,
        resource,
        component,
        revision === null ? 'component' : 'exact_revision',
        revision,
        effect,
      ],
    );
    const recorded = await client.query<{ id: string }>(
      `INSERT INTO access.governance_enforcement AS current
      (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
      VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,$3,$4,$5,$6,1,'restricted',1)
      ON CONFLICT (owner,resource,component,revision,effect,context,authority_scope_id)
      DO UPDATE SET state='restricted',decision_id=EXCLUDED.decision_id,
        decision_ordinal=EXCLUDED.decision_ordinal,fence_epoch=current.fence_epoch+1 RETURNING id`,
      [fenceId, resource, component, revision, effect, decisionId],
    );
    fenceId = recorded.rows[0]!.id;
    await client.query(
      `UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1`,
      [caseId, decisionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return async () => {
    const restored = randomUUID(),
      release = await pool.connect();
    try {
      await release.query('BEGIN');
      await release.query(
        `INSERT INTO access.moderation_decision
        (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
        evidence_digest,disclosure,statement_of_reasons)
        SELECT $1::uuid,kind,'restore',context,case_id,case_sequence+1,principal_id,acting_subject,authority_kind,
        authority_scope_id,authority_epoch,authority_proof_digest,$1::text,request_digest,rule_ref,rule_revision,
        rule_digest,evidence_digest,disclosure,statement_of_reasons FROM access.moderation_decision WHERE id=$2`,
        [restored, decisionId],
      );
      await release.query(
        `INSERT INTO access.moderation_decision_target
        (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
        SELECT $1,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect
        FROM access.moderation_decision_target WHERE decision_id=$2`,
        [restored, decisionId],
      );
      await release.query(
        `UPDATE access.governance_case SET decision_head=$2,generation=2,
        state='closed',closed_at=clock_timestamp() WHERE id=$1`,
        [caseId, restored],
      );
      await release.query(
        `UPDATE access.governance_enforcement SET state='released',decision_id=$2,
        fence_epoch=fence_epoch+1 WHERE id=$1`,
        [fenceId, restored],
      );
      await release.query('COMMIT');
    } catch (error) {
      await release.query('ROLLBACK');
      throw error;
    } finally {
      release.release();
    }
  };
}

test('Realm disclosure: real Access preserves Work and Realm fences, independent publication and final-cut races', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `disclosure-parents-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  const work = nativeId(),
    realm = nativeId(),
    space = nativeId(),
    reply = nativeId();
  const workHead = nativeId(),
    realmHead = nativeId(),
    pinnedWorkHead = nativeId();
  let currentWorkHead = workHead,
    token = digest('selected-placement'),
    sourceAvailable = true;
  const body: DisclosureTarget = {
    owner: 'content',
    resource: reply,
    component: 'body',
    revision: randomUUID(),
  };
  const media: DisclosureTarget = {
    owner: 'media',
    resource: `urn:rezics:media:${randomUUID()}`,
    component: 'media_use',
    revision: randomUUID(),
  };
  const direct: DisclosureTarget = {
    owner: 'graph',
    resource: realm,
    component: 'record',
    revision: realmHead,
  };
  const independent: DisclosureTarget = {
    owner: 'content',
    resource: `urn:rezics:publication:${randomUUID()}`,
    component: 'body',
    revision: randomUUID(),
  };
  const targets = [body, media, direct, independent];
  const relationship = (target: DisclosureTarget): DisclosureRelationshipBasis => ({
    owner: target.owner === 'media' ? 'media' : target.owner === 'graph' ? 'graph' : 'content',
    kind:
      target === direct
        ? 'identity'
        : target === independent
          ? 'publication'
          : target === media
            ? 'media-use'
            : 'realm-placement',
    resource:
      target === direct ? realm : `urn:rezics:disclosure-occurrence:${target.resource.slice(-36)}`,
    revision: target === direct ? realmHead : 'urn:rezics:disclosure-occurrence:revision:1',
    targetResource: target.resource,
    targetRevision: target.revision ?? null,
    token,
    dataEpoch: f.env.lineage.dataEpoch,
  });
  const evidence = (input: DisclosureTarget): DisclosureAncestryEvidence => {
    const selected = targets.find(
      (target) => target.owner === input.owner && target.resource === input.resource,
    );
    if (!selected) throw new Error('Unknown fixture occurrence');
    const parents: OwnerEstablishedGraphParents =
      selected === direct || selected === independent
        ? []
        : [
            {
              owner: 'graph',
              kind: 'work',
              resource: work,
              head: currentWorkHead,
              protectedRevision: pinnedWorkHead,
              relationshipBasis: relationship(selected),
            },
            {
              owner: 'graph',
              kind: 'realm',
              resource: realm,
              head: realmHead,
              relationshipBasis: relationship(selected),
            },
          ];
    return {
      resource: input.resource,
      resourceKind: selected === direct ? 'realm' : 'other',
      relationshipBasis: relationship(selected),
      parents,
      status: sourceAvailable ? 'complete' : 'unavailable',
    };
  };
  const source: DisclosureAncestrySource = {
    read: async (inputs) => inputs.map(evidence),
    reread: async (bases) =>
      bases.map((basis) =>
        evidence(targets.find((target) => target.resource === basis.targetResource)!),
      ),
  };
  const reader = new DisclosureStore(f.accessPool);
  configureDisclosure(f.env, reader);
  for (const owner of ['graph', 'content', 'media'] as const)
    configureDisclosureAncestrySource(f.env, owner, source);
  const capture = async (
    inputs = targets,
    channel: DisclosureChannel = 'read',
    viewer: Viewer = ANONYMOUS_VIEWER,
  ) => captureDisclosure(f.env, await resolveDisclosureSelections(f.env, inputs), viewer, channel);
  const decisions = async (
    inputs = targets,
    channel: DisclosureChannel = 'read',
    viewer: Viewer = ANONYMOUS_VIEWER,
  ) => (await capture(inputs, channel, viewer)).map((cut) => cut.decision);
  const restrict = (
    resource: string,
    component: 'record' | 'title' | 'name' | 'publication',
    revision: string | null = null,
    effect: 'disclosure' | 'search' = 'disclosure',
  ) => restriction(f.accessPool, f.principalId, f.actor, resource, component, revision, effect);
  try {
    const client = await f.accessPool.connect();
    try {
      await client.query('BEGIN');
      await grantFixtureAuthority(client, {
        scope: 'governance:platform',
        requireDispatch: true,
        representations: [
          {
            principalId: f.principalId,
            actor: f.actor,
            action: 'governance.moderate',
            lifetime: '8 hours',
          },
        ],
        grant: { actor: f.actor, action: 'governance.moderate', lifetime: '8 hours' },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    // Native heads are live graph data. Relationship proof is supplied by an
    // explicit trusted test source; production adapters have separate acceptance.
    await f.env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(workHead)} .
      ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(space)} ; rv:head ${iri(realmHead)} .
      ${iri(space)} a rv:Space ; rv:realmCapability ${iri(realm)} .
    } }`);
    expect(await decisions()).toEqual(['visible', 'visible', 'visible', 'visible']);

    // Narrower Realm controls do not create whole-Realm closure or propagate
    // into a thread body/media use. They remain after whole-Realm restoration.
    const narrower: Array<() => Promise<void>> = [];
    narrower.push(await restrict(realm, 'title'));
    narrower.push(await restrict(realm, 'name'));
    narrower.push(await restrict(realm, 'publication'));
    narrower.push(await restrict(realm, 'record', realmHead));
    narrower.push(await restrict(realm, 'record', null, 'search'));
    for (const channel of ['read', 'thread'] as const)
      expect(await decisions([body, media, independent], channel)).toEqual([
        'visible',
        'visible',
        'visible',
      ]);

    const releaseWork = await restrict(work, 'title', workHead);
    // Low-level policy batches remain usable by existing owners. Public
    // compatibility reads below still require positively established ancestry.
    expect(await reader.read([body], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
    expect(await reader.read([{ ...body, work, workRevision: workHead }], ANONYMOUS_VIEWER, 'read'))
      .toEqual(['tombstone']);
    expect(await reader.read([{ ...body, work }], ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
    const constrained = await capture([body]);
    expect(constrained[0]!.decision).toBe('tombstone');
    expect(constrained[0]!.parents.map((parent) => parent.kind)).toEqual(['work', 'realm']);
    const releaseRealm = await restrict(realm, 'record');
    const member: Viewer = {
      signedIn: true,
      age: 'adult',
      country: 'US',
      optIns: { general: true, r15: true, sexual: true, grotesque: true },
    };
    // Platform or manager authority does not enter the ordinary policy read.
    // The signed-in principal here also holds the fixture platform mandate.
    for (const viewer of [ANONYMOUS_VIEWER, member]) {
      for (const channel of DISCLOSURE_CHANNELS) {
        expect(await decisions(targets, channel, viewer)).toEqual([
          'hidden',
          'hidden',
          'hidden',
          'visible',
        ]);
      }
    }
    expect(await fenceDisclosure(f.env, constrained, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
    await releaseRealm();
    expect(await decisions([body])).toEqual(['tombstone']);
    expect(await decisions([{ ...direct, component: 'title', nameOwnerResolved: true }])).toEqual([
      'tombstone',
    ]);
    await releaseWork();
    expect(await decisions([body])).toEqual(['visible']);
    for (const release of narrower) await release();

    const pinnedRelease = await restrict(work, 'title', pinnedWorkHead);
    expect(await decisions([body])).toEqual(['tombstone']);
    const oldCut = await capture([body]);
    currentWorkHead = nativeId();
    await f.env.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:head ${iri(workHead)} } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:head ${iri(currentWorkHead)} } } WHERE {}`);
    await expect(fenceDisclosure(f.env, oldCut, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
    expect(await decisions([body])).toEqual(['tombstone']);
    const [legacy] = await resolveDisclosureSelections(f.env, [
      { ...body, work, workRevision: pinnedWorkHead },
    ]);
    expect(
      (
        legacy!.ancestry.parents.find(
          (parent) => parent.kind === 'work',
        ) as OwnerEstablishedGraphParent
      ).protectedRevision,
    ).toBe(pinnedWorkHead);
    await pinnedRelease();

    const placed = await capture([body]);
    token = digest('replacement-placement-review-attachment');
    await expect(fenceDisclosure(f.env, placed, ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
    const beforeClose = await capture([body]);
    const releaseLate = await restrict(realm, 'record');
    expect(await fenceDisclosure(f.env, beforeClose, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
    const hidden = await capture([body]);
    await releaseLate();
    expect(await fenceDisclosure(f.env, hidden, ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);

    // Unrelated fences must not turn the exact parent lookup into ancestry
    // enumeration. Read the native plan rather than infer cost from call count.
    for (let index = 0; index < 512; index++) await restrict(nativeId(), 'record');
    await f.accessPool.query('ANALYZE access.governance_enforcement');
    const batch = Array.from({ length: 64 }, (): DisclosureTarget => ({
      ...body,
      resource: nativeId(),
    }));
    targets.push(...batch);
    const measured = await f.accessPool.connect();
    let policyQuery: { sql: string; args: unknown[] } | undefined;
    const recorded = new Proxy(measured, {
      get(client, property) {
        if (property === 'query')
          return (sql: string, args?: unknown[]) => {
            if (sql.includes('WITH fence AS MATERIALIZED') && sql.includes('parent_edges'))
              policyQuery = { sql, args: args ?? [] };
            return client.query(sql, args);
          };
        const value: unknown = Reflect.get(client, property, client);
        return typeof value === 'function' ? value.bind(client) : value;
      },
    });
    try {
      const selections = await resolveDisclosureSelections(f.env, batch);
      const cuts = await captureDisclosure(f.env, selections, ANONYMOUS_VIEWER, 'read', recorded);
      expect(cuts.map((cut) => cut.decision)).toEqual(Array.from({ length: 64 }, () => 'visible'));
      expect(cuts.flatMap((cut) => cut.parents)).toHaveLength(128);
      expect(policyQuery).toBeDefined();
      const plan = (
        await measured.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${policyQuery!.sql}`,
          policyQuery!.args,
        )
      ).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(64);
      const parentNodes = planNodes(plan).filter(
        (node) =>
          node['CTE Name'] === 'parent_edges' || node['Subplan Name'] === 'CTE parent_edges',
      );
      expect(parentNodes.length).toBeGreaterThan(0);
      for (const node of parentNodes) expect(node['Actual Rows']).toBeLessThanOrEqual(128);
      const enforcementNodes = planNodes(plan).filter(node => node['Relation Name'] === 'governance_enforcement');
      expect(enforcementNodes.length).toBeGreaterThan(0);
      for (const node of enforcementNodes) {
        // A scan of unrelated retained fences would grow with the owner table,
        // even when its final result and parent-edge cardinality stay bounded.
        expect(node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(128);
      }
    } finally {
      measured.release();
      targets.splice(targets.length - batch.length, batch.length);
    }

    const paused = await f.accessPool.connect();
    try {
      await paused.query('BEGIN');
      await paused.query('UPDATE access.recovery_fence SET open=false WHERE id');
      const selection = await resolveDisclosureSelections(f.env, [body]);
      await expect(
        captureDisclosure(f.env, selection, ANONYMOUS_VIEWER, 'read', paused),
      ).rejects.toBeInstanceOf(DisclosureUnavailable);
    } finally {
      await paused.query('ROLLBACK');
      paused.release();
    }
    sourceAvailable = false;
    await expect(capture([body])).rejects.toBeInstanceOf(DisclosureUnavailable);
    await expect(disclose(f.env, [body], ANONYMOUS_VIEWER, 'read')).rejects.toBeInstanceOf(
      DisclosureUnavailable,
    );
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
