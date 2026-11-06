import { expect, test } from 'bun:test';
import {
  type WorkApplicationPorts,
  type WorkIntent,
  type WorkRetirementFence,
  type WorkWriterState,
} from '../../src/work/contract/index.ts';
import { createWorkApplication, WorkCompositionError } from '../../src/work/application/index.ts';
import { bindWorkApplication, tryWorkApplication, unbindWorkApplication } from '../../src/work/adapters/bind.ts';

const intent: WorkIntent = {
  queue: 'workflows',
  workflowName: 'library.membersPreparation',
  workflowId: '11111111-1111-4111-8111-111111111111',
  input: { accounts: ['22222222-2222-4222-8222-222222222222'] },
};

const writer: WorkWriterState = {
  workflowID: intent.workflowId,
  generation: '1',
  restoreGeneration: 'restore',
  closureID: null,
  closedAt: null,
};

const fence: WorkRetirementFence = {
  workflowID: intent.workflowId,
  generation: '2',
  closureID: '33333333-3333-4333-8333-333333333333',
  closedAt: 1,
};

function fakePorts(overrides: Partial<WorkApplicationPorts> = {}): WorkApplicationPorts {
  const queues: string[] = [];
  const workflows: string[] = [];
  let initialized = false;
  return {
    sdkEnqueue: {
      async enqueueInTransaction(_sdk, _tx, received, capture) {
        expect(received).toEqual(intent);
        capture?.(true);
      },
    },
    sdkRuntime: {
      isInitialized: () => initialized,
      setConfig() {},
      async registerQueue(_client, name) {
        queues.push(name);
      },
      async launch() {
        initialized = true;
      },
      async shutdown() {
        initialized = false;
      },
      registerWorkflow(_body, config) {
        workflows.push(config.name);
      },
      async runStep(body) {
        return body();
      },
      async applySchedules() {},
      async deleteWorkflows() {},
    },
    sdkRetirement: {
      async retireWorkflow(id) {
        expect(id).toBe(intent.workflowId);
        return fence;
      },
      async readFence(id) {
        expect(id).toBe(intent.workflowId);
        return fence;
      },
      async readWriterState() {
        return writer;
      },
      async lockWriterState(_tx, _pool, expected) {
        expect(expected).toEqual(writer);
        return writer;
      },
      supportsBoundedMaintenance() {
        return true;
      },
      async maintainOnce() {
        return fence;
      },
    },
    sdkSelected: {
      registerSelectedStep() {
        throw new Error('selected SDK unused');
      },
      getSelectedExecution() {
        return undefined;
      },
      selectedExecutionIdentity() {
        throw new Error('selected SDK unused');
      },
      async consumeSelectedExecutionAdmission() {
        return false;
      },
      async checkSelectedExecutionInTransaction() {},
      isSelectedClient() {
        return false;
      },
    },
    sql: {
      async hasRetainedCopies() {
        return false;
      },
    },
    history: {
      validateLocator() {},
      validateScope() {},
      encodeLocator() {
        return new Uint8Array();
      },
      beginSerialization() {},
      async recordCopy() {},
      async guardAccounts() {},
      async persist() {
        return { retired: false, admitted: false };
      },
      async readOrigin() {
        throw new Error('origin unused');
      },
      async withConnection(_pool, body) {
        return body({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
      async beginSerializable() {},
      async commit() {},
      async rollback() {},
      async lockReceiving() {
        return undefined;
      },
      async insertRecordCopies() {},
      async insertRecordSets() {},
      async markAdmitted() {},
      async settleOwner() {},
      async readIdentityMapping() {
        return undefined;
      },
      async bindIdentityDigest() {
        return true;
      },
      async captureIdentityCreation() {},
      currentCommand() {
        return { partition: 0, transactionId: 'tx' };
      },
      commandPool() {
        return {};
      },
    },
    operational: {
      async runTransaction(_pool, _options, body) {
        return body({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
      currentResources() {
        return {
          pool: {},
          workClient: {},
          deadline: Date.now() + 1_000,
          partition: 0,
          mode: 'work-step',
          kind: 'test',
          accounts: [],
        };
      },
    },
    selectedAssociation: {
      async associateEpisode() {
        throw new Error('association unused');
      },
      async finishEpisode() {
        throw new Error('association unused');
      },
    },
    route: {
      routeOf: () => 0,
      partitionOf: () => 0,
    },
    authorization: {
      create() {
        return { access: {}, readConsent: {} };
      },
    },
    effects: {
      identityFxName: 'agent_verification_reversal',
      bindIdentityOriginal(effect) {
        return effect;
      },
      register() {
        return { async enqueue() {} };
      },
    },
    historyRegistry: {
      create() {
        return { seal() {} };
      },
    },
    kindConsent: {
      readConfig() {
        return null;
      },
      createParticipant() {
        return undefined;
      },
    },
    retentionSelector: {
      create() {
        return async () => [];
      },
    },
    cost: {
      isBound: () => true,
    },
    clock: () => new Date(0),
    now: () => 1,
    ...overrides,
  };
}

test('Work application enqueues, registers and retires against fake ports', async () => {
  const application = createWorkApplication(fakePorts());
  const tx = { query: async () => ({ rows: [], rowCount: 0 }) };
  await application.enqueue({}, tx, intent, (created) => expect(created).toBe(true));
  expect(await application.hasRetainedCopies(tx, intent.workflowId)).toBe(false);
  const runtime = await application.compose(
    [
      {
        name: 'probe',
        register(context) {
          expect(context.getAuthorization()).toEqual({ access: {}, readConsent: {} });
          expect(context.queues.maintenance.workerConcurrency).toBe(2);
        },
      },
    ],
    { databaseUrl: 'postgres://work', pool: {}, client: {} },
  );
  await runtime.launch();
  await runtime.shutdown();
  expect(await application.retireWriters(intent.workflowId)).toEqual(fence);
  expect(await application.readRetirement(intent.workflowId)).toEqual(fence);
  expect(await application.lockWriterState(tx, writer, {})).toEqual(writer);
});

test('Work compose refuses a duplicate module without native SDK', async () => {
  const application = createWorkApplication(fakePorts());
  const duplicate = { name: 'dup', register() {} };
  await expect(
    application.compose([duplicate, duplicate], { databaseUrl: 'postgres://work', pool: {}, client: {} }),
  ).rejects.toBeInstanceOf(WorkCompositionError);
});

test('bindWorkApplication exposes the fake application to Work facades', () => {
  const application = createWorkApplication(fakePorts());
  bindWorkApplication(application);
  expect(tryWorkApplication()).toBe(application);
  unbindWorkApplication();
  expect(tryWorkApplication()).toBeUndefined();
});

test('Work application registers selected admission against fake ports', () => {
  let registered = false;
  const application = createWorkApplication(
    fakePorts({
      sdkSelected: {
        registerSelectedStep(_body, config) {
          registered = true;
          expect(config.name).toBe('library.membersPreparation.step');
          return async () => undefined as never;
        },
        getSelectedExecution() {
          return {};
        },
        selectedExecutionIdentity() {
          throw new Error('selected SDK unused');
        },
        async consumeSelectedExecutionAdmission() {
          return true;
        },
        async checkSelectedExecutionInTransaction() {},
        isSelectedClient() {
          return true;
        },
      },
    }),
  );
  application.composeSelectedRuntime({}, {}).registerMembersStep(async () => 'ok');
  expect(registered).toBe(true);
});

test('ordinary composition installs native Work ports', async () => {
  unbindWorkApplication();
  try {
    const { composeWorkApplication } = await import('../../src/composition/work.ts');
    const application = composeWorkApplication();
    expect(tryWorkApplication()).toBe(application);
    expect(typeof application.ports.now()).toBe('number');
    expect(application.ports.clock()).toBeInstanceOf(Date);
    expect(application.ports.route.partitionOf(0)).toBe(0);
    expect(typeof application.ports.sdkEnqueue.enqueueInTransaction).toBe('function');
  } finally {
    unbindWorkApplication();
  }
});
