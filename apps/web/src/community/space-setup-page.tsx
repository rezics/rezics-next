import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { changeSpaceSetup, readSpaceSetup, resolveSpaceSetupChoice } from './space-actions';
import { SpaceSetupForm, type SetupTransport } from './space-setup-form';
import type { SetupSnapshot, SetupFailure } from './space-setup';

export function SpaceSetupPage({
  initial,
  spaceId,
}: {
  initial: SetupSnapshot | SetupFailure;
  spaceId?: string | undefined;
}) {
  const { csrfToken } = useSession();
  const transport: SetupTransport = {
    command: (data) =>
      csrfToken
        ? changeSpaceSetup({ data, headers: { 'X-CSRF-Token': csrfToken } })
        : Promise.resolve({ kind: 'failure', reason: 'denied', status: 401 }),
    read: (id) => readSpaceSetup({ data: (id ?? spaceId) ? { spaceId: id ?? spaceId } : {} }),
    choice: (kind, id) => resolveSpaceSetupChoice({ data: { kind, id } }),
  };
  return (
    <article className="mx-auto max-w-5xl space-y-6 text-foreground">
      <PageHeading>{m.space_setup_heading()}</PageHeading>
      <SpaceSetupForm initial={initial} transport={transport} />
    </article>
  );
}

/** The existing home keeps its membership, following, boards and publication regions. */
export function SpaceSetupEntry({ spaceId }: { spaceId: string }) {
  const { state } = useSession();
  const { data } = useQuery({
    queryKey: ['space-setup-entry', spaceId],
    queryFn: () => readSpaceSetup({ data: { spaceId } }),
    enabled: personalRead.enabled && state === 'signed-in',
    staleTime: 0,
    retry: false,
  });
  if (state !== 'signed-in' || data?.kind !== 'ready' || !Object.values(data.permitted).some(Boolean)) return null;
  return (
    <Link
      to="/realms/new"
      search={{ spaceId }}
      className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
    >
      {m.space_setup_entry()}
    </Link>
  );
}
