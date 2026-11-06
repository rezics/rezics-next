import {
  EMPTY_ACCESS_WORK_DIMENSIONS,
  IDENTITY_ORIGINAL_DEADLINE_MS,
  type AccessApplicationPorts,
  type AccessWorkDimensions,
  type AdmitOriginalWorkInput,
} from '../contract/index.ts';
import {
  ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
  HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
  admitOriginalWorkDeclaration,
  composeOriginalWorkAdmission,
  originalWorkVector,
} from '../core/index.ts';

export class OriginalWorkUnavailableError extends Error {
  constructor(readonly gap: string) {
    super(gap);
    this.name = 'OriginalWorkUnavailableError';
  }
}

export function createOriginalAdmission(ports: Pick<AccessApplicationPorts, 'originalWork'>) {
  return {
    deadlineMs: IDENTITY_ORIGINAL_DEADLINE_MS,
    localAllowance: HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
    async admit(
      input: AdmitOriginalWorkInput = { local: HISTORY_ORIGINAL_LOCAL_ALLOWANCE },
    ): Promise<AccessWorkDimensions> {
      originalWorkVector(input.local);
      const sourceDeclaration = await ports.originalWork.readHistoryOriginalSourceDeclaration();
      const libraryDeclaration = await ports.originalWork.readHistoryOriginalLibraryDeclaration();
      let source;
      let library;
      try {
        source = admitOriginalWorkDeclaration(sourceDeclaration);
        library = admitOriginalWorkDeclaration(libraryDeclaration);
      } catch {
        throw new OriginalWorkUnavailableError('identity-history-original-child-declaration-invalid');
      }
      return composeOriginalWorkAdmission(
        input.local,
        source,
        library,
        input.transfer ?? ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
      );
    },
    empty(): AccessWorkDimensions {
      return EMPTY_ACCESS_WORK_DIMENSIONS;
    },
  };
}
