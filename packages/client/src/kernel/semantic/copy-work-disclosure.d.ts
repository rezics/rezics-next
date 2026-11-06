import { type CopyWorkDisclosureDependencies, type CopyWorkDisclosureObservation, type CopyWorkDisclosureRequest } from './copy-work-disclosure-contract.ts';
export type { CopyWorkDisclosureDependencies, CopyWorkDisclosureObservation, CopyWorkDisclosureRequest, CopyWorkDisclosureState, CopyWorkReference, } from './copy-work-disclosure-contract.ts';
export { COPY_WORK_DISCLOSURE_LOOKAHEAD, COPY_WORK_DISCLOSURE_MAX_RAW, COPY_WORK_DISCLOSURE_MAX_WORKS, COPY_WORK_PROPERTY, } from './copy-work-disclosure-contract.ts';
/** One exported native batch: current admitted copy/release-to-work membership, never a guessed primary work. */
export declare function readCopyWorkDisclosure(deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest): Promise<CopyWorkDisclosureObservation>;
