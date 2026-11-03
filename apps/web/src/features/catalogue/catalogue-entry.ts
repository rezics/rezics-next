import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { gameTypes } from './game-profile';

export type ContributionGroup = 'create' | 'edit' | 'review' | 'read';
export type CatalogueEntry = { group: ContributionGroup; label: string; href: string };
type Locale = { locale: string };
type Subject = Locale & { id: string; label: string };
const options = (locale: string) => ({ locale: locale as never });
const subject = ({ id, label, locale }: Subject) => subjectHref({ id, label }, locale).href;

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
  }: Locale & { id?: string | undefined; label?: string | undefined; work?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: m.addon_title({}, options(locale)),
    href: id
      ? `${subject({ id, label: label ?? '', locale })}/addon`
      : `/${locale}/catalogue/addon${work ? `?work=${encodeURIComponent(work)}` : ''}`,
  }),
  create: ({ locale }: Locale): CatalogueEntry => ({
    group: 'create',
    label: m.catalogue_create_title({}, options(locale)),
    href: `/${locale}/catalogue/new`,
  }),
  authored: ({ id, title, locale }: Locale & { id: string; title: string }): CatalogueEntry => ({
    group: 'edit',
    label: m.authored_title({}, options(locale)),
    href: `${subject({ id, label: title, locale })}/authored`,
  }),
  facts: (address: Subject): CatalogueEntry => ({
    group: 'edit',
    label: m.facts_title({}, options(address.locale)),
    href: `${subject(address)}/edit`,
  }),
  terms: (address: Subject): CatalogueEntry => ({
    group: 'edit',
    label: m.catalogue_terms_title({}, options(address.locale)),
    href: `${subject(address)}/terms`,
  }),
  manga: ({ id, label, locale }: Locale & { id?: string | undefined; label?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.manga_edit({}, options(locale)) : m.manga_title({}, options(locale)),
    href: id ? `${subject({ id, label: label ?? '', locale })}/manga` : `/${locale}/catalogue/manga`,
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
  album: ({ id, label, locale }: Locale & { id?: string | undefined; label?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: id ? m.album_edit({}, options(locale)) : m.album_create({}, options(locale)),
    href: id ? `${subject({ id, label: label ?? '', locale })}/album` : `/${locale}/catalogue/album`,
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
    locale,
  }: Locale & { id?: string | undefined; label?: string | undefined; work?: string | undefined }): CatalogueEntry => ({
    group: id ? 'edit' : 'create',
    label: m.character_title({}, options(locale)),
    href: id
      ? `${subject({ id, label: label ?? '', locale })}/character`
      : `/${locale}/catalogue/character${work ? `?work=${encodeURIComponent(work)}` : ''}`,
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
  }: Locale & { id: string; label?: string | undefined }): CatalogueEntry => ({
    group: 'edit',
    label: m.producer_history_title({}, options(locale)),
    href: `${subject({ id, label, locale })}/producer`,
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
  return [
    {
      group: 'edit',
      label: m.relation_title({}, options(address.locale)),
      href: `${base}/relation-edit${address.realm ? `?${new URLSearchParams({ realm: address.realm })}` : ''}`,
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
