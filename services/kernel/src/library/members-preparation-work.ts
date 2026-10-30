import { DBOS } from '@dbos-inc/dbos-sdk';
import { ProblemError } from '../http/problem.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import type { PreparationIntent, PreparationLocator } from './members-preparation.ts';

type Dependencies = Pick<WorkContext, 'pool' | 'client' | 'clock'>;

/** Provisional producer adapter. Replace with the authoritative members-preparation worker at integration.
 * Neither admission nor an unavailable Source can complete a workflow or acknowledge custody.
 */
export async function runMembersPreparationStep(
  _deps: Dependencies,
  _locator: PreparationLocator,
): Promise<'obsolete'> {
  throw new ProblemError('dependency_unavailable');
}

/** Exact producer registration boundary; default work fails explicitly until its body is integrated. */
export async function registerMembersPreparationWork(deps: Dependencies): Promise<void> {
  const prepare = DBOS.registerStep((locator: PreparationLocator) => runMembersPreparationStep(deps, locator), {
    name: 'library.membersPreparation.step',
    ...COMMAND_STEP_RETRIES,
  });
  DBOS.registerWorkflow(
    async (input: PreparationIntent['input']) => {
      if (Buffer.byteLength(JSON.stringify(input)) > 4096) throw new TypeError('Invalid members preparation intent');
      // Do not consume locators or report successful cleanup under this unavailable adapter.
      // Even an empty input must fail; no fake successful workflow/receipt is produced.
      if (!input.episodes.length) throw new ProblemError('dependency_unavailable');
      await prepare({ route: input.route, ownerAccountId: input.accounts[0], ...input.episodes[0]! });
      throw new ProblemError('dependency_unavailable');
    },
    { name: 'library.membersPreparation' },
  );
}
