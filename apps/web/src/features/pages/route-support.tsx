import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import type { PageMessages } from './data';
import { PlainLink, type LinkProps } from './shared';
import type { ViewTabLabels } from './view-tabs';
import { subjectHref } from '../../subject/subject-href';

function subjectAddress(href: string) {
  const match = /^\/([^/]+)\/subjects\/([^/?#]+)\/([^/?#]+)$/.exec(href);
  if (!match) return null;
  try {
    return {
      locale: decodeURIComponent(match[1]!),
      id: decodeURIComponent(match[2]!),
      slug: decodeURIComponent(match[3]!),
    };
  } catch {
    return null;
  }
}

/** A link to a subject page navigates in the client; any other address is a plain anchor. */
export function SubjectLink({ href, lang, className, children }: LinkProps) {
  const address = subjectAddress(href);
  if (!address)
    return (
      <PlainLink href={href} lang={lang} className={className}>
        {children}
      </PlainLink>
    );
  const target = subjectHref({ id: address.id, label: address.slug }, address.locale);
  return (
    <Link to={target.to} params={target.params} lang={lang} className={className}>
      {children}
    </Link>
  );
}

/** The words a subject page needs from the site's messages. Ordinary routes keep the ambient locale. */
export function subjectPageMessages(locale?: string): PageMessages {
  const options = locale === undefined ? undefined : { locale: locale as never };
  return {
    unknown: m.subject_value_unknown({}, options),
    none: m.subject_value_none({}, options),
    unlabelled: m.subject_value_unlabelled({}, options),
    sources: m.subject_sources({}, options),
    aliases: m.subject_aliases({}, options),
    search: m.search_submit({}, options),
    cover: m.subject_cover({}, options),
    coverCredit: m.subject_cover_credit({}, options),
    coverReveal: m.subject_cover_reveal({}, options),
    coverWithheld: m.subject_cover_withheld({}, options),
    coverVia: m.subject_cover_via({}, options),
    details: m.subject_details({}, options),
    documentSpoiler: m.thread_reveal_spoiler({}, options),
    source: m.subject_source({}, options),
    licence: m.subject_source_licence({}, options),
    spoilerShow: m.subject_spoiler_show({}, options),
  };
}

/** The name of every view in the reader's language, and the label of the tab bar. */
export function viewTabLabels(): ViewTabLabels {
  return {
    views: m.subject_views(),
    names: {
      overview: m.subject_overview(),
      editions: m.subject_editions(),
      contents: m.subject_contents(),
      characters: m.subject_characters(),
      appearances: m.subject_appearances(),
      credits: m.subject_credits(),
      works: m.subject_works(),
      relations: m.subject_relations(),
      posts: m.subject_posts(),
      reviews: m.subject_reviews(),
      discussion: m.subject_discussion(),
      lists: m.subject_lists(),
      collections: m.subject_collections(),
      details: m.subject_details(),
    },
  };
}
