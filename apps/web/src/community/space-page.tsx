import { Link, useLocation } from '@tanstack/react-router';
import { Badge } from '@rezics/ui/shadcn/badge';
import { placeholderColors, sharedRatio, type CoverSubject } from '@rezics/ui/cover';
import { CoverCard, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
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
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card">
          {boards.map((board) => (
            <li key={board.id}>
              <Link
                to="/boards/$id"
                params={{ id: board.id }}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-foreground hover:bg-muted/60 focus-visible:bg-muted/60"
              >
                <span className="font-medium">{board.title ?? m.threads_untitled()}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {board.visibility === 'draft' ? <Badge variant="outline">{m.realm_board_draft()}</Badge> : null}
                  {board.visibility === 'protected' ? (
                    <Badge variant="outline">{m.realm_board_protected()}</Badge>
                  ) : null}
                  <Badge variant="secondary">{purposeLabel(board.purpose)}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{m.realm_boards_empty()}</p>
      )}
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
              href={`/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject.id)}`}
              cover={{ subject: cover, cover: subject.cover, src: coverSrc }}
              title={cover.title}
              secondary={subject.types[0]?.split(':').at(-1)}
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
      <RealmMembership realm={realm} returnTo={returnTo} />
      <Boards boards={realm.boards} />
      <Published subjects={realm.published} />
    </>
  );
}

/** A Space's page: its title and summary as the brand surface, and the Realm it carries as that Realm's home. */
export function SpacePage({ page }: { page: SpacePageData }) {
  const location = useLocation();
  const colors = placeholderColors({ id: page.space.id, types: [] });
  return (
    <article className="max-w-5xl space-y-10 text-foreground">
      <header
        className="rounded-3xl px-6 py-10 sm:px-10 sm:py-14"
        style={{ backgroundColor: colors.background, color: colors.foreground }}
      >
        <PageHeading className="max-w-3xl">{page.space.title}</PageHeading>
        {page.space.summary ? (
          <p className="mt-4 max-w-2xl text-lg/relaxed whitespace-pre-wrap">{page.space.summary}</p>
        ) : null}
      </header>
      {page.realm ? <Home realm={page.realm} returnTo={location.publicHref.split(/[?#]/, 1)[0]!} /> : null}
    </article>
  );
}
