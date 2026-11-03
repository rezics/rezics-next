import { createContext, useContext, useSyncExternalStore, type ComponentType } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useFeatureSlots } from '../../shell/feature-slots';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import { CharacterRelationshipsEntry } from '../catalogue/character-relationships/entry';
import { CharacterRelationshipsGroups } from './character-relationships';
import type { CharacterRelationshipsRead } from '../catalogue/character-relationships/reading';
import { ClassificationAssessmentSection } from './subject-classification-assessment-view';
import type { ClassificationAssessmentHandlers } from './subject-classification-assessment-view';
import type { ClassificationAssessmentSession } from './subject-classification-assessment-controller';
import type { Statistic } from './subject-ratings';
import { subjectHref } from '../../subject/subject-href';

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

function CompanionLink({ href, label }: { href: string; label: string }) {
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
      {label}
    </a>
  );
}

/** Additive graph / quotation / concept / music-context companions; View enum stays unchanged. */
export function SubjectExploreSlot({
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
  const address = { id: subjectId, label, locale };
  const o = { locale: locale as never };
  const graph = catalogueEntries.graph(address);
  const quotations =
    subjectType === 'wd:Q95074' || subjectType === 'schema:Quotation' || subjectType.startsWith('schema:')
      ? catalogueEntries.quotations(address)
      : undefined;
  const concepts =
    subjectType === 'skos:Concept' || subjectType === 'skos:ConceptScheme'
      ? catalogueEntries.concepts(address)
      : undefined;
  const music =
    subjectType === 'schema:Place' ||
    subjectType === 'schema:Event' ||
    subjectType === 'schema:MusicVenue' ||
    subjectType === 'schema:MusicEvent' ||
    subjectType === 'schema:AdministrativeArea' ||
    subjectType === 'schema:MusicInstrument' ||
    subjectType === 'wd:Q34379'
      ? catalogueEntries.musicContext(address)
      : undefined;
  return (
    <section data-slot="subject-explore" className="flex min-w-0 flex-wrap gap-2">
      <p className="w-full text-sm font-medium">{m.graph_explore_title({}, o)}</p>
      <CompanionLink href={graph.href} label={graph.label} />
      {quotations && <CompanionLink href={quotations.href} label={quotations.label} />}
      {concepts && <CompanionLink href={concepts.href} label={concepts.label} />}
      {music && <CompanionLink href={music.href} label={music.label} />}
    </section>
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

/** Additive edition/release companion; the Contribute menu still owns the same destination. */
export function ReleaseFidelitySlot({
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
  const entry = catalogueEntries.releaseFidelity({ id: subjectId, type: subjectType, label, locale });
  if (!entry) return null;
  return (
    <section data-slot="release-fidelity-entry" className="min-w-0 space-y-2">
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
        {entry.label}
      </a>
    </section>
  );
}

/** Additive catalogue file/group companion; hashes stay catalogue statements, not possession. */
export function CatalogueFileSlot({
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
  const entry = catalogueEntries.catalogueFile({ id: subjectId, type: subjectType, label, locale });
  if (!entry) return null;
  return (
    <section data-slot="catalogue-file-entry" className="min-w-0 space-y-2">
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

/** Ordinary Subject assessment of one disclosed Global classification association. */
export function ClassificationAssessmentSlot({
  subjectId,
  label,
  locale,
  returnTo,
  csrfToken,
  session,
  statistics,
  handlers,
}: {
  subjectId: string;
  label: string;
  locale: string;
  returnTo: string;
  csrfToken: string | null;
  session: ClassificationAssessmentSession;
  statistics?: Statistic[];
  handlers: ClassificationAssessmentHandlers;
}) {
  const sourcesHref = `${subjectHref({ id: subjectId, label }, locale).href}/sources`;
  return (
    <ClassificationAssessmentSection
      locale={locale}
      title={label}
      returnTo={returnTo}
      csrfToken={csrfToken}
      {...(statistics ? { statistics } : {})}
      sourcesHref={sourcesHref}
      session={session}
      handlers={handlers}
    />
  );
}
