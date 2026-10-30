import { useMemo } from 'react';
import { RealmClaimControls } from '../../../community/realm-claim-controls';
import type {
  RealmClaimAdapter,
  RealmClaimRead,
  RealmClaimReceipt,
  RealmClaimSnapshot,
} from '../../../community/realm-claim';
import realm from '../../../kernel/recorded/realm.json';

// Explicit transport fixtures augment the existing Realm recording with the continuity contract.
// They are not recordings of native approval and never run in the production composition.
export const orphan: RealmClaimSnapshot = {
  realmId: realm.realm.realmId,
  spaceId: realm.realm.spaceId,
  contextId: realm.realm.contextId,
  headRevisionId: realm.realm.headRevisionId,
  ownershipState: 'orphaned',
  governanceReadOnly: true,
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
};
export const eligible: RealmClaimRead = { kind: 'ready', snapshot: orphan, admission: 'allowed' };
export const receipt: RealmClaimReceipt = {
  realmId: orphan.realmId,
  requestId: '01a1a000-0000-7000-8000-000000000099',
  state: 'pending',
  orphanedAt: orphan.orphanedAt!,
  claimEligibleAt: orphan.claimEligibleAt!,
  requestedAt: '2026-10-31T10:00:00.000Z',
};
export function claimExampleAdapter(scenario: 'journey' | 'uncertain' | 'refused' = 'journey'): RealmClaimAdapter {
  let requested = false;
  let firstKey: string | null = null;
  return {
    read: async () =>
      scenario === 'journey' && requested
        ? {
            kind: 'ready',
            admission: 'allowed',
            snapshot: {
              ...orphan,
              ownershipState: 'owned',
              governanceReadOnly: false,
              orphanedAt: null,
              claimEligibleAt: null,
            },
          }
        : eligible,
    request: async (input) => {
      if (scenario === 'refused') return { kind: 'denied' };
      if (scenario === 'uncertain' && !firstKey) {
        firstKey = input.idempotencyKey;
        return { kind: 'unavailable' };
      }
      if (firstKey && firstKey !== input.idempotencyKey) throw new Error('The request key changed during retry');
      requested = true;
      return { kind: 'pending', request: receipt };
    },
  };
}
export function RealmClaimExample({ scenario = 'journey' }: { scenario?: 'journey' | 'uncertain' | 'refused' }) {
  const adapter = useMemo(() => claimExampleAdapter(scenario), [scenario]);
  return (
    <RealmClaimControls
      realmId={orphan.realmId}
      initial={eligible}
      adapter={adapter}
      returnTo="/spaces/quiet-novel-club"
    />
  );
}
