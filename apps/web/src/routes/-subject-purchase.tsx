import type { SubjectPurchaseContext, SubjectPurchaseRegions } from '../features/pages/subject-slots';
import { SubjectOffersRegion, SubjectOwnedBenefitsRegion } from '../checkout/subject-purchase';
import { useSession } from '../session/query';

/** The existing slot uses the installed session producer; checkout receives only its current snapshot. */
export function CurrentSubjectOffersRegion(context: SubjectPurchaseContext) {
  const session = useSession();
  return <SubjectOffersRegion {...context} session={session} />;
}

function CurrentOwnedBenefitsRegion(context: SubjectPurchaseContext) {
  return <SubjectOwnedBenefitsRegion {...context} />;
}

export const subjectPurchaseRegions = Object.freeze({
  publicRegion: CurrentSubjectOffersRegion,
  privateRegion: CurrentOwnedBenefitsRegion,
}) satisfies SubjectPurchaseRegions;
