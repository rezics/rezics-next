import type { ProfileDefinition } from '../compiler/ir.ts';
import { classificationContextProfile } from './classification-context-v1.ts';

/** Bootstrap has no Realm binding; the Realm profile requires all three roles. */
export const classificationGlobalContextProfile = {
  id: 'classification-global-context-v1',
  comments: ['System bootstrap of the fixed Global classification Context.'],
  prefixes: classificationContextProfile.prefixes,
  layout: 'compact',
  shapes: [{ ...classificationContextProfile.shapes[0],
    iri: 'https://rezics.com/definition/classification-global-context-v1/global-shape' }],
} as const satisfies ProfileDefinition;
