import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import { cataloguePin } from './definition-catalogue.ts';
import { runCatalogueBuildStep } from './definition-catalogue-publication.ts';
import { CATALOGUE_BUILD_REQUESTED } from './events.ts';

/** Registers in the existing semantic Work module. Immutable committed input authorizes only index construction. */
export function registerDefinitionCatalogueWork(context: WorkContext) {
  const workflowName = 'semantic.definitionCatalogue';
  const step = DBOS.registerStep((rootDigest: string) => runCatalogueBuildStep(context.pool, cataloguePin(rootDigest), context.clock), {
    name: `${workflowName}.step`, retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1,
  });
  DBOS.registerWorkflow(async ({ rootDigest }: { rootDigest: string }) => {
    while (true) {
      const progress = await step(rootDigest);
      if (progress.state === 'ready' || progress.state === 'refused') return progress;
      // Missing bytes are retained input, never successful empty closure. No connection is held during sleep.
      if (progress.state === 'incomplete') await DBOS.sleep(30_000);
    }
  }, { name: workflowName });
  context.addEffects([{
    name: 'definition_catalogue_build', types: [CATALOGUE_BUILD_REQUESTED],
    async run(event) {
      const { rootDigest } = event.data as { rootDigest: string };
      cataloguePin(rootDigest);
      await context.client.enqueue({
        queueName: 'maintenance', workflowName, workflowID: `semantic:catalogue:${rootDigest}`,
        workflowIDReusePolicy: 'return-existing', queuePartitionKey: 'semantic:catalogue:0',
      }, { rootDigest });
    },
  }]);
}
