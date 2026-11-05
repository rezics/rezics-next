import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  cancelBulkOperationRecovery,
  captureBulkOperationCancel,
  readBulkOperationRecovery,
  readBulkOperationRecoveryPage,
} from '../../../library/bulk-operation-recovery-server';
import {
  appendBulkOutcomePage,
  BulkOutcomeWindows,
  canCancelBulkOperation,
  isCurrentBulkRecoveryAddress,
  type LibraryBulkCancelIntent,
  type LibraryBulkRecoveryRead,
} from '../../../library/bulk-operation-recovery';
import { LibraryBulkOperationRecoveryView } from '../../../library/bulk-operation-recovery-view';
import { usePrivateReportOrigin } from '../../../library/private-report-current-origin';
import { prepareExposure } from '../../../kernel/exposure';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { requireSignedIn } from '../../../session/guard';

function addressOperationId(pathname: string): string | undefined {
  const segment = pathname.match(/\/library\/operations\/([^/]+)\/?$/)?.[1];
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function addressPath(href: string): string {
  try {
    return new URL(href, 'https://rezics.invalid').pathname;
  } catch {
    return href;
  }
}

function RecoveryReader({
  operationId,
  pathname,
  requestedId,
}: {
  operationId: string;
  pathname: string;
  requestedId: string | undefined;
}) {
  const { origin, value, hydrated } = usePrivateReportOrigin(pathname, getLocale(), addressPath, false);
  const ownerKey = JSON.stringify([
    pathname,
    operationId,
    value.owner,
    value.mount,
    value.observation?.id,
    value.versions[0],
    value.csrfToken,
    getLocale(),
  ]);
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [read, setRead] = useState<LibraryBulkRecoveryRead>({ state: 'unavailable', operationId });
  const [readOwner, setReadOwner] = useState('');
  const [readBusy, setReadBusy] = useState(false);
  const [cancelState, setCancelState] = useState<
    'idle' | 'capturing' | 'pending' | 'uncertain' | 'refused' | 'accepted'
  >('idle');
  const [cancelOwner, setCancelOwner] = useState('');
  const [cancelIntent, setCancelIntent] = useState<LibraryBulkCancelIntent | null>(null);
  const [cancelCsrf, setCancelCsrf] = useState<string | null>(null);
  const readRef = useRef(read);
  const readOwnerRef = useRef(readOwner);
  const live = useRef(true);
  const busy = useRef(false);
  const readSequence = useRef(0);
  const firstReadStarted = useRef('');
  const windows = useRef(new BulkOutcomeWindows());
  const [readFailed, setReadFailed] = useState(false);
  const uncertainIntent = useRef<LibraryBulkCancelIntent | null>(null);
  const currentLease = origin.capture('personal_library');
  const authorized = hydrated && currentLease();
  const visibleRead = readOwner === ownerKey ? read : { state: 'unavailable' as const, operationId };
  const visibleCancelState = cancelOwner === ownerKey ? cancelState : 'idle';

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const version = () => JSON.stringify([origin.version('personal_library'), origin.read().csrfToken]);
    let admitted = version();
    return origin.watch(() => {
      const next = version();
      if (next === admitted) return;
      admitted = next;
      windows.current = new BulkOutcomeWindows();
      busy.current = false;
      readSequence.current++;
      setReadBusy(false);
      readRef.current = { state: 'unavailable', operationId };
      readOwnerRef.current = '';
      firstReadStarted.current = '';
      uncertainIntent.current = null;
      setReadOwner('');
      setCancelIntent(null);
      setCancelCsrf(null);
      setCancelOwner('');
      setCancelState('idle');
      setReadFailed(false);
    });
  }, [origin, operationId]);

  function addressCurrent(path: string, owner: string, lease: () => boolean): boolean {
    return (
      live.current &&
      pathname === path &&
      ownerKeyRef.current === owner &&
      isCurrentBulkRecoveryAddress(requestedId ?? '', operationId, lease())
    );
  }

  function current(path: string, owner: string, lease: () => boolean): boolean {
    return (
      addressCurrent(path, owner, lease) &&
      readOwnerRef.current === owner &&
      readRef.current.state === 'available' &&
      readRef.current.operation.id === operationId
    );
  }

  function updateRead(next: LibraryBulkRecoveryRead, owner: string) {
    readRef.current = next;
    readOwnerRef.current = owner;
    setRead(next);
    setReadOwner(owner);
  }

  async function readWindow(
    kind: 'next' | 'previous' | 'first' | 'refresh' | 'retry',
    id = operationId,
    cursor?: string,
  ) {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    if (!addressCurrent(pathname, owner, lease) || id !== operationId || busy.current) return;
    const sequence = ++readSequence.current;
    const path = windows.current;
    const previous = readRef.current;
    if (kind === 'next' && (previous.state !== 'available' || previous.next !== cursor)) return;
    if (kind === 'previous' && !path.predecessors.length) return;
    const target = kind === 'retry' ? path.target : path.stage(kind, cursor);
    if (!target) return;
    if (kind === 'first') firstReadStarted.current = owner;
    busy.current = true;
    setReadBusy(true);
    setReadFailed(false);
    try {
      // Refresh includes the bounded operation read so progress and deadlines remain native facts.
      const result =
        target.kind === 'first' || target.kind === 'refresh'
          ? await readBulkOperationRecovery({
              data: { operationId: id, ...(target.cursor === undefined ? {} : { cursor: target.cursor }) },
            })
          : await readBulkOperationRecoveryPage({
              data: { operationId: id, ...(target.cursor === undefined ? {} : { cursor: target.cursor }) },
            });
      if (!addressCurrent(pathname, owner, lease) || windows.current !== path || path.target !== target) return;
      if (result.state === 'available') {
        const accepted = previous as Extract<LibraryBulkRecoveryRead, { state: 'available' }>;
        const next =
          'operation' in result
            ? result
            : target.kind === 'next'
              ? appendBulkOutcomePage({
                  addressOperationId: requestedId ?? '',
                  authorized: lease(),
                  requestedOperationId: id,
                  requestedCursor: target.cursor!,
                  current: accepted,
                  page: result.page,
                })
              : { ...accepted, outcomes: result.page.outcomes, next: result.page.next };
        path.commit(target);
        updateRead(next, owner);
      } else if (result.state === 'invalid' && target.cursor !== undefined) {
        // Native cursor retirement is the only automatic path restart.
        windows.current = new BulkOutcomeWindows();
        busy.current = false;
        await readWindow('first');
      } else if (result.state === 'unavailable') {
        // Keep the accepted DTO and exact staged target independently of an uncertain command.
        setReadFailed(true);
      } else {
        windows.current = new BulkOutcomeWindows();
        updateRead({ state: result.state, operationId: id }, owner);
        if (result.state === 'forbidden') {
          uncertainIntent.current = null;
          setCancelIntent(null);
          setCancelCsrf(null);
          setCancelOwner('');
          setCancelState('idle');
        }
      }
    } catch {
      if (addressCurrent(pathname, owner, lease) && windows.current === path) setReadFailed(true);
    } finally {
      if (readSequence.current === sequence) {
        busy.current = false;
        if (live.current) setReadBusy(false);
      }
    }
  }

  async function sendCancel(intent: LibraryBulkCancelIntent, csrfToken: string, owner: string, lease: () => boolean) {
    if (!current(pathname, owner, lease) || intent.operationId !== operationId || busy.current) return;
    busy.current = true;
    setCancelState('pending');
    setCancelOwner(owner);
    try {
      const result = await cancelBulkOperationRecovery({
        data: { operationId, capture: intent.capture },
        headers: { 'X-CSRF-Token': csrfToken },
      }).catch(() => null);
      if (!result) {
        if (current(pathname, owner, lease)) {
          uncertainIntent.current = intent;
          setCancelIntent(intent);
          setCancelCsrf(csrfToken);
          setCancelState('uncertain');
          setCancelOwner(owner);
        }
        return;
      }
      if (!current(pathname, owner, lease)) return;
      if (result.state === 'accepted') {
        if (result.operation.id !== operationId) {
          updateRead({ state: 'unavailable', operationId }, owner);
          setCancelState('refused');
          uncertainIntent.current = null;
          setCancelIntent(null);
          setCancelCsrf(null);
          return;
        }
        const existing = readRef.current;
        if (existing.state === 'available') updateRead({ ...existing, operation: result.operation }, owner);
        uncertainIntent.current = null;
        setCancelIntent(null);
        setCancelCsrf(null);
        setCancelState('accepted');
        setCancelOwner(owner);
      } else if (result.state === 'uncertain') {
        uncertainIntent.current = intent;
        setCancelIntent(intent);
        setCancelCsrf(csrfToken);
        setCancelState('uncertain');
        setCancelOwner(owner);
      } else if (result.state === 'forbidden') {
        updateRead({ state: 'forbidden', operationId }, owner);
        uncertainIntent.current = null;
        setCancelIntent(null);
        setCancelCsrf(null);
        setCancelOwner('');
        setCancelState('idle');
      } else if (result.state === 'unavailable') {
        updateRead({ state: 'unavailable', operationId }, owner);
        uncertainIntent.current = null;
        setCancelIntent(null);
        setCancelCsrf(null);
        setCancelOwner('');
        setCancelState('idle');
      } else {
        uncertainIntent.current = null;
        setCancelIntent(null);
        setCancelCsrf(null);
        setCancelState('refused');
        setCancelOwner(owner);
      }
    } finally {
      if (addressCurrent(pathname, owner, lease)) {
        busy.current = false;
        setReadBusy(false);
      }
    }
  }

  async function cancel() {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    const csrfToken = value.csrfToken;
    const currentRead = readRef.current;
    if (
      !current(pathname, owner, lease) ||
      currentRead.state !== 'available' ||
      !canCancelBulkOperation(currentRead.operation) ||
      !csrfToken ||
      busy.current
    )
      return;
    busy.current = true;
    setCancelState('capturing');
    setCancelOwner(owner);
    try {
      const captured = await captureBulkOperationCancel({
        data: { operationId },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!current(pathname, owner, lease)) return;
      if (captured.state !== 'ready') {
        if (captured.state === 'forbidden') {
          updateRead({ state: 'forbidden', operationId }, owner);
          setCancelState('idle');
          setCancelOwner('');
        } else {
          setCancelState('refused');
          setCancelOwner(owner);
        }
        return;
      }
      if (captured.csrfToken !== csrfToken) {
        setCancelState('refused');
        setCancelOwner(owner);
        return;
      }
      setCancelIntent(captured.intent);
      setCancelCsrf(captured.csrfToken);
      busy.current = false;
      await sendCancel(captured.intent, captured.csrfToken, owner, lease);
    } catch {
      if (current(pathname, owner, lease)) {
        setCancelState('refused');
        setCancelOwner(owner);
      }
    } finally {
      if (addressCurrent(pathname, owner, lease)) {
        busy.current = false;
        setReadBusy(false);
      }
    }
  }

  function retryCancel() {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    if (cancelOwner !== owner || !cancelIntent || !cancelCsrf) return;
    void sendCancel(cancelIntent, cancelCsrf, owner, lease);
  }

  useEffect(() => {
    if (authorized && firstReadStarted.current !== ownerKey) {
      windows.current = new BulkOutcomeWindows();
      void readWindow('first');
    }
  }, [authorized, operationId, ownerKey, readBusy]);

  if (
    requestedId !== operationId ||
    !hydrated ||
    value.state === 'unknown' ||
    (value.state === 'signed-in' && !value.authority && !value.unavailable)
  )
    return <p role="status">{m.library_bulk_recovery_address_pending()}</p>;

  return (
    <LibraryBulkOperationRecoveryView
      focusOwner={ownerKey}
      addressOperationId={operationId}
      authorized={authorized}
      read={visibleRead}
      readAgain={() => void readWindow('refresh')}
      readRetry={() => void readWindow('retry')}
      readFailed={readFailed}
      previous={windows.current.predecessors.length > 0 ? () => void readWindow('previous') : undefined}
      first={windows.current.cursor !== undefined ? () => void readWindow('first') : undefined}
      readMore={(id, cursor) => void readWindow('next', id, cursor)}
      cancel={() => void cancel()}
      retryCancel={retryCancel}
      cancelState={visibleCancelState}
      cancelAvailable={authorized && value.csrfToken !== ''}
      busy={readBusy || visibleCancelState === 'capturing' || visibleCancelState === 'pending'}
    />
  );
}

export const Route = createFileRoute('/library/operations/$id')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  staleTime: 0,
  head: ({ match }) =>
    pageHead(
      { title: m.library_bulk_recovery_heading(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: function LibraryBulkOperationRoute() {
    const { id } = Route.useParams();
    const location = useLocation();
    const requestedId = addressOperationId(location.pathname);
    return (
      <RecoveryReader key={location.pathname} operationId={id} pathname={location.pathname} requestedId={requestedId} />
    );
  },
});
