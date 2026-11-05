import {
  RENAME_APPROVAL_MAX_RESPONSE_BYTES,
  RENAME_EXECUTION_MAX_RESPONSE_BYTES,
  parseRenameApprovalResponse,
  parseRenameExecutionResponse,
  type RenameApprovalResponse,
  type RenameExecutionResponse,
} from '@rezics/auth-contract';
import { sendAccountOperation } from './account-operation-command';

export const sendRenameApproval = (body: unknown, dispatch: () => boolean, signal?: AbortSignal) =>
  sendAccountOperation<RenameApprovalResponse>(
    'approve',
    body,
    RENAME_APPROVAL_MAX_RESPONSE_BYTES,
    parseRenameApprovalResponse,
    dispatch,
    signal,
  );
export const sendRenameExecution = (body: unknown, dispatch: () => boolean, signal?: AbortSignal) =>
  sendAccountOperation<RenameExecutionResponse>(
    'execute',
    body,
    RENAME_EXECUTION_MAX_RESPONSE_BYTES,
    parseRenameExecutionResponse,
    dispatch,
    signal,
  );
