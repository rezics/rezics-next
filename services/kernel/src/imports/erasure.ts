import { acknowledgeErasure } from '../access/erasure.ts';
import type { WorkModule } from '../work/registry.ts';

export const importsWorkModule: WorkModule = {
  name: 'imports',
  register(context) {
    context.addEffects([
      {
        name: 'imports_erasure',
        types: ['com.rezics.access.account-tombstoned.v1'],
        run: async (event) => {
          if (
            event.type !== 'com.rezics.access.account-tombstoned.v1' ||
            !event.data ||
            typeof event.data !== 'object' ||
            !('accountId' in event.data) ||
            typeof event.data.accountId !== 'string'
          )
            throw new TypeError('Invalid account tombstone event for imports erasure');
          await acknowledgeErasure(
            { pool: context.pool },
            { accountId: event.data.accountId, participant: 'imports', outcome: 'none' },
          );
        },
      },
    ]);
  },
};
