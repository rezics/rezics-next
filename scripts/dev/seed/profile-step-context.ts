import { grantHomeSeedAuthority } from './operator.ts';
import { profileSteps } from './profiles.ts';
import type { SeedState } from './state.ts';

/** The four ordered profile phases share the same resolved public Work ids. */
export function profileOperations(state: SeedState) {
  return profileSteps(state.api, state.sessions[0]!, state.sessions, state.penAgents,
    new Map([...state.created].map(([id, receipt]) => [id, receipt.work])), async work => {
      if (!state.operatorInput || !state.operatorSession) throw new Error('Profile credits require the seed operator');
      const receipt = [...state.created.values()].find(item => item.work === work);
      if (!receipt) throw new Error('Profile credit target is outside the seed');
      await grantHomeSeedAuthority({ ...state.operatorInput,
        ownerAccountSubject: state.operatorInput.accountSubject }, [
        { action: 'work.read', scope: `work:read:${receipt.work}` },
        { action: 'work.edit', scope: `work:edit:${receipt.work}` },
      ]);
      return { id: 'seed-operator', token: state.operatorSession.token, actingSubject: state.operatorInput.actingSubject };
    });
}
