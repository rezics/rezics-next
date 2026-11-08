import type { ContentAmbient } from '../contract/index.ts';
/** Native time, UUID, network and clock. Composition may override any operand. */
export declare function createNativeContentAmbient(overrides?: Partial<ContentAmbient>): ContentAmbient;
