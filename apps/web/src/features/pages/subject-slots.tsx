import { createContext, useContext, useSyncExternalStore, type ComponentType } from 'react';
import { useFeatureSlots } from '../../shell/feature-slots';
import { useSession } from '../../session/query';

/** Only fields from the successful public subject read; no Library state or private commerce DTO. */
export type SubjectPurchaseContext = Readonly<{ subjectId: string; subjectType: string; locale: string }>;
export type SubjectPurchaseRegions = Readonly<{
  publicRegion?: ComponentType<SubjectPurchaseContext>;
  /** Mounted only after hydration and signed-in session preparation; the owner prepares its own native reads. */
  privateRegion?: ComponentType<SubjectPurchaseContext>;
}>;
const PurchaseContext = createContext<SubjectPurchaseContext | null>(null);
export function useSubjectPurchaseContext(): SubjectPurchaseContext | null {
  return useContext(PurchaseContext);
}

const subscribe = () => () => {};
function PreparedPurchaseRegion({
  region: Region,
  context,
}: {
  region: ComponentType<SubjectPurchaseContext>;
  context: SubjectPurchaseContext;
}) {
  const { state } = useSession();
  return state === 'signed-in' ? <Region {...context} /> : null;
}

/** One optional purchase/benefit entry, at the end of the subject header. Empty until an owner supplies it. */
export function SubjectPurchaseSlot({ context }: { context: SubjectPurchaseContext }) {
  const { subjectPurchase } = useFeatureSlots();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (!subjectPurchase) return null;
  const { publicRegion: PublicRegion, privateRegion } = subjectPurchase;
  if (!PublicRegion && !privateRegion) return null;
  const publicContext = Object.freeze({
    subjectId: context.subjectId,
    subjectType: context.subjectType,
    locale: context.locale,
  });
  return (
    <PurchaseContext.Provider value={publicContext}>
      <div data-slot="subject-purchase" className="min-w-0">
        {PublicRegion && <PublicRegion {...publicContext} />}
        {hydrated && privateRegion && <PreparedPurchaseRegion region={privateRegion} context={publicContext} />}
      </div>
    </PurchaseContext.Provider>
  );
}
