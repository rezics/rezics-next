import { useMemo } from 'react';
import { ownDraftBrowserWritingReader } from './own-drafts/browser-writing';
import { ownDraftNativeReader } from './own-drafts/native-reader';
import { OwnDraftsPage } from './own-drafts/page';
import { ownDraftNativeCommandTransport, useOwnDraftVisit, type OwnDraftCommandTransport } from './own-drafts/visit';
import type { OwnDraftLocalWritingReader, OwnDraftReader } from './own-drafts/model';

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
