import { expect, test } from 'bun:test';
import {
  FusekiClient,
  type CommandEnvelope,
  type CommandResult,
  type SparqlResult,
} from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { PRESENTATION_FAMILY } from '../src/modules/lexicon/schema.ts';
import {
  admitted,
  PendingSemanticChange,
  type SemanticAccess,
} from '../src/modules/semantic/admitted.ts';
import { familyReceiptIri, type SemanticTerminal } from '../src/modules/semantic/command.ts';
import { ModelGenerationChanged } from '../src/modules/semantic/generation-guard.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

function fixture(
  action:
    | 'semantic.change'
    | 'relation.change'
    | 'lexicon.presentation.change'
    | 'lexicon.presentation.review',
) {
  const family =
    action.split('.')[0] === 'lexicon' ? PRESENTATION_FAMILY : action.replace('.', '-');
  const admission: RegisteredAdmission = {
    id: Bun.randomUUIDv7(),
    principalId: Bun.randomUUIDv7(),
    actingSubject: 'actor',
    scope: 'scope',
    action,
    idempotencyKey: 'key',
    requestDigest: 'digest',
    authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed',
    dispatchEligible: true,
    replayed: false,
  };
  const terminal = (outcome: SemanticTerminal['outcome']): SemanticTerminal => ({
    outcome,
    receipt: familyReceiptIri(admission.id, family),
    admissionId: admission.id,
    requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch,
    scope: admission.scope,
    dataEpoch: 'epoch',
    sequence: '1',
    ...(outcome === 'succeeded'
      ? { component: 'component', revision: 'revision' }
      : { reason: 'generation-changed' as const }),
  });
  let sealed: SemanticTerminal | null = null;
  let dispatches = 0;
  let refusalAvailable = true;
  let loseRejectionResponse = false;
  let onRejection: (() => void) | undefined;
  const commands: CommandEnvelope[] = [];
  class Graph extends FusekiClient {
    override async query(query: string): Promise<SparqlResult> {
      if (!query.includes('SELECT ?outcome')) return { boolean: true };
      if (!sealed) return { results: { bindings: [] } };
      const fields = {
        outcome: `${RV}${sealed.outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`,
        ...(sealed.reason ? { reason: `${RV}GenerationChanged` } : {}),
        digest: sealed.requestDigest,
        admissionId: sealed.admissionId,
        authorityEpoch: sealed.authorityEpoch,
        scope: sealed.scope,
        sequence: sealed.sequence,
        epoch: sealed.dataEpoch,
        ...(sealed.component ? { component: sealed.component, revision: sealed.revision! } : {}),
      };
      return {
        results: {
          bindings: [
            Object.fromEntries(
              Object.entries(fields).map(([key, value]) => [key, { type: 'literal', value }]),
            ),
          ],
        },
      };
    }
    override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
      commands.push(envelope);
      onRejection?.();
      if (!sealed && refusalAvailable) sealed = terminal('cancelled');
      if (loseRejectionResponse) throw new Error('lost rejection acknowledgement');
      return { status: 'guard-unmatched' };
    }
  }
  const env: WorkActivationEnvironment = {
    fuseki: new Graph('http://unused.invalid'),
    objectDirectory: '.temp/model-generation-refusal',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
  };
  const outcomes: SemanticTerminal[] = [];
  const access: SemanticAccess = {
    register: async () => ({ ...admission }),
    claim: async () => ({ ...admission, claimedAt: new Date().toISOString() }),
    canReadWork: async () => true,
    recordGraphOutcome: async (_id, result) => {
      outcomes.push(result as SemanticTerminal);
      admission.state = 'sealed';
    },
  };
  const run = (
    dispatch: () => Promise<void> = async () => {
      throw new ModelGenerationChanged('retained generation');
    },
  ) =>
    admitted({
      env,
      account: { verify: async () => ({ issuer: 'issuer', subject: 'subject' }) },
      access,
      request: new Request('http://main.local'),
      actingSubject: admission.actingSubject,
      idempotencyKey: admission.idempotencyKey,
      action,
      family,
      scope: admission.scope,
      digest: admission.requestDigest,
      references: async () => [],
      dispatch: async () => {
        dispatches++;
        await dispatch();
        return 'success';
      },
      readTerminal: async () => sealed,
      result: () => 'success',
    });
  return {
    run,
    admission,
    outcomes,
    commands,
    terminal,
    get dispatches() {
      return dispatches;
    },
    aligned: () => {
      refusalAvailable = false;
    },
    loseResponse: () => {
      loseRejectionResponse = true;
    },
    concurrentWinner: () => {
      onRejection = () => {
        sealed = terminal('succeeded');
      };
    },
  };
}

for (const action of [
  'semantic.change',
  'relation.change',
  'lexicon.presentation.change',
  'lexicon.presentation.review',
] as const) {
  test(`${action} seals and replays a generation refusal before and after alignment`, async () => {
    const f = fixture(action);
    await expect(f.run()).rejects.toBeInstanceOf(ModelGenerationChanged);
    expect(f.admission.state).toBe('sealed');
    expect(f.outcomes[0]).toMatchObject({ outcome: 'cancelled', reason: 'generation-changed' });
    expect(f.commands).toHaveLength(1);
    f.aligned();
    await expect(f.run()).rejects.toBeInstanceOf(ModelGenerationChanged);
    expect(f.dispatches).toBe(1);
    expect(f.commands).toHaveLength(1);
  });
}

test('a prepared write that loses its generation guard seals the same refusal', async () => {
  const f = fixture('relation.change');
  await expect(
    f.run(async () => {
      throw new Error('guard did not match');
    }),
  ).rejects.toBeInstanceOf(ModelGenerationChanged);
  expect(f.outcomes[0]?.reason).toBe('generation-changed');
});

test('a lost rejection acknowledgement resolves and seals from the receipt', async () => {
  const f = fixture('semantic.change');
  f.loseResponse();
  await expect(f.run()).rejects.toBeInstanceOf(ModelGenerationChanged);
  expect(f.admission.state).toBe('sealed');
});

test('a concurrent successful receipt wins over generation refusal reconciliation', async () => {
  const f = fixture('relation.change');
  f.concurrentWinner();
  expect(await f.run()).toBe('success');
  expect(f.outcomes[0]?.outcome).toBe('succeeded');
});

test('an unchanged generation or still available bootstrap keeps an ambiguous dispatch pending', async () => {
  const f = fixture('semantic.change');
  f.aligned();
  await expect(
    f.run(async () => {
      throw new Error('transport unavailable');
    }),
  ).rejects.toBeInstanceOf(PendingSemanticChange);
  expect(f.admission.state).toBe('claimed');
  expect(f.outcomes).toHaveLength(0);
});
