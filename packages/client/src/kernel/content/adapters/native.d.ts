import type { ContentAmbient, ContentApplicationPorts } from '../contract/index.ts';
import { createNativeContentAmbient } from './ambient.ts';
/** Native Content ports. Composition roots bind these; applications never import this module. */
export declare function createNativeContentPorts(ambient?: ContentAmbient): ContentApplicationPorts;
export { createNativeContentAmbient };
