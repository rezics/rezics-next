import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import { cataloguePin } from './definition-catalogue.ts';
import { runCatalogueBuildStep, runCatalogueActivationStep } from './definition-catalogue-publication.ts';
import { CATALOGUE_BUILD_REQUESTED, CATALOGUE_ACTIVATION_REQUESTED } from './events.ts';

/** Registers in the existing semantic Work module. Immutable committed input authorizes only index construction. */
export function registerDefinitionCatalogueWork(context: WorkContext) {
  const workflowName = 'semantic.definitionCatalogue';
  const step = DBOS.registerStep(
    (rootDigest: string) => runCatalogueBuildStep(context.pool, cataloguePin(rootDigest), context.clock),
    {
      name: `${workflowName}.step`,
      // A failed original dispatch stays spent; DBOS may not start a fresh allowance.
      retriesAllowed: false,
    },
  );
  DBOS.registerWorkflow(
    async ({ rootDigest }: { rootDigest: string }) => {
      while (true) {
        const progress = await step(rootDigest);
        if (progress.state === 'ready' || progress.state === 'refused') return progress;
        // Missing bytes are retained input, never successful empty closure. No connection is held during sleep.
        if (progress.state === 'incomplete') await DBOS.sleep(30_000);
      }
    },
    { name: workflowName },
  );
  const activationName = 'semantic.definitionCatalogueActivation';
  const activationStep = DBOS.registerStep(
    (rootDigest: string, activationId: string) =>
      runCatalogueActivationStep(context.pool, cataloguePin(rootDigest), activationId, context.clock),
    { name: `${activationName}.step`, retriesAllowed: false },
  );
  DBOS.registerWorkflow(
    async ({ rootDigest, activationId }: { rootDigest: string; activationId: string }) =>
      activationStep(rootDigest, activationId),
    { name: activationName },
  );
  // A wakeup selects an existing intent. It never grants another attempt or
  // retries an unresolved dispatch; fresh final authorization stays in HTTP.
  context.addEffects([
    {
      name: 'definition_catalogue_activation',
      types: [CATALOGUE_ACTIVATION_REQUESTED],
      async run(event) {
        const { rootDigest, activationId } = event.data as { rootDigest: string; activationId: string };
        cataloguePin(rootDigest);
        await context.client.enqueue(
          {
            queueName: 'maintenance', workflowName: activationName,
            workflowID: `semantic:catalogue:activation:${activationId}`,
            workflowIDReusePolicy: 'return-existing', queuePartitionKey: 'semantic:catalogue:0',
          },
          { rootDigest, activationId },
        );
      },
    },
    {
      name: 'definition_catalogue_build',
      types: [CATALOGUE_BUILD_REQUESTED],
      async run(event) {
        const { rootDigest } = event.data as { rootDigest: string };
        cataloguePin(rootDigest);
        await context.client.enqueue(
          {
            queueName: 'maintenance',
            workflowName,
            workflowID: `semantic:catalogue:${rootDigest}`,
            workflowIDReusePolicy: 'return-existing',
            queuePartitionKey: 'semantic:catalogue:0',
          },
          { rootDigest },
        );
      },
    },
  ]);
}
