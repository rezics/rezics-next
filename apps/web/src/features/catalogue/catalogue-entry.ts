import { mangaPublicCorrectionHref, type MangaPublicOrigin } from './manga-public-visit';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';
import { gameTypes } from './game-profile';
import type { Release } from '@rezics/definitions';
import { isFileOrGroupType } from './catalogue-file-profile/model';
import { addonPublicCorrectionHref, type AddonPublicOrigin } from './addon-public-visit';
import { catalogueFileCorrectionHref } from './catalogue-file-reader/navigation';
import { isReleaseType } from './release-fidelity/model';
import { releaseEntryHref, RELEASE_ENTRY_BYTES } from './release-fidelity/navigation';
import { factsPublicCorrectionHref, type FactsPublicOrigin } from './facts-public-visit';
import { conceptPublicOriginHref, type ConceptPublicOrigin } from './source-concept-explorer/public-visit';
import { termsPublicCorrectionHref, type TermsPublicOrigin } from './terms-public-visit';
import { graphPublicOriginHref, type GraphPublicOrigin } from '../pages/graph-browser/public-visit';
import { musicContextAddressHref, validatedMusicContextReturn } from './music-context-profile/navigation';
import { createRelationPublicOrigin, relationPublicCorrectionHref } from './relation-public-visit';
import { authoredPublicCorrectionHref, type AuthoredPublicOrigin } from './authored-public-visit';

export type ContributionGroup = 'create' | 'edit' | 'review' | 'read';
export type CatalogueEntry = { group: ContributionGroup; label: string; href: string };
type QuotationUnsupported = 'realm' | 'context' | 'origin' | 'address';
export type QuotationEntry =
  | CatalogueEntry
  | {
      group: 'read';
      label: string;
      unsupported: QuotationUnsupported;
      generalHref?: string;
    };
type Locale = { locale: string };
type Subject = Locale & { id: string; label: string };
const options = (locale: string) => ({ locale: locale as never });
const subject = ({ id, label, locale }: Subject) => subjectHref({ id, label }, locale).href;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

function releaseOrigin(
  value: string | undefined,
  { id, label, locale, context }: Locale & { id: string; label: string; context?: string | undefined },
): string | undefined {
  if (value === undefined) return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted || utf8Bytes(accepted) > RELEASE_ENTRY_BYTES) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const base = subject({ id, label, locale });
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return;
  if (url.hash !== '#connections') return;
  const keys = [...url.searchParams.keys()];
  if (
    (context === undefined && keys.length !== 0) ||
    (context !== undefined &&
      (keys.length !== 1 || keys[0] !== 'context' || url.searchParams.get('context') !== context))
  )
    return;
  return accepted;
}

const contextId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function addressFits(value: string): boolean {
  return value.length <= 2048 && new TextEncoder().encode(value).byteLength <= 2048;
}

function quotationPath(address: Subject): string {
  const url = new URL(`${subject(address)}/quotations`, 'https://rezics.invalid');
  return `${url.pathname}${url.search}`;
}

function unsupportedQuotation(address: Subject, unsupported: QuotationUnsupported): QuotationEntry {
  const generalHref = quotationPath(address);
  return {
    group: 'read',
    label: m.quotation_title({}, options(address.locale)),
    unsupported,
    ...(addressFits(generalHref) ? { generalHref } : {}),
  };
}

/** Shared destinations for standalone native entries and their grouped navigation. No capability decisions. */
export const catalogueEntries = {
  literary: ({
    id,
    label,
    locale,
  }: Locale & { id?: string | undefined; label?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: m.literary_title({}, options(locale)),
    href: id ? `${subject({ id, label: label ?? '', locale })}/literary` : `/${locale}/catalogue/literary`,
  }),
  addon: ({
    id,
    label,
    work,
    locale,
    origin,
  }: Locale & {
    id?: string | undefined;
    label?: string | undefined;
    work?: string | undefined;
    origin?: AddonPublicOrigin | undefined;
  }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: m.addon_title({}, options(locale)),
    href: id
      ? origin
        ? addonPublicCorrectionHref(`${subject({ id, label: label ?? '', locale })}/addon`, origin)
        : `${subject({ id, label: label ?? '', locale })}/addon`
      : `/${locale}/catalogue/addon${work ? `?work=${encodeURIComponent(work)}` : ''}`,
  }),
  create: ({ locale }: Locale): CatalogueEntry => ({
    group: 'create',
    label: m.catalogue_create_title({}, options(locale)),
    href: `/${locale}/catalogue/new`,
  }),
  relatedWorkCreate: ({ locale, token }: Locale & { token: string }): CatalogueEntry => ({
    group: 'create',
    label: m.catalogue_create_title({}, options(locale)),
    href: `/${locale}/catalogue/new?relatedWorkHandoff=${encodeURIComponent(token)}`,
  }),
  authored: ({
    id,
    title,
    locale,
    origin,
  }: Locale & {
    id: string;
    title: string;
    origin?: AuthoredPublicOrigin | undefined;
  }): CatalogueEntry => {
    const base = `${subject({ id, label: title, locale })}/authored`;
    return {
      group: 'edit',
      label: m.authored_title({}, options(locale)),
      href: origin ? authoredPublicCorrectionHref(base, origin) : base,
    };
  },
  facts: (address: Subject & { origin?: FactsPublicOrigin | undefined }): CatalogueEntry => ({
    group: 'edit',
    label: m.facts_title({}, options(address.locale)),
    href: address.origin
      ? factsPublicCorrectionHref(`${subject(address)}/edit`, address.id, address.locale, address.origin)
      : `${subject(address)}/edit`,
  }),
  terms: (address: Subject & { origin?: TermsPublicOrigin | undefined }): CatalogueEntry => ({
    group: 'edit',
    label: m.catalogue_terms_title({}, options(address.locale)),
    href: address.origin
      ? termsPublicCorrectionHref(`${subject(address)}/terms`, address.id, address.locale, address.origin)
      : `${subject(address)}/terms`,
  }),
  manga: ({
    id,
    label,
    locale,
    origin,
  }: Locale & {
    id?: string | undefined;
    label?: string | undefined;
    origin?: MangaPublicOrigin | undefined;
  }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.manga_edit({}, options(locale)) : m.manga_title({}, options(locale)),
    href: id
      ? origin
        ? mangaPublicCorrectionHref(`${subject({ id, label: label ?? '', locale })}/manga`, origin)
        : `${subject({ id, label: label ?? '', locale })}/manga`
      : `/${locale}/catalogue/manga`,
  }),
  recipe: ({
    id,
    label,
    locale,
  }: Locale & { id?: string | undefined; label?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.recipe_edit({}, options(locale)) : m.recipe_title({}, options(locale)),
    href: id ? `${subject({ id, label: label ?? '', locale })}/recipe` : `/${locale}/catalogue/recipe`,
  }),
  gameProfile: ({
    id,
    type,
    label = '',
    locale,
  }: Locale & { id?: string | undefined; type?: string | undefined; label?: string | undefined }):
    | CatalogueEntry
    | undefined => {
    if (id && !gameTypes.includes(type as (typeof gameTypes)[number])) return undefined;
    return {
      group: id ? 'edit' : 'create',
      label: m.game_profile_title({}, options(locale)),
      href: id ? `${subject({ id, label, locale })}/game` : `/${locale}/catalogue/game`,
    };
  },
  album: ({
    id,
    label,
    locale,
    visit,
  }: Locale & { id?: string | undefined; label?: string | undefined; visit?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.album_edit({}, options(locale)) : m.album_create({}, options(locale)),
    href: id
      ? `${subject({ id, label: label ?? '', locale })}/album${visit ? `?${new URLSearchParams({ visit })}` : ''}`
      : `/${locale}/catalogue/album`,
  }),
  screen: ({
    id,
    label,
    locale,
  }: Locale & { id?: string | undefined; label?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.screen_edit({}, options(locale)) : m.screen_title({}, options(locale)),
    href: id ? `${subject({ id, label: label ?? '', locale })}/screen` : `/${locale}/catalogue/screen`,
  }),
  publication: ({ work, locale }: Locale & { work: string }): CatalogueEntry => ({
    group: 'create',
    label: m.publication_add({}, options(locale)),
    href: `/${locale}/catalogue/publication?work=${encodeURIComponent(work)}`,
  }),
  character: ({
    id,
    label,
    work,
    context,
    realm,
    locale,
  }: Locale & {
    id?: string | undefined;
    label?: string | undefined;
    work?: string | undefined;
    context?: string | undefined;
    realm?: string | undefined;
  }): CatalogueEntry => {
    const search = new URLSearchParams({
      ...(work ? { work } : {}),
      ...(context ? { context } : {}),
      ...(realm ? { realm } : {}),
    });
    return {
      group: id ? 'edit' : 'create',
      label: m.character_title({}, options(locale)),
      href: id
        ? `${subject({ id, label: label ?? '', locale })}/character${search.size ? `?${search}` : ''}`
        : `/${locale}/catalogue/character${work ? `?work=${encodeURIComponent(work)}` : ''}`,
    };
  },
  characterRelationships: ({
    id,
    label,
    locale,
    work,
  }: Locale & { id: string; label: string; work?: string | undefined }): CatalogueEntry => ({
    group: 'read',
    label: m.character_relationships_title({}, options(locale)),
    href: `${subject({ id, label, locale })}/character-relationships${work ? `?work=${encodeURIComponent(work)}` : ''}`,
  }),
  changes: ({ id, title, locale }: Locale & { id: string; title: string }): CatalogueEntry => ({
    group: 'read',
    label: m.changes_title({}, options(locale)),
    href: `${subject({ id, label: title, locale })}/changes`,
  }),
  people: ({ id, label, work, locale }: Locale & { id?: string; label?: string; work?: string }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: m.people_profile_title({}, options(locale)),
    href: id
      ? `${subject({ id, label: label ?? '', locale })}/people`
      : `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`,
  }),
  producerHistory: ({
    id,
    label = '',
    locale,
    context,
    realm,
  }: Locale & {
    id: string;
    label?: string | undefined;
    context?: string | undefined;
    realm?: string | undefined;
  }): CatalogueEntry => {
    const search = new URLSearchParams({
      ...(context ? { context } : {}),
      ...(realm ? { realm } : {}),
    });
    return {
      group: 'edit',
      label: m.producer_history_title({}, options(locale)),
      href: `${subject({ id, label, locale })}/producer${search.size ? `?${search}` : ''}`,
    };
  },
  releaseFidelity: ({
    id,
    type,
    label = '',
    locale,
    context,
    returnHref,
    release,
  }: Locale & {
    id?: string | undefined;
    type?: string | undefined;
    label?: string | undefined;
    context?: string | undefined;
    returnHref?: string | undefined;
    release?: Pick<Release, 'types' | 'properties'> | undefined;
  }): CatalogueEntry | undefined => {
    if (
      !id ||
      (release
        ? !isReleaseType(release, type ?? '')
        : !['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'].includes(type ?? ''))
    )
      return;
    const origin = releaseOrigin(returnHref, { id, label, locale, ...(context !== undefined ? { context } : {}) });
    return {
      group: 'edit',
      label: m.release_fidelity_title({}, options(locale)),
      href: releaseEntryHref({
        id,
        label,
        locale,
        ...(context !== undefined ? { context } : {}),
        ...(origin !== undefined ? { via: origin } : {}),
      }),
    };
  },
  catalogueFile: ({
    id,
    type,
    label = '',
    locale,
    release,
    returnSourceId,
  }: Locale & {
    id?: string | undefined;
    type?: string | undefined;
    label?: string | undefined;
    release?: Pick<Release, 'types' | 'properties'> | undefined;
    returnSourceId?: string | undefined;
  }): CatalogueEntry | undefined => {
    if (id) {
      if (!type || !release || !isFileOrGroupType(release, type)) return;
      const base = `${subject({ id, label, locale })}/file`;
      const href = returnSourceId ? catalogueFileCorrectionHref(base, returnSourceId, locale) : base;
      if (!href) return;
      return {
        group: 'edit',
        label: m.catalogue_file_title({}, options(locale)),
        href,
      };
    }
    if (type && (!release || !isFileOrGroupType(release, type))) return;
    return {
      group: 'create',
      label: m.catalogue_file_create_title({}, options(locale)),
      href: `/${locale}/catalogue/file`,
    };
  },
  graph: ({
    id,
    label = '',
    locale,
    origin,
  }: Locale & { id: string; label?: string | undefined; origin?: GraphPublicOrigin | undefined }): CatalogueEntry => {
    const base = `${subject({ id, label, locale })}/graph`;
    return {
      group: 'read',
      label: m.graph_explore_title({}, options(locale)),
      href: origin ? graphPublicOriginHref(base, origin) : base,
    };
  },
  quotations: ({
    id,
    label = '',
    locale,
    context,
    realm,
    returnTo,
  }: Locale & {
    id: string;
    label?: string | undefined;
    context?: string | undefined;
    realm?: string | undefined;
    /** A validated same-locale, same-Subject public origin, or null when an explicit origin was refused. */
    returnTo?: string | null | undefined;
  }): QuotationEntry => {
    const address = { id, label, locale };
    if (realm !== undefined) return unsupportedQuotation(address, 'realm');
    if (context !== undefined && !contextId.test(context)) return unsupportedQuotation(address, 'context');
    if (returnTo !== undefined) {
      if (
        returnTo === null ||
        !addressFits(returnTo) ||
        !returnTo.startsWith('/') ||
        returnTo.startsWith('//') ||
        returnTo.startsWith('/\\') ||
        /[\\\u0000-\u001f\u007f]/u.test(returnTo)
      )
        return unsupportedQuotation(address, 'origin');
    }
    const url = new URL(quotationPath(address), 'https://rezics.invalid');
    if (context !== undefined) url.searchParams.set('context', context);
    if (typeof returnTo === 'string') url.searchParams.set('returnTo', returnTo);
    const href = `${url.pathname}${url.search}`;
    if (!addressFits(href)) return unsupportedQuotation(address, 'address');
    return { group: 'read', label: m.quotation_title({}, options(locale)), href };
  },
  concepts: ({
    id,
    label = '',
    locale,
    context,
    realm,
    returnHref,
  }: Locale & {
    id: string;
    label?: string | undefined;
    context?: string | undefined;
    realm?: string | undefined;
    returnHref?: string | undefined;
  }): CatalogueEntry => {
    const base = `${subject({ id, label, locale })}/concepts`;
    const hasObservation = context !== undefined || realm !== undefined || returnHref !== undefined;
    const origin: ConceptPublicOrigin | undefined = hasObservation
      ? { subject: id, context: context ?? '', locale, ...(realm ? { realm } : {}), returnHref: returnHref ?? '' }
      : undefined;
    return {
      group: 'read',
      label: m.concept_explore_title({}, options(locale)),
      href: origin ? conceptPublicOriginHref(base, origin) : base,
    };
  },
  musicContext: ({
    id,
    label = '',
    locale,
    context,
    realm,
    returnTo,
  }: Locale & {
    id: string;
    label?: string | undefined;
    context?: string | undefined;
    realm?: string | undefined;
    returnTo?: string | undefined;
  }): CatalogueEntry => {
    const acceptedReturn = validatedMusicContextReturn(returnTo, locale, id, context, realm);
    const base = `${subject({ id, label, locale })}/music-context`;
    const selected = {
      ...(context !== undefined ? { context } : {}),
      ...(realm !== undefined ? { realm } : {}),
    };
    const href =
      (acceptedReturn
        ? musicContextAddressHref(base, { ...selected, returnTo: acceptedReturn }, locale, id)
        : undefined) ?? musicContextAddressHref(base, selected, locale, id);
    if (!href) throw new Error('Unable to compose the admitted music-context address');
    return {
      group: 'read',
      label: m.music_context_title({}, options(locale)),
      href,
    };
  },
  musicContextCreate: ({ locale }: Locale): CatalogueEntry => ({
    group: 'create',
    label: m.music_context_create_title({}, options(locale)),
    href: `/${locale}/catalogue/music-context`,
  }),
  concept: ({ locale, token }: Locale & { token?: string }): CatalogueEntry => ({
    group: 'create',
    label: m.concept_create_title({}, options(locale)),
    href: token
      ? `/${locale}/catalogue/concept?classificationHandoff=${encodeURIComponent(token)}`
      : `/${locale}/catalogue/concept`,
  }),
};

/** Navigation may request sign-in; the native page still owns every current availability/authority decision. */
export function contributionHref(entry: CatalogueEntry, signedOut: boolean): string {
  return signedOut && entry.group !== 'read' ? `/auth/sign-in?return_to=${encodeURIComponent(entry.href)}` : entry.href;
}

/** Exact current Context and Realm addresses come from the page read, never Source provenance or a grant guess. */
export function subjectContributionEntries(
  address: Subject & { context?: string | undefined; realm?: string | undefined },
): CatalogueEntry[] {
  const base = subject(address);
  const relationOrigin = createRelationPublicOrigin(address);
  return [
    {
      group: 'edit',
      label: m.relation_title({}, options(address.locale)),
      href: relationOrigin
        ? relationPublicCorrectionHref(`${base}/relation-edit`, relationOrigin)
        : `${base}/relation-edit${address.realm ? `?${new URLSearchParams({ realm: address.realm })}` : ''}`,
    },
    ...(address.context
      ? [
          {
            group: 'review' as const,
            label: m.context_title({}, options(address.locale)),
            href: `${base}/context-review?${new URLSearchParams({ context: address.context })}`,
          },
        ]
      : []),
    { group: 'read', label: m.subject_sources({}, options(address.locale)), href: `${base}/sources` },
  ];
}
