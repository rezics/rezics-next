import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { changeSpaceSetup, readSpaceSetup, resolveSpaceSetupChoice, searchSpaceSetupContexts } from './space-actions';
import { nativeContextChoiceSource } from './setup-context-native';
import { SpaceSetupForm, type SetupTransport } from './space-setup-form';
import type { SetupSnapshot, SetupFailure } from './space-setup';

export function SpaceSetupPage({
  initial,
  spaceId,
}: {
  initial: SetupSnapshot | SetupFailure;
  spaceId?: string | undefined;
}) {
  const { csrfToken, state, subject } = useSession();
  const locale = getLocale();
  const transport = useMemo<SetupTransport>(
    () => ({
      contexts: nativeContextChoiceSource(
        ({ query, cursor, signal }) =>
          state === 'signed-in'
            ? searchSpaceSetupContexts({
                data: { query, ...(cursor !== undefined ? { cursor } : {}) },
                ...(signal ? { signal } : {}),
              })
            : Promise.resolve({ kind: 'denied' }),
        (id) =>
          state === 'signed-in'
            ? resolveSpaceSetupChoice({ data: { kind: 'context', id } })
            : Promise.resolve({ kind: 'failure', reason: 'denied', status: 401 }),
        locale,
      ),
      command: (data) =>
        csrfToken
          ? changeSpaceSetup({ data, headers: { 'X-CSRF-Token': csrfToken } })
          : Promise.resolve({ kind: 'failure', reason: 'denied', status: 401 }),
      read: (id) => readSpaceSetup({ data: (id ?? spaceId) ? { spaceId: id ?? spaceId } : {} }),
      choice: (kind, id) => resolveSpaceSetupChoice({ data: { kind, id } }),
    }),
    // A changed viewer or locale gets a fresh picker; disposed requests cannot publish earlier labels.
    [csrfToken, state, subject, locale, spaceId],
  );
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
