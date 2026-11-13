import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import { DurableInitiatorUnavailableError, GrantDeniedError } from '../access/contract/index.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import {
  hostedPublicationPreparationWorkflowId,
  HOSTED_PUBLICATION_PREPARATION_WORK_EVENT,
  HOSTED_PUBLICATION_PREPARATION_WORKFLOW,
  type HostedPublicationPreparationWorkInput,
} from './work-contract.ts';
import { CONTENT_EVENTS } from './events.ts';
import type { WorkContext } from '../work/registry.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import type { Access } from '../request/access.ts';
import { derivedId, routeOf } from '../route/route.ts';
import {
  advanceHostedPublicationPreparation,
  sealHostedPublicationPreparation,
  type HostedPublicationPreparationDependencies,
  type HostedPublicationPreparationProgress,
} from './hosted-publication-preparation.ts';
import {
  createHostedPublicationPreparationAuthority,
  readHostedPublicationPreparationActor,
  type HostedPublicationPreparationAuthority,
} from './hosted-publication-preparation-initiator.ts';
import { ContentNotFoundError, ContentForbiddenError, RevisionPreconditionError } from './commands.ts';
import {
  HostedPublicationStagingConflictError,
  HostedPublicationStagingExpiredError,
  HostedPublicationStagingNotFoundError,
} from './hosted-publication-staging-model.ts';

export type HostedPublicationPreparationWorkOptions = Readonly<{
  access: Access;
  readConsent: CurrentConsentReader;
  routeKey: Uint8Array;
  now: () => number;
}>;

function validate(input: HostedPublicationPreparationWorkInput): void {
  if (!Value.Check(CONTENT_EVENTS()[HOSTED_PUBLICATION_PREPARATION_WORK_EVENT], input))
    throw new TypeError('Invalid hosted publication preparation work input');
  const route = routeOf(input.catalogueId);
  if (
    route === null ||
    routeOf(input.stageId) !== route ||
    routeOf(input.stepId) !== route ||
    routeOf(input.commandKey) !== route
  )
    throw new TypeError('Hosted publication preparation work IDs must share their native route');
}

function terminal(error: unknown): boolean {
  return (
    error instanceof DurableInitiatorUnavailableError ||
    error instanceof GrantDeniedError ||
    error instanceof ContentNotFoundError ||
    error instanceof ContentForbiddenError ||
    error instanceof RevisionPreconditionError ||
    error instanceof HostedPublicationStagingConflictError ||
    error instanceof HostedPublicationStagingExpiredError ||
    error instanceof HostedPublicationStagingNotFoundError
  );
}

/** Execute one bounded server continuation; exposed so native acceptance tests
 * exercise the same page handler that DBOS resumes after a worker interruption. */
export async function executeHostedPublicationPreparationPage(
  input: HostedPublicationPreparationWorkInput,
  context: Pick<WorkContext, 'pool' | 'clock'>,
  options: HostedPublicationPreparationWorkOptions,
  authority: HostedPublicationPreparationAuthority,
): Promise<HostedPublicationPreparationProgress> {
  validate(input);
  const deadline = options.now() + 30_000;
  const actor = await readHostedPublicationPreparationActor({
    pool: context.pool,
    clock: context.clock,
    deadline,
    catalogueId: input.catalogueId,
    stageId: input.stageId,
  });
  const dependencies: HostedPublicationPreparationDependencies = {
    pool: context.pool,
    access: options.access,
    clock: context.clock,
    routeKey: options.routeKey,
  };
  const command = { idempotencyKey: input.commandKey, requestId: input.stepId, deadline };
  const advanced = await advanceHostedPublicationPreparation(
    dependencies,
    actor,
    input.catalogueId,
    input.stageId,
    input.stepId,
    command,
    authority,
  );
  const checkpoint = advanced.value;
  if (checkpoint.candidate?.coverageComplete && !checkpoint.candidate.sealed) {
    const route = routeOf(input.stageId);
    if (route === null) throw new TypeError('Invalid hosted publication preparation stage');
    const sealKey = derivedId(input.stageId, 'hosted-preparation-private-seal', route);
    return (
      await sealHostedPublicationPreparation(
        dependencies,
        actor,
        input.catalogueId,
        input.stageId,
        { idempotencyKey: sealKey, requestId: input.stepId, deadline: options.now() + 30_000 },
        authority,
      )
    ).value;
  }
  return checkpoint;
}

/** Register bounded, ID-only preparation continuations on the shared maintenance queue. */
export function registerHostedPublicationPreparationWork(
  context: WorkContext,
  options: HostedPublicationPreparationWorkOptions,
): void {
  const authority = createHostedPublicationPreparationAuthority({
    pool: context.pool,
    access: options.access,
    readConsent: options.readConsent,
  });
  const page = DBOS.registerStep(
    async (input: HostedPublicationPreparationWorkInput): Promise<HostedPublicationPreparationProgress> => {
      return executeHostedPublicationPreparationPage(input, context, options, authority);
    },
    {
      name: 'content.hostedPublicationPreparation.page',
      retriesAllowed: true,
      intervalSeconds: 1,
      backoffRate: 2,
      maxAttempts: 11,
      shouldRetry: (error) => !terminal(error),
    },
  );
  DBOS.registerWorkflow(async (input: HostedPublicationPreparationWorkInput) => page(input), {
    name: HOSTED_PUBLICATION_PREPARATION_WORKFLOW,
  });
  context.addEffects([
    {
      name: 'hosted_publication_preparation_work',
      types: [HOSTED_PUBLICATION_PREPARATION_WORK_EVENT],
      async run(event) {
        if (
          event.type !== HOSTED_PUBLICATION_PREPARATION_WORK_EVENT ||
          !Value.Check(CONTENT_EVENTS()[event.type], event.data)
        )
          throw new TypeError('Invalid hosted publication preparation work event');
        const input = event.data as HostedPublicationPreparationWorkInput;
        await context.client.enqueue(
          {
            applicationName: WORK_APPLICATION,
            workflowName: HOSTED_PUBLICATION_PREPARATION_WORKFLOW,
            workflowID: hostedPublicationPreparationWorkflowId(input),
            workflowIDReusePolicy: 'return-existing',
            queueName: 'maintenance',
          },
          input,
        );
      },
    },
  ]);
}
