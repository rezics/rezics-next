import { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, EMPTY_ACCESS_WORK_DIMENSIONS, ORIGINAL_WORK_AXES, type AccessWork, type AccessWorkDimensions } from '../contract/bounds.ts';
export { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, EMPTY_ACCESS_WORK_DIMENSIONS, ORIGINAL_WORK_AXES };
export type { AccessWork, AccessWorkDimensions };
export declare function addAccessWork(...values: readonly AccessWork[]): AccessWork;
export declare function accessWorkFromDimensions(work: AccessWorkDimensions): AccessWork;
export declare function dimensionsFromAccessWork(work: AccessWork): AccessWorkDimensions;
