import { createContext, useContext, useSyncExternalStore, type ComponentType } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useFeatureSlots } from '../../shell/feature-slots';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import { CharacterRelationshipsEntry } from '../catalogue/character-relationships/entry';
import { CharacterRelationshipsGroups } from './character-relationships';
import type { CharacterRelationshipsRead } from '../catalogue/character-relationships/reading';

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

/** Additive Organization companion; no extra subject fetch and no View-enum widening. */
export function OrganizationHistorySlot({
  subjectId,
  subjectType,
  label,
  locale,
}: {
  subjectId: string;
  subjectType: string;
  label: string;
  locale: string;
}) {
  if (subjectType !== 'schema:Organization') return null;
  const entry = catalogueEntries.producerHistory({ id: subjectId, label, locale });
  const o = { locale: locale as never };
  return (
    <section data-slot="organization-history" className="min-w-0 space-y-2">
      <p className="text-sm font-medium">{m.producer_history_title({}, o)}</p>
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
        {entry.label}
      </a>
    </section>
  );
}

const characterType = 'wd:Q95074';

export type CharacterRelationshipsSlotContext = Readonly<{
  subjectId: string;
  subjectType: string;
  locale: string;
  label: string;
  reading?: Extract<CharacterRelationshipsRead, { ok: true }>;
}>;

/** Discoverable Character appearance/relationship entry; optional grouped reading when the owner already loaded it. */
export function CharacterRelationshipsSlot({ context }: { context: CharacterRelationshipsSlotContext }) {
  if (context.subjectType !== characterType) return null;
  return (
    <div data-slot="character-relationships-entry" className="min-w-0 space-y-3">
      <CharacterRelationshipsEntry id={context.subjectId} label={context.label} locale={context.locale} />
      {context.reading && (
        <CharacterRelationshipsGroups
          id={context.subjectId}
          locale={context.locale}
          read={context.reading}
          streamId={`${context.subjectId}-appearances`}
        />
      )}
    </div>
  );
}
