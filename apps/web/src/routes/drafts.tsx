import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import {
  ownDraftBrowserWritingReader,
  ownDraftNativeCommandTransport,
  ownDraftNativeReader,
  OwnDraftsPage,
  useOwnDraftVisit,
} from '../threads';
import type { OwnDraftCommandTransport, OwnDraftLocalWritingReader, OwnDraftReader } from '../threads';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { requireSignedIn } from '../session/guard';

export const Route = createFileRoute('/drafts')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.own_drafts_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: DraftsRoute,
});

type DraftsRouteOverrides = Readonly<{
  reader?: OwnDraftReader;
  localWritingReader?: OwnDraftLocalWritingReader;
  transport?: OwnDraftCommandTransport;
}>;

/** Optional adapters keep the mounted route composition executable in focused Web fixtures. */
export function DraftsRoute({
  reader = ownDraftNativeReader,
  localWritingReader: suppliedLocalWritingReader,
  transport = ownDraftNativeCommandTransport,
}: DraftsRouteOverrides = {}) {
  const localWritingReader = useMemo(
    () => suppliedLocalWritingReader ?? ownDraftBrowserWritingReader(() => window.localStorage),
    [suppliedLocalWritingReader],
  );
  const visit = useOwnDraftVisit(reader, localWritingReader, transport);
  return (
    <OwnDraftsPage
      identity={visit.identity}
      active={visit.active}
      visitCurrent={visit.current}
      reader={visit.reader}
      localWritingReader={visit.localWritingReader}
      {...(visit.commands ? { commands: visit.commands } : {})}
    />
  );
}
