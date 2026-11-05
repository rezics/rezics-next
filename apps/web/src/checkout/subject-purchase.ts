import type { SubjectPurchaseRegions } from '../features/pages/subject-slots';
import { SubjectOffersRegion, SubjectOwnedBenefitsRegion } from './subject-offers-region';

export { SubjectOffersRegion, SubjectOwnedBenefitsRegion };
/** Additive root configuration; the shared subject renderer and Access remain their owners' surfaces. */
export const subjectPurchaseRegions = Object.freeze({
  publicRegion: SubjectOffersRegion,
  privateRegion: SubjectOwnedBenefitsRegion,
}) satisfies SubjectPurchaseRegions;
