import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  advanceCollectionPublicationEpisodePhase,
  COLLECTION_PUBLICATION_WORKFLOW,
  readCollectionPublicationEpisode,
  readCollectionPublicationEpisodeVersion,
} from './collection-publication-episodes.ts';
import { enqueueIntent, runOperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { stageCollectionPublicationStep } from './collection-publication-staging.ts';
import { createCollectionPublicationFinalActivation } from './collection-publication-final.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import { workStepDeadline } from './command-support.ts';
import { scopeAllowance } from '../search/scope-execution.ts';
import { collectionPublicationScopeRuntime } from '../search/work.ts';
import type { WorkContext } from '../work/registry.ts';

type WorkflowInput = Readonly<CollectionPublicationLocator & { accounts: readonly [string] }>;
type Context = Pick<WorkContext, 'pool' | 'client' | 'clock' | 'env' | 'getAuthorization'>;
function unavailable(): ProblemError {
  return new ProblemError('dependency_unavailable');
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

async function stage(context: Context, input: WorkflowInput): Promise<'more' | 'sealed' | 'done'> {
  const locator = validate(input);
  const runtime = collectionPublicationScopeRuntime(context as WorkContext);
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
      const allowance = scopeAllowance(100, `${locator.publicationId}:${version}`);
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

/** Register the locator-only continuation on the Library module's existing workflows queue. */
export function registerCollectionPublicationWork(context: WorkContext): void {
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
  DBOS.registerWorkflow(
    async (input: WorkflowInput) => {
      const result = await step(input);
      if (result === 'sealed') await activateStep(input);
    },
    { name: COLLECTION_PUBLICATION_WORKFLOW },
  );
}
