import { describe, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { definitionCreatorAllowed } from '../../../services/main/src/modules/access/definition-creator.ts';
import {
  baselineTarget,
  baselineTargetAllowed,
  baselineProofCurrent,
  newBaselineProof,
  type BaselineProof,
} from '../../../services/main/src/modules/access/baseline.ts';
import { ensureBaselineScopeGate } from '../../../services/main/src/modules/access/scope-gates.ts';

const principal = '00000000-0000-4000-a000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-a000-000000000002';
const definition = 'https://rezics.com/id/00000000-0000-4000-a000-000000000003';
const admission = '00000000-0000-4000-a000-000000000004';
const receipt = `urn:rezics:receipt:${'a'.repeat(64)}`;
const requestDigest = 'b'.repeat(64);

function fixture() {
  const state = {
    sealed: true,
    succeeded: true,
    active: true,
    generation: '1',
    rows: 1,
    policy: false,
  };
  const proof: BaselineProof = {
    policy_generation: '1',
    provision_id: 'provision',
    representation_id: 'control',
    representation_generation: '1',
    subject_generation: '1',
    principal_epoch: '1',
    collection_create: false,
    related_work: null,
    source_revision: null,
    maintainer_generation: null,
  };
  let graphCalls = 0,
    ownerCalls = 0;
  const graph = {
    query: async (_query: string, bytes: number) => {
      graphCalls++;
      expect(bytes).toBe(4096);
      return {
        results: {
          bindings: Array.from({ length: state.rows }, () => ({
            admission: { type: 'literal', value: admission },
            receipt: { type: 'uri', value: receipt },
            digest: { type: 'literal', value: requestDigest },
          })),
        },
      };
    },
  } as unknown as Pick<FusekiClient, 'query'>;
  const client = {
    query: async (query: string, values: unknown[]) => {
      if (query.includes('FROM access.policy')) return { rows: [], rowCount: state.policy ? 1 : 0 };
      // Definition edits use the steward controller proof, which joins the
      // provision from the authority subject rather than reading it first.
      if (query.includes('access.agent_provision'))
        return {
          rows: state.active ? [{ ...proof, representation_generation: state.generation }] : [],
        };
      ownerCalls++;
      expect(query).toContain("state = 'sealed'");
      expect(query).toContain("graph_outcome = 'succeeded'");
      return {
        rows: [],
        rowCount:
          state.sealed &&
          state.succeeded &&
          values[1] === principal &&
          values[2] === actor &&
          values[3] === receipt &&
          values[4] === requestDigest
            ? 1
            : 0,
      };
    },
  } as unknown as PoolClient;
  return { state, proof, client, graph, costs: () => ({ graphCalls, ownerCalls }) };
}

describe('G-724 definition creator authority', () => {
  test('creation receipt admits only its principal and Agent, not a reader or another controller', async () => {
    const h = fixture();
    expect(await definitionCreatorAllowed(h.client, h.graph, principal, actor, definition)).toBe(
      true,
    );
    expect(
      await definitionCreatorAllowed(
        h.client,
        h.graph,
        '00000000-0000-4000-a000-000000000009',
        actor,
        definition,
      ),
    ).toBe(false);
    expect(
      await definitionCreatorAllowed(h.client, h.graph, principal, definition, definition),
    ).toBe(false);
    h.state.sealed = false;
    expect(await definitionCreatorAllowed(h.client, h.graph, principal, actor, definition)).toBe(
      false,
    );
    h.state.sealed = true;
    h.state.succeeded = false;
    expect(await definitionCreatorAllowed(h.client, h.graph, principal, actor, definition)).toBe(
      false,
    );
  });
  test('absent, protected, erased, retired or ambiguous graph evidence denies without an owner lookup', async () => {
    const h = fixture();
    h.state.rows = 0;
    expect(await definitionCreatorAllowed(h.client, h.graph, principal, actor, definition)).toBe(
      false,
    );
    h.state.rows = 2;
    expect(await definitionCreatorAllowed(h.client, h.graph, principal, actor, definition)).toBe(
      false,
    );
    expect(h.costs()).toEqual({ graphCalls: 2, ownerCalls: 0 });
    expect(await definitionCreatorAllowed(h.client, undefined, principal, actor, definition)).toBe(
      false,
    );
    expect(
      await definitionCreatorAllowed(
        h.client,
        h.graph,
        principal,
        actor,
        'https://attacker.invalid/>',
      ),
    ).toBe(false);
    expect(h.costs()).toEqual({ graphCalls: 2, ownerCalls: 0 });
  });
  test('Access admits semantic and label edits; creation and independent review remain privileged', async () => {
    expect(baselineTarget('semantic.change', 'semantic:create:root')).toBeNull();
    expect(baselineTarget('lexicon.presentation.review', `semantic:edit:${definition}`)).toBeNull();
    expect(baselineTarget('semantic.read', `semantic:edit:${definition}`)).toBeNull();
    expect(baselineTarget('lexicon.presentation.change', `semantic:edit:${definition}`)).toEqual({
      kind: 'definition',
      id: definition,
    });
    const h = fixture();
    expect(
      await baselineTargetAllowed(
        h.client,
        h.graph,
        principal,
        actor,
        { kind: 'definition', id: definition },
        false,
      ),
    ).toBe(true);
    const request = {
      principal: {
        issuer: 'https://account.example/api/auth',
        subject: 'operator',
        emailVerified: true,
      },
      actingSubject: actor,
      scope: `semantic:edit:${definition}`,
      action: 'lexicon.presentation.change',
      idempotencyKey: 'test',
      requestDigest,
    };
    const saved = await newBaselineProof(h.client, h.graph, request, principal);
    expect(saved).not.toBeNull();
    expect(
      await newBaselineProof(
        h.client,
        h.graph,
        { ...request, principal: { ...request.principal, emailVerified: undefined } },
        principal,
      ),
    ).toBeNull();
    h.state.policy = true;
    expect(await newBaselineProof(h.client, h.graph, request, principal)).toBeNull();
    h.state.policy = false;
    const admitted = {
      principal_id: principal,
      acting_subject: actor,
      scope_id: request.scope,
      action: request.action,
    };
    expect(await baselineProofCurrent(h.client, h.graph, saved!, admitted)).toBe(true);
    h.state.generation = '2';
    expect(await baselineProofCurrent(h.client, h.graph, saved!, admitted)).toBe(false);
    h.state.generation = '1';
    h.state.active = false;
    expect(await baselineProofCurrent(h.client, h.graph, saved!, admitted)).toBe(false);
  });
  test('derived edit gate creation preserves prior closures and epochs, with no grants', async () => {
    const calls: string[] = [];
    const client = {
      query: async (query: string) => {
        calls.push(query);
      },
    } as unknown as PoolClient;
    await ensureBaselineScopeGate(client, `semantic:edit:${definition}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ON CONFLICT (id) DO NOTHING');
    await ensureBaselineScopeGate(client, 'semantic:create:root');
    expect(calls).toHaveLength(1);
  });
});
