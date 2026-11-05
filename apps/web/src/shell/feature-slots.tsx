import { createContext, useContext, type ReactNode } from 'react';
import type { SubjectPurchaseRegions } from '../features/pages/subject-slots';

const FeatureSlotsContext = createContext<Readonly<{ subjectPurchase?: SubjectPurchaseRegions }>>({});

/** Static owner components only. Private data belongs in the owner's prepared component, never this config. */
export function FeatureSlotsProvider({
  subjectPurchase,
  children,
}: {
  subjectPurchase?: SubjectPurchaseRegions;
  children: ReactNode;
}) {
  return (
    <FeatureSlotsContext.Provider value={{ ...(subjectPurchase ? { subjectPurchase } : {}) }}>
      {children}
    </FeatureSlotsContext.Provider>
  );
}

export function useFeatureSlots() {
  return useContext(FeatureSlotsContext);
}
