import { createContext, useContext, useId, useSyncExternalStore, type ComponentType } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useFeatureSlots } from '../../shell/feature-slots';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';
import { graphPublicSourceReturnHref } from './graph-browser/public-visit';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from './subject-visit-navigation';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import { CharacterRelationshipsEntry } from '../catalogue/character-relationships/entry';
import { CharacterRelationshipsGroups } from './character-relationships';
import type { CharacterRelationshipsRead } from '../catalogue/character-relationships/reading';
import { ClassificationAssessmentSection } from './subject-classification-assessment-view';
import { renderWorkTagReading } from './subject-page-application';
import type { WorkTagReadingProps } from './semantic-render-port';
import type { ClassificationAssessmentHandlers } from './subject-classification-assessment-view';
import type { ClassificationAssessmentSession } from './subject-classification-assessment-controller';
import type { Statistic } from './subject-ratings';

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

function CompanionLink({ href, label, describedBy }: { href: string; label: string; describedBy?: string }) {
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={href}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
    >
      {label}
    </a>
  );
}

function quotationOrigin(value: string, subjectId: string, locale: string, context?: string): string | null {
  if (value.length > 2048 || new TextEncoder().encode(value).byteLength > 2048) return null;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted || accepted.length > 2048 || new TextEncoder().encode(accepted).byteLength > 2048) return null;
  const url = new URL(accepted, 'https://rezics.invalid');
  const subjectPrefix = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subjectId)}/`;
  if (
    url.origin !== 'https://rezics.invalid' ||
    !url.pathname.startsWith(subjectPrefix) ||
    ['via', 'returnTo', 'quote', 'quotationReturn'].some((key) => url.searchParams.has(key))
  )
    return null;
  const originContexts = url.searchParams.getAll('context');
  const sameContext = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  if (
    (context === undefined && originContexts.length > 0) ||
    (context !== undefined &&
      !(sameContext(context, candidateContext) && originContexts.length === 0) &&
      (originContexts.length !== 1 || !sameContext(originContexts[0]!, context)))
  )
    return null;
  return accepted;
}

function quotationUnsupportedText(reason: 'realm' | 'context' | 'origin' | 'address', locale: string) {
  const o = { locale: locale as never };
  if (reason === 'realm') return m.quotation_entry_realm_unsupported({}, o);
  if (reason === 'context') return m.quotation_entry_context_unsupported({}, o);
  if (reason === 'origin') return m.quotation_entry_origin_unsupported({}, o);
  return m.quotation_entry_address_unsupported({}, o);
}

/** Additive graph / quotation / concept / music-context companions; View enum stays unchanged. */
export function SubjectExploreSlot({
  subjectId,
  subjectType,
  label,
  locale,
  context,
  realm,
  returnTo,
  publicReturnHref,
  musicReturnTo,
}: {
  subjectId: string;
  subjectType: string;
  label: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  returnTo?: string | undefined;
  publicReturnHref?: string | undefined;
  musicReturnTo?: string | undefined;
}) {
  const unsupportedId = useId();
  const address = { id: subjectId, label, locale };
  const o = { locale: locale as never };
  const observedContext = context ?? candidateContext;
  const graphReturn = graphPublicSourceReturnHref({
    path: subjectHref(address, locale).href,
    id: subjectId,
    locale,
    context: observedContext,
    ...(realm ? { realm } : {}),
  });
  const graph = catalogueEntries.graph({
    ...address,
    origin: {
      subject: subjectId,
      context: observedContext,
      locale,
      ...(realm ? { realm } : {}),
      returnHref: graphReturn ?? '',
    },
  });
  const quotations =
    subjectType === 'wd:Q95074' || subjectType === 'schema:Quotation' || subjectType.startsWith('schema:')
      ? catalogueEntries.quotations({
          ...address,
          context,
          realm,
          ...(returnTo === undefined ? {} : { returnTo: quotationOrigin(returnTo, subjectId, locale, context) }),
        })
      : undefined;
  const concepts =
    subjectType === 'skos:Concept' || subjectType === 'skos:ConceptScheme'
      ? catalogueEntries.concepts({ ...address, context, realm, returnHref: publicReturnHref })
      : undefined;
  const music =
    subjectType === 'schema:Place' ||
    subjectType === 'schema:Event' ||
    subjectType === 'schema:MusicVenue' ||
    subjectType === 'schema:MusicEvent' ||
    subjectType === 'schema:AdministrativeArea' ||
    subjectType === 'schema:MusicInstrument' ||
    subjectType === 'wd:Q34379'
      ? catalogueEntries.musicContext({
          ...address,
          ...(context !== undefined ? { context } : {}),
          ...(realm !== undefined ? { realm } : {}),
          ...((musicReturnTo ?? returnTo) !== undefined ? { returnTo: musicReturnTo ?? returnTo } : {}),
        })
      : undefined;
  return (
    <section data-slot="subject-explore" className="flex min-w-0 flex-wrap gap-2">
      <p className="w-full text-sm font-medium">{m.graph_explore_title({}, o)}</p>
      <CompanionLink href={graph.href} label={graph.label} />
      {quotations && 'href' in quotations ? (
        <CompanionLink href={quotations.href} label={quotations.label} />
      ) : quotations ? (
        <div role="group" aria-label={quotations.label} className="flex min-w-0 flex-wrap items-center gap-2">
          <p id={unsupportedId} role="status" className="max-w-prose text-sm text-muted-foreground">
            {quotationUnsupportedText(quotations.unsupported, locale)}
          </p>
          {quotations.generalHref && (
            <CompanionLink
              href={quotations.generalHref}
              label={m.quotation_entry_general({}, o)}
              describedBy={unsupportedId}
            />
          )}
        </div>
      ) : null}
      {concepts && <CompanionLink href={concepts.href} label={concepts.label} />}
      {music && <CompanionLink href={music.href} label={music.label} />}
      {music && realm && <p role="status">{m.music_context_realm_unsupported({}, o)}</p>}
    </section>
  );
}

export function SubjectConceptTags(props: WorkTagReadingProps) {
  return renderWorkTagReading(props);
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
  context,
  returnHref,
}: {
  subjectId: string;
  subjectType: string;
  label: string;
  locale: string;
  context?: string | undefined;
  returnHref?: string | undefined;
}) {
  const entry = catalogueEntries.releaseFidelity({
    id: subjectId,
    type: subjectType,
    label,
    locale,
    ...(context !== undefined ? { context } : {}),
    ...(returnHref !== undefined ? { returnHref } : {}),
  });
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
