import { Link, useLocation } from '@tanstack/react-router';
import { ListRow } from '@rezics/ui/list-row';
import { placeholderColors, sharedRatio, type CoverSubject } from '@rezics/ui/cover';
import { CoverCard, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { RealmMembership } from './realm-membership';
import type { PublishedSubject, RealmBoard, RealmHome, SpacePageData } from './space';

function subjectTitle(subject: PublishedSubject, locale: string): string {
  return (
    subject.labels[locale] ??
    subject.label ??
    subject.labels.en ??
    Object.values(subject.labels)[0] ??
    m.library_subject_unavailable()
  );
}

function purposeLabel(purpose: RealmBoard['purpose']): string {
  return purpose === 'reviews' ? m.realm_board_purpose_reviews() : m.realm_board_purpose_discussion();
}

function Boards({ boards }: { boards: RealmBoard[] }) {
  return (
    <section className="space-y-4" aria-labelledby="realm-boards-heading">
      <h2 id="realm-boards-heading" className="text-xl font-semibold">
        {m.realm_boards_heading()}
      </h2>
      {boards.length ? (
        <ul className="space-y-1">
          {boards.map((board) => (
            <ListRow key={board.id} className="flex items-start gap-4 rounded-xl px-4 py-3">
              <Link
                to="/boards/$id"
                params={{ id: board.id }}
                className="absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                data-slot="list-row-link"
              >
                <span className="sr-only">{board.title ?? m.threads_untitled()}</span>
              </Link>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="font-semibold">{board.title ?? m.threads_untitled()}</h3>
                {board.description ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">{board.description}</p>
                ) : null}
                <p className="text-xs font-medium text-muted-foreground">{purposeLabel(board.purpose)}</p>
              </div>
              {board.visibility === 'draft' || board.visibility === 'protected' ? (
                <p className="relative z-10 shrink-0 text-xs text-muted-foreground">
                  {board.visibility === 'draft' ? m.realm_board_draft() : m.realm_board_protected()}
                </p>
              ) : null}
            </ListRow>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{m.realm_boards_empty()}</p>
      )}
    </section>
  );
}

function CarriedRealm({ realm }: { realm: RealmHome }) {
  return (
    <section className="space-y-4" aria-labelledby="space-realm-heading">
      <h2 id="space-realm-heading" className="text-xl font-semibold">
        {m.space_realm_heading()}
      </h2>
      <ul className="space-y-1">
        <ListRow className="flex items-start gap-4 rounded-xl px-4 py-3">
          <Link
            to="/realms/$id"
            params={{ id: realm.id }}
            data-slot="list-row-link"
            className="absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="sr-only">{realm.title}</span>
          </Link>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-semibold">{realm.title}</h3>
            {realm.summary ? <p className="text-sm leading-relaxed text-muted-foreground">{realm.summary}</p> : null}
          </div>
        </ListRow>
      </ul>
    </section>
  );
}

function Published({ subjects }: { subjects: PublishedSubject[] }) {
  const locale = getLocale();
  const titled: { subject: PublishedSubject; cover: CoverSubject }[] = subjects.map((subject) => ({
    subject,
    cover: { id: subject.id, title: subjectTitle(subject, locale), types: subject.types },
  }));
  const ratio = sharedRatio(titled.map((item) => item.cover));
  return (
    <section className="space-y-4" aria-labelledby="realm-published-heading">
      <h2 id="realm-published-heading" className="text-xl font-semibold">
        {m.realm_published_heading()}
      </h2>
      {titled.length ? (
        <CoverRow ratio={ratio} label={`${m.realm_published_heading()} (${titled.length})`}>
          {titled.map(({ subject, cover }) => (
            <CoverCard
              key={subject.id}
              href={subjectHref({ id: subject.id, label: subjectTitle(subject, locale) }, locale).href}
              cover={{ subject: cover, cover: subject.cover, src: coverSrc }}
              title={cover.title}
              secondary={subject.typeName}
            />
          ))}
        </CoverRow>
      ) : (
        <p className="text-muted-foreground">{m.realm_published_empty()}</p>
      )}
    </section>
  );
}

function Home({ realm, returnTo }: { realm: RealmHome; returnTo: string }) {
  return (
    <>
      <CarriedRealm realm={realm} />
      <Boards boards={realm.boards} />
      <Published subjects={realm.published} />
    </>
  );
}

/** A Space's page: its title and summary as the brand surface, and the Realm it carries as that Realm's home. */
export function SpacePage({ page }: { page: SpacePageData }) {
  const location = useLocation();
  const colors = placeholderColors({ id: page.space.id, types: [] });
  const banner = page.space.banner;
  const bannerVariant = banner?.variants.find((variant) => variant.format === 'webp') ?? banner?.variants.at(-1);
  const previewSrc =
    banner && 'previewSrc' in banner && typeof banner.previewSrc === 'string' ? banner.previewSrc : null;
  const bannerSrc =
    previewSrc ??
    (banner && bannerVariant ? coverSrc(banner.media, bannerVariant.format, bannerVariant.width) : undefined);
  return (
    <article className="max-w-5xl space-y-10 text-foreground">
      <header
        className="relative isolate flex flex-wrap items-end justify-between gap-7 overflow-hidden rounded-3xl px-6 py-8 sm:px-10 sm:py-10"
        style={{ backgroundColor: banner?.placeholder.color ?? colors.background, color: colors.foreground }}
      >
        {bannerSrc ? (
          <>
            <img
              src={bannerSrc}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 -z-20 h-full w-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 -z-10 bg-gradient-to-r from-black/75 via-black/50 to-black/15"
            />
          </>
        ) : null}
        <div className="relative z-0 min-w-0 flex-1 basis-64 space-y-3">
          <PageHeading>{page.space.title}</PageHeading>
          {page.space.summary ? (
            <p className="max-w-2xl text-lg/relaxed whitespace-pre-wrap">{page.space.summary}</p>
          ) : null}
        </div>
        {page.realm ? (
          <div className="relative z-10 shrink-0">
            <RealmMembership realm={page.realm} returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />
          </div>
        ) : null}
      </header>
      {page.realm ? <Home realm={page.realm} returnTo={location.publicHref.split(/[?#]/, 1)[0]!} /> : null}
    </article>
  );
}
