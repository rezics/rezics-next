import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/composer';
import type { MineFollow, MineFollowingPage } from './mine-following';
import { unfollow } from './mine-following-actions';
import { SubjectRef } from './subject-ref';

function csrfHeaders(): HeadersInit {
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
  return { 'X-CSRF-Token': token };
}

function FollowTarget({ follow }: { follow: MineFollow }) {
  if (!follow.target) return <span>{m.library_subject_unavailable()}</span>;
  if (follow.targetType === 'collection')
    return (
      <Link
        to="/collections/$id"
        params={{ id: follow.target.id }}
        className="text-primary underline-offset-4 hover:underline"
      >
        {follow.target.label}
      </Link>
    );
  if (follow.targetType === 'subject') return <SubjectRef subject={follow.target} />;
  return <span>{follow.target.label}</span>;
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
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{m.library_following_heading()}</h1>
      </header>
      {active.length ? (
        <div className="space-y-8">
          {groups.map(({ type, label }) => {
            const items = active.filter((follow) => follow.targetType === type);
            if (!items.length) return null;
            return (
              <section key={type} className="space-y-3" aria-labelledby={`following-${type}`}>
                <h2 id={`following-${type}`} className="text-xl font-semibold">
                  {label}
                </h2>
                <ul className="divide-y divide-border/60 border-y border-border/60">
                  {items.map((follow) => (
                    <li
                      key={`${follow.targetType}:${follow.targetId}`}
                      className="flex flex-wrap items-center justify-between gap-4 py-4"
                    >
                      <div className="space-y-1">
                        <p className="flex flex-wrap items-baseline gap-2">
                          <FollowTarget follow={follow} />
                        </p>
                        {follow.reason === 'library' ? <p>{m.library_follow_reason_library()}</p> : null}
                        {follow.reason === 'membership' ? <p>{m.library_follow_reason_membership()}</p> : null}
                      </div>
                      <form method="post" onSubmit={(event) => void submit(event, follow)}>
                        <input type="hidden" name="idempotency_key" value={follow.idempotencyKey} />
                        <button
                          type="submit"
                          disabled={pending === follow.targetId}
                          className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary hover:bg-muted disabled:opacity-50"
                        >
                          {m.library_follow_unfollow()}
                        </button>
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
