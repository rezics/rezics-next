import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import type { PageMessages } from './data';
import type { LinkProps } from './shared';
import type { ViewTabLabels } from './view-tabs';
import { subjectHref } from '../../subject/subject-href';

/** A link to a subject page navigates in the client; any other address is a plain anchor. */
export function SubjectLink({ href, lang, className, children }: LinkProps) {
  const match = /^\/([^/]+)\/subjects\/([^/?#]+)\/([^/?#]+)$/.exec(href);
  if (!match)
    return (
      <a href={href} lang={lang} className={className}>
        {children}
      </a>
    );
  const locale = decodeURIComponent(match[1]!);
  const id = decodeURIComponent(match[2]!);
  const slug = decodeURIComponent(match[3]!);
  const target = subjectHref({ id, label: slug }, locale);
  return (
    <Link to={target.to} params={target.params} lang={lang} className={className}>
      {children}
    </Link>
  );
}

/** The words a subject page needs from the site's messages. */
export function subjectPageMessages(): PageMessages {
  return {
    unknown: m.subject_value_unknown(),
    none: m.subject_value_none(),
    unlabelled: m.subject_value_unlabelled(),
    sources: m.subject_sources(),
    aliases: m.subject_aliases(),
    search: m.search_submit(),
    cover: m.subject_cover(),
    coverCredit: m.subject_cover_credit(),
    coverReveal: m.subject_cover_reveal(),
    coverWithheld: m.subject_cover_withheld(),
    coverVia: m.subject_cover_via(),
    details: m.subject_details(),
    documentSpoiler: m.thread_reveal_spoiler(),
    source: m.subject_source(),
    licence: m.subject_source_licence(),
    spoilerShow: m.subject_spoiler_show(),
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
