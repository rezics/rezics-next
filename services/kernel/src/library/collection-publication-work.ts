import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import { HistorySealedError } from '../history/contract/index.ts';
import { receiveHistoryWork } from '../work/history-enqueue.ts';
import { COLLECTION_PUBLICATION_REQUESTED, LIBRARY_EVENTS } from './events.ts';
import { publicOutputAdvanceWork } from '../semantic/identity-public-output-work.ts';
import { withCollectionReadSnapshot } from './collection-read-connection.ts';
import { collectionPublicationOutputProducer } from './collection-publication-output.ts';
import {
  advanceCollectionPublicationEpisodePhase,
  readCollectionPublicationEpisode,
  readCollectionPublicationEpisodeVersion,
} from './collection-publication-episodes.ts';
import { COLLECTION_PUBLICATION_WORKFLOW } from './contract/index.ts';
import { enqueueIntent, runOperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem-error.ts';
import { readMembershipWorkConfig } from './access-port.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { advanceCollectionSourceWork } from './collection-source-work.ts';
import { stageCollectionPublicationStep } from './collection-publication-staging.ts';
import { createCollectionPublicationFinalActivation } from './collection-publication-final.ts';
import {
  COLLECTION_PUBLICATION_STEP_CEILING,
  collectionPublicationWorkDimensions,
} from './collection-publication-bounds.ts';
import {
  admitCollectionPublicationSourcePreparation,
  type CollectionPublicationLocator,
} from './collection-publication-work-admission.ts';
import { workStepDeadline } from './collection-command-work.ts';
import { collectionPublicationScopeRuntime } from '../search/work.ts';
import type { WorkContext } from '../work/registry.ts';

type WorkflowInput = Readonly<CollectionPublicationLocator & { accounts: readonly [string] }>;
type Context = Pick<WorkContext, 'pool' | 'client' | 'clock' | 'env' | 'getAuthorization'>;
function unavailable(): ProblemError {
  return new ProblemError('dependency_unavailable');
}

/** One fixed root covers repeated native admissions, evaluation and the exhaustive seal. */
export function collectionPublicationStepAllowance(reservationId: string) {
  return {
    reservationId,
    remaining: collectionPublicationWorkDimensions(COLLECTION_PUBLICATION_STEP_CEILING()),
  };
}

function validate(input: WorkflowInput): CollectionPublicationLocator {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).length !== 5 ||
    !Array.isArray(input.accounts) ||
    input.accounts.length !== 1 ||
    typeof input.accounts[0] !== 'string' ||
    routeOf(input.accounts[0]) === null ||
    routeOf(input.collectionId) !== routeOf(input.accounts[0]) ||
    routeOf(input.ownerAccountId) !== routeOf(input.accounts[0]) ||
    routeOf(input.publicationId) !== routeOf(input.accounts[0]) ||
    input.route !== routeOf(input.collectionId) ||
    input.accounts[0] !== input.ownerAccountId ||
    Buffer.byteLength(JSON.stringify(input)) > 4096
  )
    throw new TypeError('Invalid whole-query Collection publication locator');
  return {
    route: input.route,
    ownerAccountId: input.ownerAccountId,
    collectionId: input.collectionId,
    publicationId: input.publicationId,
  };
}

function intent(locator: CollectionPublicationLocator, workflowId: string) {
  return {
    queue: 'workflows' as const,
    workflowName: COLLECTION_PUBLICATION_WORKFLOW,
    workflowId,
    input: { accounts: [locator.ownerAccountId], ...locator },
  };
}

/** Reuse the installed canonical producer only after verifying this episode's original native binding. */
export async function prepareCollectionPublicationSource(
  context: WorkContext,
  input: WorkflowInput,
): Promise<'more' | 'ready' | 'done'> {
  const locator = validate(input);
  const proceed = await runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: COLLECTION_PUBLICATION_WORKFLOW,
      accounts: [locator.ownerAccountId],
      workClient: context.client,
      deadline: workStepDeadline(),
      clock: context.clock,
    },
    async (tx) => {
      const episode = await readCollectionPublicationEpisode(tx, locator);
      if (!episode) throw unavailable();
      if (episode.phase === 'complete' || episode.phase === 'refused') return false;
      if (!(await admitCollectionPublicationSourcePreparation(tx, locator))) throw unavailable();
      return true;
    },
  );
  if (!proceed) return 'done';
  const state = await advanceCollectionSourceWork(context, {
    accounts: [locator.ownerAccountId],
    collectionId: locator.collectionId,
  });
  if (state === 'unavailable') throw unavailable();
  return state;
}

async function stage(context: Context, input: WorkflowInput): Promise<'more' | 'sealed' | 'done'> {
  const locator = validate(input);
  const runtime = collectionPublicationScopeRuntime(context);
  if (!runtime || runtime.pool !== context.pool) throw unavailable();
  const { access } = context.getAuthorization();
  const routeKey = readMembershipWorkConfig(context.env).routeKey;
  const deadline = workStepDeadline();
  return runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: COLLECTION_PUBLICATION_WORKFLOW,
      accounts: [locator.ownerAccountId],
      workClient: context.client,
      deadline,
      clock: context.clock,
    },
    async (tx) => {
      const episode = await readCollectionPublicationEpisode(tx, locator);
      if (!episode || episode.phase === 'refused' || episode.phase === 'complete') return 'done';
      const version = await readCollectionPublicationEpisodeVersion(tx, locator);
      if (version === null) throw unavailable();
      const allowance = collectionPublicationStepAllowance(`${locator.publicationId}:${version}`);
      const result = await stageCollectionPublicationStep(tx, locator, {
        ...runtime,
        clock: context.clock,
        allowance,
        evidence: {
          access,
          routeKey,
          deadline,
          work: { kind: 'collection-publication', tx, locator },
        },
      });
      if (result.state === 'sealed' && episode.phase === 'staging') {
        if (
          !(await advanceCollectionPublicationEpisodePhase(
            tx,
            locator,
            { version, phase: 'staging' },
            'awaiting_activation',
          ))
        )
          throw unavailable();
      }
      if (result.state === 'more') {
        await enqueueIntent(tx, intent(locator, `${locator.publicationId}:${result.checkpoint.version}`));
        return 'more';
      }
      return 'sealed';
    },
  );
}

async function activate(context: Context, input: WorkflowInput): Promise<void> {
  const locator = validate(input);
  await createCollectionPublicationFinalActivation({ workContext: context }).activate(locator, locator.publicationId);
}

/** This work starts only after the same native episode selects its COMPLETE output. */
async function captureSelectedOutput(context: Context, input: WorkflowInput): Promise<'more' | 'done'> {
  const locator = validate(input);
  const deadline = workStepDeadline();
  const episode = await withCollectionReadSnapshot(context.pool, deadline, (tx) =>
    readCollectionPublicationEpisode(tx, locator),
  );
  if (episode?.phase !== 'complete' || episode.source.rule.kind !== 'builtin') return 'done';
  const producer = collectionPublicationOutputProducer(context);
  const { transactionId, position, sourceGeneration } = episode.output.publication;
  const result = await producer.advancePublication(
    { ...episode.output.ref, activation: { transactionId, position, sourceGeneration } },
    episode.source.rule.releaseDigest,
    {
      deadline,
      allowance: { reservationId: episode.output.ref.generation, remaining: publicOutputAdvanceWork() },
    },
  );
  if (result.status === 'more') return 'more';
  if (result.status === 'sealed') return 'done';
  throw new ProblemError('dependency_unavailable', {
    detail: 'The selected Collection output is awaiting identity coverage.',
  });
}

/** Register the locator-only continuation on the Library module's existing workflows queue. */
export function registerCollectionPublicationWork(context: WorkContext): void {
  context.addEffects([
    {
      name: 'library_collection_publication_receive',
      types: [COLLECTION_PUBLICATION_REQUESTED],
      async run(event) {
        if (!Value.Check(LIBRARY_EVENTS[COLLECTION_PUBLICATION_REQUESTED], event.data))
          throw new TypeError('Invalid Collection publication request event');
        const { collectionId, publicationId } = event.data;
        const route = routeOf(collectionId);
        if (route === null || routeOf(publicationId) !== route || event.subject !== collectionId)
          throw new TypeError('Invalid Collection publication request address');
        const partition = partitionOf(route);
        if (!event.source.startsWith(`urn:rezics:log:${partition}.`))
          throw new TypeError('Collection publication request has a foreign source partition');
        try {
          await receiveHistoryWork(context.pool, context.client, partition, publicationId);
        } catch (error) {
          // A terminal History seal fences new SDK copies. Erasure retains ownership of the staged origin.
          if (!(error instanceof HistorySealedError)) throw error;
        }
      },
    },
  ]);

  const prepare = DBOS.registerStep((input: WorkflowInput) => prepareCollectionPublicationSource(context, input), {
    name: 'library.collectionPublicationPrepare',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  const continuePreparation = DBOS.registerStep(
    async (input: WorkflowInput, sequence: number) => {
      const locator = validate(input);
      await context.client.enqueue(
        {
          queueName: 'workflows',
          workflowName: COLLECTION_PUBLICATION_WORKFLOW,
          workflowID: `${locator.publicationId}:prepare:${sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    {
      name: 'library.collectionPublicationContinuePreparation',
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: 1,
    },
  );
  const step = DBOS.registerStep(async (input: WorkflowInput) => stage(context, input), {
    name: 'library.collectionPublicationStage',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  const activateStep = DBOS.registerStep(async (input: WorkflowInput) => activate(context, input), {
    name: 'library.collectionPublicationActivate',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  const capture = DBOS.registerStep((input: WorkflowInput) => captureSelectedOutput(context, input), {
    name: 'library.collectionPublicationCaptureOutput',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  const continueCapture = DBOS.registerStep(
    async (input: WorkflowInput, segment: number, recoveryRoot?: string) => {
      const locator = validate(input);
      const root = recoveryRoot ?? locator.publicationId;
      if (root !== locator.publicationId && !root.startsWith(`${locator.publicationId}:recovery:`))
        throw new TypeError('Invalid Collection output continuation');
      await context.client.enqueue(
        {
          queueName: 'workflows',
          workflowName: COLLECTION_PUBLICATION_WORKFLOW,
          workflowID: `${root}:output:${segment}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
        segment,
      );
    },
    {
      name: 'library.collectionPublicationContinueOutputCapture',
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: 1,
    },
  );
  DBOS.registerWorkflow(
    async (input: WorkflowInput, outputSegment?: number) => {
      if (outputSegment === undefined) {
        let preparation: 'more' | 'ready' | 'done' = 'more';
        for (let n = 0; n < 100 && preparation === 'more'; n++) preparation = await prepare(input);
        if (preparation === 'more') {
          const sequence = Number(DBOS.workflowID!.split(':prepare:')[1] ?? 0) + 1;
          await continuePreparation(input, sequence);
          return;
        }
        if (preparation === 'ready') {
          const result = await step(input);
          if (result === 'more') return;
          if (result === 'sealed') await activateStep(input);
        }
      }
      for (let page = 0; page < 100; page++) {
        if ((await capture(input)) === 'done') return;
      }
      const root = outputSegment === undefined ? undefined : DBOS.workflowID!.split(':output:')[0];
      await continueCapture(input, (outputSegment ?? 0) + 1, root);
    },
    { name: COLLECTION_PUBLICATION_WORKFLOW },
  );
}
