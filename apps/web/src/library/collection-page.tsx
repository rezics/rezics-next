import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { AccountRef } from './account-ref';
import type { CollectionPageData, CollectionVisibility } from './reads';
import { SubjectRef } from './subject-ref';

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

export function CollectionPage({ page }: { page: CollectionPageData }) {
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{page.title}</h1>
        {page.description !== null ? <p className="whitespace-pre-wrap">{page.description}</p> : null}
        <p>
          {m.library_curator()} <AccountRef account={page.curator} />
        </p>
        <p>{m.library_member_count({ count: page.memberCount })}</p>
        <p>
          {m.library_collection_updated()} <time {...{ datetime: page.updatedAt }}>{page.updatedAt}</time>
        </p>
        {page.visibility ? <p data-visibility={page.visibility}>{visibilityLabel(page.visibility)}</p> : null}
      </header>
      <section className="space-y-4" aria-labelledby="collection-members-heading">
        <h2 id="collection-members-heading" className="text-xl font-semibold">
          {m.library_collection_members()}
        </h2>
        {page.members.length ? (
          <ol className="divide-y divide-border/60 border-y border-border/60">
            {page.members.map((member) => (
              <li key={member.id} className="space-y-2 py-4">
                <p className="flex flex-wrap items-baseline gap-2">
                  <SubjectRef subject={member.subject} />
                </p>
                {member.note ? <p className="whitespace-pre-wrap">{member.note}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.library_collection_empty()}</p>
        )}
        {page.next ? (
          <nav aria-label={m.library_collection_members()}>
            <Link
              to="/collections/$id"
              params={{ id: page.id }}
              search={{ cursor: page.next }}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.library_collection_more()}
            </Link>
          </nav>
        ) : null}
      </section>
    </article>
  );
}
