import { type AdmitDocumentReadInput } from '../contract/index.ts';
export { deadlineElapsed } from './deadline.ts';
export declare function admitDocumentByteLimit(maxSourceBytes: number | undefined, maxBytes?: number): boolean;
export declare function admitDocumentRead(input: AdmitDocumentReadInput): boolean;
export declare function documentReadExhausted(now: number, deadline: number, found: unknown): boolean;
