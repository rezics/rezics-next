import { Elysia, problem } from 'elysia';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { operationPolicies } from '../src/routes/operation-policies.ts';
import { workScalarModels, workScalarOperation } from '../src/routes/work-scalar.contract.ts';
import { actingContextPreferenceModels, actingContextPreferenceOperation } from '../src/routes/acting-context-preference.contract.ts';
import { workHeaderModels, workHeaderOperation } from '../src/routes/work-header.contract.ts';

/** Uncalled: compilation must reject invalid implementations at the native binding. */
export function rejectedImplementations(work: MainWorkDependencies) {
  const app = new Elysia().use(operationPolicies(work)).model(workScalarModels)
    .model(actingContextPreferenceModels).model(workHeaderModels);
  // @ts-expect-error A success implementation must satisfy the declared Work header.
  app.get(workHeaderOperation.path, workHeaderOperation.options, () => ({ title: 7 }));
  // @ts-expect-error A success implementation must satisfy the declared preference result.
  app.put(actingContextPreferenceOperation.path, actingContextPreferenceOperation.options, () => ({ revision: 7 }));
  // @ts-expect-error A success implementation must satisfy the declared scalar result.
  app.post(workScalarOperation.path, workScalarOperation.options, () => ({ replayed: 'yes' }));
  // @ts-expect-error Status 409 admits only the literal codes in the domain schemas.
  app.post(workScalarOperation.path, workScalarOperation.options, () => problem(409, { code: 'wrong_code' }));
}
