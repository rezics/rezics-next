import { DBOS } from '@dbos-inc/dbos-sdk';

/** Native SDK registration is reached only when the work host registers the declaration. */
export const nativeRatingWorkflows = {
  registerStep: DBOS.registerStep.bind(DBOS) as typeof DBOS.registerStep,
  registerWorkflow: DBOS.registerWorkflow.bind(DBOS) as typeof DBOS.registerWorkflow,
};
