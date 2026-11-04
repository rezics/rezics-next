import { authPost, type AuthPostResult } from './api';

export type OperatorTransferPageInput =
  | { kind: 'readiness' }
  | { kind: 'source'; subjectAccountId: string }
  | {
      kind: 'destination';
      request: {
        version: 1;
        previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
        expectedVersion: string;
        operatorAccountId: string;
        sourceOperationKey: string;
      };
    };
export type OperatorTransferPageResponse = {
  viewer:
    | { kind: 'ready' }
    | { kind: 'authentication-required'; continuation: 'operator-transfer' }
    | { kind: 'signed-out' }
    | { kind: 'refused' };
  review:
    | { kind: 'readiness' }
    | {
        kind: 'source';
        relation: {
          previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
          expectedVersion: string;
        };
        action: 'allowed';
      }
    | { kind: 'destination'; destinationAccountId: string; action: 'allowed' | 'denied' }
    | { kind: 'missing' | 'refused' | 'changed' | 'unavailable' };
};

export const OPERATOR_TRANSFER_PAGE_PATH = '/account-management/operators/transfer-review';
export function requestOperatorTransferPage(input: OperatorTransferPageInput): Promise<AuthPostResult> {
  return authPost<unknown>(OPERATOR_TRANSFER_PAGE_PATH, input);
}
