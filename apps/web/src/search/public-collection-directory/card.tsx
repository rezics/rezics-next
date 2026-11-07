import { Cover } from '@rezics/ui/cover';
import type { PublicCollectionSummary } from '../discovery';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { collectionMemberSubjectHref } from '../../subject/subject-href';
import { CollectionPresentationSummary } from '../../shell/collection-presentation';

/** One admitted Search card, including its bounded native preview. No Collection or Subject hydration. */
export function CollectionDiscoveryCard({ card, locale }: { card: PublicCollectionSummary['card']; locale: string }) {
  const options = { locale: locale as Locale };
  const href = `/${locale}${card.destination}`;
  const kind = card.presentationKindSource === 'owner' ? card.presentationKind : null;
  return (
    <article className="min-w-0 space-y-4" data-discovery-collection={card.id}>
      <div className="flex min-w-0 items-start gap-4">
        <div className="w-[72px] shrink-0 sm:w-24" data-collection-cover-source={card.coverSource}>
          <Cover
            subject={{ id: card.id, title: card.title, types: kind ? [kind] : [] }}
            cover={card.cover}
            src={coverSrc}
            size="fill"
            decorative
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-lg font-semibold leading-snug [overflow-wrap:anywhere] sm:text-xl">
            <a
              href={href}
              className="inline-flex min-h-11 max-w-full items-center rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {card.title}
            </a>
          </h2>
          {card.membershipKind === 'curated' ? (
            <p className="text-sm text-muted-foreground">
              {m.library_collection_item_count({ count: card.memberCount }, options)}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {card.curator.state === 'available' ? (
              <>
                {m.discovery_collection_curator({}, options)}{' '}
                {card.curator.destination ? (
                  <a
                    className="inline-flex min-h-11 items-center text-primary underline"
                    href={`/${locale}${card.curator.destination}`}
                  >
                    {card.curator.label || m.discovery_unnamed_account({}, options)}
                  </a>
                ) : (
                  card.curator.label || m.discovery_unnamed_account({}, options)
                )}
              </>
            ) : (
              m.discovery_collection_curator_unavailable({}, options)
            )}
          </p>
        </div>
      </div>
      {card.description ? (
        <p className="max-w-3xl whitespace-pre-wrap leading-relaxed text-muted-foreground">{card.description}</p>
      ) : null}
      <CollectionPresentationSummary kind={kind} dynamic={card.membershipKind === 'dynamic'} locale={locale} />
      {card.preview.state === 'available' ? (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <p className="text-sm font-medium">{m.discovery_collection_preview({}, options)}</p>
          <ul className="space-y-1" aria-label={m.discovery_collection_preview({}, options)}>
            {card.preview.members.map((member) => (
              <li key={member.id} data-collection-member-id={member.id} className="min-w-0">
                <a
                  lang={member.subject.label?.language}
                  href={collectionMemberSubjectHref(
                    { id: member.subject.id, label: member.subject.label?.value ?? '' },
                    locale,
                    href,
                    member.id,
                  )}
                  className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
                >
                  {member.subject.label?.value || m.subject_value_unlabelled({}, options)}
                </a>
                {!kind ? (
                  <span className="ms-2 text-sm text-muted-foreground" data-subject-type={member.subject.type}>
                    {member.subject.type}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {card.preview.partial ? (
            <p className="text-sm text-muted-foreground">{m.discovery_collection_partial({}, options)}</p>
          ) : null}
          {card.preview.truncated ? (
            <p className="text-sm text-muted-foreground">{m.discovery_collection_truncated({}, options)}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {card.preview.state === 'empty'
            ? m.discovery_collection_empty({}, options)
            : card.preview.state === 'withheld'
              ? m.discovery_collection_withheld({}, options)
              : m.discovery_collection_preview_unavailable({}, options)}
        </p>
      )}
    </article>
  );
}
