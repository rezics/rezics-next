import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { editionCreateHref, type EditionSourceIdentity } from './edition-create';
import { readEditionCreateEntry } from './edition-create-actions';

/** Distinct from immutable provenance and private vote comparison in the existing reader. */
export function EditionCreateEntry({ identity }: { identity: EditionSourceIdentity }) {
  const session = useSession();
  const { data, isPending, isError, isSuccess, fetchStatus, refetch } = useQuery({
    queryKey: ['edition-create-entry', identity.postId, identity.revisionId, session.subject, session.state],
    queryFn: () => readEditionCreateEntry({ data: identity }),
    enabled: session.state === 'signed-in',
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (session.state !== 'signed-in' || isPending || data?.kind === 'refused') return null;
  return (
    <section
      className="mt-8 w-full max-w-3xl space-y-3 border-t border-border pt-6"
      aria-label={m.edition_publication_entry_heading()}
    >
      <h2 className="text-lg font-semibold">{m.edition_publication_entry_heading()}</h2>
      {isSuccess && fetchStatus === 'idle' && data?.kind === 'available' ? (
        <>
          <p className="text-sm text-muted-foreground">{m.edition_publication_entry_help()}</p>
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            href={editionCreateHref(identity, getLocale())}
          >
            {m.edition_publication_entry_action()}
          </a>
        </>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {m.edition_publication_unavailable()}
          </p>
          {(isError || data?.kind === 'unavailable') && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={fetchStatus !== 'idle'}
              onClick={() => void refetch({ cancelRefetch: false })}
            >
              {m.edition_publication_retry()}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
