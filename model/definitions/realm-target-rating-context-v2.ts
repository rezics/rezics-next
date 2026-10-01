import type { ProfileDefinition } from '../compiler/ir.ts';
import { realmTargetRatingContextProfile } from './realm-target-rating-context-v1.ts';

/** The additional type selects the language-aware shape and binding without
 * rewriting v1's accepted canonical routing or historical Contexts. */
export const realmTargetRatingContextV2Profile = {
  ...realmTargetRatingContextProfile,
  id: 'realm-target-rating-context-v2',
  comments: ['An exact-target Realm question carrying its declared language.'],
  shapes: realmTargetRatingContextProfile.shapes.map(shape => ({
    ...shape, iri: shape.iri.replace('-v1/', '-v2/'),
    ...(shape.iri.endsWith('/context-shape') ? {
      canonical: { types: ['rv:LanguageTaggedTargetRatingContext'] as const },
      properties: [...shape.properties.map(property => {
        if (property.path !== 'rv:question') return property;
        const { languageIn: _languageIn, ...question } = property;
        return question;
      }), { path: 'rdf:type' as const, hasValue: 'rv:LanguageTaggedTargetRatingContext' as const }],
    } : {}),
  })),
  binding: { required: ['realm', 'context', 'question', 'language', 'grain'], roles: ['realm', 'context'],
    demandedBy: ['rv:LanguageTaggedTargetRatingContext'] },
} satisfies ProfileDefinition;
