import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import manifest from '../../../generated/model/manifest.json';
import { commandBindingRead, commandBindingValue } from '../../../model/compiler/registry.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { profileValidations } from '../src/infrastructure/profile.ts';
import { discloseInventory } from '../src/modules/disclosure/read.ts';
import { unrecordedReasons } from '../src/modules/governance/notices.ts';
import type { DecisionInput } from '../src/modules/governance/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../src/modules/work/activate.ts';

async function json<T>(response: Response, status = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('ordinary Concept, Agent and Space reports confirm disclosure receipts and fence direct and directory reads', async () => {
  const label = `Graph moderation ${randomUUID()}`;
  const stack = await startMediaStack('graph-owner-disclosure', { profileCredits: true });
  try {
    const editor = await stack.member(`graph-owner-${randomUUID()}`), staff = await stack.member(`graph-staff-${randomUUID()}`);
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: label, capabilities: ['realm'], actingSubject: editor.actor,
    }));
    await editor.grant('classification:define:global', 'classification.proposition.define');
    const concept = await json<{ concept: string }>(await editor.send('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: label }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: editor.actor,
    }));
    await staff.grant('governance:platform', 'governance.moderate');
    await staff.grant('governance:platform', 'governance.rule.publish');
    const governance = stack.composition.dependencies.governance!;
    const rule = await governance.rules!.publish(staff.principal, {
      ref: `urn:rule:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: staff.actor,
      expectedRevision: null, document: { purpose: 'Review graph disclosure' }, idempotencyKey: randomUUID(),
    });
    const ownerResponses: unknown[] = [];
    const ownerQuery = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (query, maximum) => {
      try {
        const result = await ownerQuery(query, maximum);
        if (query.includes('# registry-binding:')) ownerResponses.push({ bindingRows: result.results?.bindings });
        return result;
      } catch (error) { ownerResponses.push({ queryError: String(error) }); throw error; }
    };
    const ownerCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async command => {
      try {
        const result = await ownerCommand(command);
        ownerResponses.push({ validations: command.validations, result });
        return result;
      } catch (error) { ownerResponses.push({ error: String(error) }); throw error; }
    };
    for (const [kind, resource] of [
      ['Concept', concept.concept],
      ['Agent', editor.actor],
      ['Space', space.space],
    ] as const) {
      const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH <${GRAPHS.current}> { <${resource}> rv:head ?head }
      } LIMIT 2`, 4096)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      const head = rows[0]!.head!.value;
      expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
        { <${resource}> a <https://schema.org/CreativeWork> } UNION { <${resource}> rv:mainVersion ?main }
      } }`, 1024)).boolean).toBe(false);
      const path = `/v1/resources/${resource.slice(-36)}`;
      await json(await stack.call('GET', path), 200);
      const target = { owner: 'graph' as const, resource, component: 'record' as const, revision: head, locator: null };
      expect(await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'search')).toEqual(['visible']);
      const report = await json<{ reportId: string; caseId: string }>(await editor.send('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: resource, actingSubject: editor.actor,
        category: 'harassment', statement: `Review this ordinary ${kind}.`, contentLanguage: 'en',
      }));
      const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
        `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
         JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
      await governance.store.safety.claim(staff.principal, staff.actor, report.caseId);
      const input: DecisionInput = {
        caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: staff.actor, outcome: 'restrict',
        targets: [{ ...target, revision: null, scopeKind: 'component', expectedHead: head, effect: 'disclosure' }],
        rule, evidenceDigest: basis.evidence_digest, reversesDecisionId: null, answersStepId: null,
        rationale: null, disclosure: 'private', idempotencyKey: randomUUID(), reasons: {
          ...unrecordedReasons, facts: 'The retained record was reviewed.', scope: `This ${kind} record.`,
          duration: 'Until reconsidered.', automation: false,
        },
      };
      const result = await governance.store.decide(staff.principal, input);
      expect(result.operation.status, JSON.stringify({ kind, ownerResponses })).toBe('completed');
      const effects = (await stack.accessPool.query<{ state: string; receipt: string }>(
        'SELECT state,receipt FROM access.safety_decision_effect WHERE decision_id=$1', [result.decisionId])).rows;
      expect(effects).toHaveLength(1);
      expect(effects[0]!.state).toBe('confirmed');
      expect(effects[0]!.receipt).toStartWith('urn:rezics:receipt:moderation:');
      expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.receipts}> {
        <${effects[0]!.receipt}> rv:moderationTarget <${resource}> ; rv:expectedHead <${head}> ; rv:outcome rv:Succeeded
      } }`, 2048)).boolean).toBe(true);
      expect((await stack.accessPool.query('SELECT effect,state FROM access.governance_enforcement WHERE decision_id=$1',
        [result.decisionId])).rows).toEqual([{ effect: 'disclosure', state: 'restricted' }]);
      expect((await stack.call('GET', path)).status).toBe(404);
      expect(['tombstone', 'hidden']).toContain((await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'read'))[0]);
      expect(await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'search')).toEqual(['hidden']);
      if (kind === 'Concept') {
        const vocabulary = await json<{ items: { id: string }[] }>(await stack.call('GET',
          `/v1/classification-vocabulary?q=${encodeURIComponent(label)}`), 200);
        expect(vocabulary.items.some(item => item.id === resource)).toBe(false);
      }
    }
  } finally { await stack.stop(); }
}, 180_000);

test('an ordinary Realm rating-context bundle binds structurally and native SHACL rejects a retired role', async () => {
  const stack = await startMediaStack('realm-rating-binding', { profileCredits: true });
  try {
    const editor = await stack.member(`rating-binding-${randomUUID()}`);
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ realm: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: `Rating binding ${randomUUID()}`, capabilities: ['realm'], actingSubject: editor.actor,
    }));
    await editor.grant(`rating:context:${space.realm}`, 'rating.context.create');
    const context = await json<{ context: string }>(await editor.send('POST', '/v1/rating-contexts', {
      profile: 'realm-target-rating-context-v4', realm: space.realm, question: 'How did this subject do?',
      language: 'en', targetGrain: 'resource', actingSubject: editor.actor,
    }));
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(space.realm)} a rv:Realm . FILTER NOT EXISTS { ${iri(space.realm)} a rv:GlobalRatingPopulation }
    } }`, 1024)).boolean).toBe(true);
    const profile = 'realm-target-rating-context-v4';
    const definition = manifest.profiles.find(entry => entry.id === profile)!.binding!;
    const shape = `https://rezics.com/definition/${profile}/context-shape`;
    const graphs = [GRAPHS.current, GRAPHS.revisions];
    const read = commandBindingRead(profile, definition, shape, graphs, manifest);
    const rows = (await stack.fuseki.query(`SELECT DISTINCT ${read.keys.map(key => `?${read.variables[key]}`).join(' ')} WHERE {
      VALUES ${read.anchor} { ${iri(context.context)} } ${read.pattern}
    } LIMIT 2`, 32_768)).results?.bindings ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row[read.variables.realm!]!.value).toBe(space.realm);
    const binding = Object.fromEntries([...definition.required, ...definition.optional]
      .filter(key => row[read.variables[key]!])
      .map(key => [key, commandBindingValue(key, row[read.variables[key]!]!.value)]));
    const validations = await profileValidations(stack.fuseki, profile, definition.roles.map(role => ({
      shape: `https://rezics.com/definition/${profile}/${role}-shape`,
      focus: [row[read.variables[role]!]!.value], graphs,
    })), binding);
    for (const retired of [false, true]) {
      const receipt = `urn:rezics:receipt:rating-binding:${randomUUID()}`;
      const digest = hash(receipt);
      const result = await stack.fuseki.commandWithReceipt({ receipt, digest, validations, deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}>
          DELETE {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
            ${retired ? `GRAPH ${iri(GRAPHS.current)} { ${iri(space.realm)} rv:realmState rv:Active }` : ''}
          }
          INSERT {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
            ${retired ? `GRAPH ${iri(GRAPHS.current)} { ${iri(space.realm)} rv:realmState rv:Retired }` : ''}
            GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ?epoch ; rv:sequence ?next ; rv:outcome rv:Succeeded }
            GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${digest}`)} a rv:OutboxBatch ;
              rv:dataEpoch ?epoch ; rv:sequence ?next ; rv:eventCount 0 }
          }
          WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n ; rv:dataEpoch ?epoch }
            BIND(?n + 1 AS ?next) FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          }` });
      expect(result.status, JSON.stringify(result)).toBe(retired ? 'invalid' : 'committed');
      if (result.status === 'invalid') expect(JSON.stringify(result.report)).toContain('realm-shape');
      expect((await stack.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }`, 1024)).boolean)
        .toBe(!retired);
    }
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(space.realm)} rv:realmState rv:Active
    } }`, 1024)).boolean).toBe(true);
  } finally { await stack.stop(); }
}, 180_000);
