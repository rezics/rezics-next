import { subjectHref } from '../../../subject/load-subject';

// Public composition entry. Parsing stays in a pure leaf shared with Subject return admission.
export {
  graphPublicIntentLimit,
  graphPublicIntentFits,
  graphPublicPath,
  graphPublicSourceReturnHref,
  graphPublicOriginHref,
  graphGlobalVisitHref,
  parseGraphPublicVisit,
  graphPublicVisitUnsupported,
  graphPublicVisitReturn,
  graphPublicVisitSearch,
} from './public-address';
export type { GraphPublicOrigin, GraphPublicVisit } from './public-address';

export function graphDirectHref(id: string, label: string, locale: string): string {
  return `${subjectHref({ id, label }, locale).href}/graph`;
}
