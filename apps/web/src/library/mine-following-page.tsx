import { useSession } from '../session/query';
import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { DropdownMenuItem } from '@rezics/ui/shadcn/dropdown-menu';
import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { coverSrc } from '../media/cover-src';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
import type { MineFollow, MineFollowingPage } from './mine-following';
import { unfollow } from './mine-following-actions';
import { coverSubject } from './subject-row';

export function MineFollowingPageView({ page }: { page: MineFollowingPage }) {
  const { csrfToken } = useSession();
  const location = useLocation();
  const [follows, setFollows] = useState(page.follows);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  useEffect(() => setFollows(page.follows), [page.follows]);

  if (!page.signedIn) return <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />;

  const active = follows.filter((follow) => follow.state === 'following');
  const groups = [
    { type: 'subject' as const, label: m.library_following_subjects() },
    { type: 'collection' as const, label: m.library_following_collections() },
    { type: 'space' as const, label: m.library_following_spaces() },
  ];

  async function submit(follow: MineFollow) {
    if (!csrfToken || pending) return;
    setPending(follow.targetId);
    setFailure('');
    try {
      const result = await unfollow({
        data: { targetId: follow.targetId, idempotencyKey: follow.idempotencyKey },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (result.ok) setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
      else setFailure(m.error_message());
    } catch {
      setFailure(m.error_message());
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.library_following_heading()}</PageHeading>
      </header>
      {failure ? <p role="alert">{failure}</p> : null}
      {active.length ? (
        <div className="space-y-8">
          {groups.map(({ type, label }) => {
            const items = active.filter((follow) => follow.targetType === type);
            if (!items.length) return null;
            const subjects = items.map((follow) =>
              type === 'subject' ? coverSubject(follow.target) : { ...coverSubject(follow.target), types: [] },
            );
            return (
              <section key={type} className="space-y-3" aria-labelledby={`following-${type}`}>
                <h2 id={`following-${type}`} className="text-xl font-semibold">
                  {label}
                </h2>
                <CoverGrid ratio={sharedRatio(subjects)}>
                  {items.map((follow, index) => {
                    const subject = subjects[index]!;
                    const path = type === 'subject' ? 'subjects' : 'collections';
                    return (
                      <CoverCard
                        key={`${type}:${follow.targetId}`}
                        {...(follow.target && type !== 'space'
                          ? { href: `/${getLocale()}/${path}/${encodeURIComponent(follow.target.id)}` }
                          : {})}
                        title={subject.title}
                        cover={{
                          subject,
                          cover: follow.target?.cover ?? null,
                          src: coverSrc,
                          labels: {
                            withheld: m.thread_cover_withheld(),
                            reveal: m.thread_cover_reveal(),
                            credit: m.thread_cover_credit(),
                            via: m.thread_cover_via(),
                          },
                        }}
                        secondary={
                          type === 'subject'
                            ? follow.target?.typeLabel
                            : type === 'collection'
                              ? m.library_following_kind_collection()
                              : m.library_following_kind_space()
                        }
                        state={
                          follow.reason === 'library'
                            ? m.library_follow_reason_library()
                            : follow.reason === 'membership'
                              ? m.library_follow_reason_membership()
                              : undefined
                        }
                        menuLabel={m.library_follow_more_actions({ title: subject.title })}
                        menu={
                          <DropdownMenuItem
                            disabled={!csrfToken || pending !== null}
                            onClick={() => void submit(follow)}
                          >
                            {m.library_follow_unfollow()}
                          </DropdownMenuItem>
                        }
                      />
                    );
                  })}
                </CoverGrid>
              </section>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground">{m.library_following_empty()}</p>
      )}
      {page.next ? (
        <nav aria-label={m.library_following_heading()}>
          <Link
            to="/library/following"
            search={{ cursor: page.next }}
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
          >
            {m.library_collection_more()}
          </Link>
        </nav>
      ) : null}
    </article>
  );
}
