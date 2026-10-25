// SPDX-License-Identifier: Apache-2.0
export type {
  CompositionComponent,
  CompositionDocument,
  CompositionNode,
  CompositionRegistry,
  CompositionViolation,
  CompositionViolationCode,
} from './registry.ts';
export {
  APPEARANCE,
  MAX_COMPOSITION_BYTES,
  MAX_COMPOSITION_DEPTH,
  MAX_COMPOSITION_NODES,
  SLOT_NAMES,
  defineRegistry,
  platformRegistry,
} from './registry.ts';
export { curie, href, plainText } from './strings.ts';
export { compositionSchema } from './schema.ts';
export { validateComposition } from './validate.ts';
