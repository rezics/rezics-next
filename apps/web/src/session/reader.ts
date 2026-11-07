export { workspaceAdmission, useWorkspaceAdmission, type WorkspaceAdmission } from '../reader/workspace-admission';
export {
  assertReaderCurrent,
  useReaderAddress,
  useReaderCurrentOrigin,
  useReaderResponseOrigin,
  type ReaderOrigin,
} from '../reader/current-origin';

/** Ordinary readers consume the installed admission hooks, without another provider. */
export { useOperation, useOperationAdmission, type GatedOperation, type OperationAdmission } from '../kernel/exposure';
