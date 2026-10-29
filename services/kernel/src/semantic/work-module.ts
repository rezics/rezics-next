import { startRelays } from '../events/relays.ts';
import type { WorkModule } from '../work/registry.ts';
import { stepIdentityEpochBootstrapWork, identityBootstrapWake } from './identity-epoch-bootstrap.ts';
import { IDENTITY_EPOCH_BOOTSTRAP, SUBJECT_MERGED, SUBJECT_REVISED, LINKS_MOVING } from './events.ts';
import { runCommand } from '../command/command.ts';
import { linkProjection } from './links.ts';

/** Native relation projection shares the worker pool and registered service lifecycle. */
export const semanticWorkModule: WorkModule = {
  name: 'semantic',
  register(context) {
    context.addEffects([{
      name: 'identity_epoch_bootstrap',
      types: [IDENTITY_EPOCH_BOOTSTRAP, SUBJECT_MERGED, SUBJECT_REVISED, LINKS_MOVING, 'com.rezics.subject.created.v1'],
      run: async () => { await stepIdentityEpochBootstrapWork(context.pool); },
    }]);
    context.addService(async () => {
      await runCommand(context.pool, {partition:0}, async () => ({value:null,events:[identityBootstrapWake(0,1n)]}));
      return {stop:async()=>{}};
    });
    context.addService(() => startRelays(context.pool, [linkProjection(context.pool)]));
  },
};
