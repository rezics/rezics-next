import type { CoverRatio } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { SignInPrompt } from '../threads/composer';
import type { MineFollow, MineFollowingPage } from './mine-following';
import { unfollow } from './mine-following-actions';
import { rowRatio, SubjectCover, SubjectIdentity } from './subject-row';

function csrfHeaders(): HeadersInit {
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
  return { 'X-CSRF-Token': token };
}

/** A followed subject, collection or Space: its cover frame, and its name linked to its page where it has one. */
function FollowTarget({ follow, ratio }: { follow: MineFollow; ratio: CoverRatio }) {
  const target = follow.target;
  if (!target || follow.targetType === 'subject')
    return (
      <SubjectIdentity subject={target} ratio={ratio}>
        {follow.reason === 'library' ? <p className="text-sm">{m.library_follow_reason_library()}</p> : null}
        {follow.reason === 'membership' ? <p className="text-sm">{m.library_follow_reason_membership()}</p> : null}
      </SubjectIdentity>
    );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <SubjectCover subject={target} ratio={ratio} />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium break-words">
          {follow.targetType === 'collection' ? (
            <Link
              to="/collections/$id"
              params={{ id: target.id }}
              className="text-primary underline-offset-4 hover:underline"
            >
              {target.label}
            </Link>
          ) : (
            <span>{target.label}</span>
          )}
        </p>
        {follow.reason === 'library' ? <p className="text-sm">{m.library_follow_reason_library()}</p> : null}
        {follow.reason === 'membership' ? <p className="text-sm">{m.library_follow_reason_membership()}</p> : null}
      </div>
    </div>
  );
}

export function MineFollowingPageView({ page }: { page: MineFollowingPage }) {
  const location = useLocation();
  const [follows, setFollows] = useState(page.follows);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => setFollows(page.follows), [page.follows]);

  if (!page.signedIn) return <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />;

  const active = follows.filter((follow) => follow.state === 'following');
  const groups = [
    { type: 'subject' as const, label: m.library_following_subjects() },
    { type: 'collection' as const, label: m.library_following_collections() },
    { type: 'space' as const, label: m.library_following_spaces() },
  ];

  async function submit(event: FormEvent<HTMLFormElement>, follow: MineFollow) {
    event.preventDefault();
    if (pending) return;
    setPending(follow.targetId);
    try {
      const result = await unfollow({
        data: { targetId: follow.targetId, idempotencyKey: follow.idempotencyKey },
        headers: csrfHeaders(),
      });
      if (result.ok) setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.library_following_heading()}</PageHeading>
      </header>
      {active.length ? (
        <div className="space-y-8">
          {groups.map(({ type, label }) => {
            const items = active.filter((follow) => follow.targetType === type);
            if (!items.length) return null;
            const ratio = rowRatio(items.map((follow) => follow.target));
            return (
              <section key={type} className="space-y-3" aria-labelledby={`following-${type}`}>
                <h2 id={`following-${type}`} className="text-xl font-semibold">
                  {label}
                </h2>
                <ul className="divide-y divide-border/60 border-y border-border/60">
                  {items.map((follow) => (
                    <li
                      key={`${follow.targetType}:${follow.targetId}`}
                      className="flex items-center justify-between gap-3 py-3"
                    >
                      <FollowTarget follow={follow} ratio={ratio} />
                      <form method="post" onSubmit={(event) => void submit(event, follow)}>
                        <input type="hidden" name="idempotency_key" value={follow.idempotencyKey} />
                        <Button type="submit" variant="outline" size="sm" disabled={pending === follow.targetId}>
                          {m.library_follow_unfollow()}
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
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
