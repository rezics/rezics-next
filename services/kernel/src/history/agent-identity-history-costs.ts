import { IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK, unpricedIdentityHistoryWork } from './agent-identity-inventory-work.ts';

// Native check: m(1), partition/domain(2), work(1), bounded roles(65), aggregate(1),
// barrier(1), original Source wrapper/function(17), SDK current lock(4). Each physical role
// is charged as a visible key. The outer SELECT/write is charged separately.
export const AGENT_IDENTITY_HISTORY_GUARD_COST = unpricedIdentityHistoryWork(
  'source-native-history-guard',
  Object.freeze({
    rows: 92,
    points: 87,
    statements: 11,
    bytes: 40960,
    engineRequests: 0,
  }),
);
export const AGENT_IDENTITY_HISTORY_ABSENCE_COST = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeAbsence;
