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
  const firstReadStarted = useRef(false);
  const uncertainIntent = useRef<LibraryBulkCancelIntent | null>(null);
  const currentLease = origin.capture('personal_library');
  const authorized = hydrated && currentLease();
  const visibleRead = readOwner === ownerKey ? read : { state: 'unavailable' as const, operationId };
  const visibleCancelState = cancelOwner === ownerKey ? cancelState : 'idle';

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

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

  async function readAgain(id: string) {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    if (!addressCurrent(pathname, owner, lease) || id !== operationId || busy.current) return;
    busy.current = true;
    setReadBusy(true);
    try {
      const next = await readBulkOperationRecovery({ data: { operationId: id } });
      if (!addressCurrent(pathname, owner, lease)) return;
      updateRead(next, owner);
      if (next.state === 'forbidden') {
        uncertainIntent.current = null;
        setCancelIntent(null);
        setCancelCsrf(null);
        setCancelOwner('');
        setCancelState('idle');
      }
    } catch {
      if (addressCurrent(pathname, owner, lease)) updateRead({ state: 'unavailable', operationId: id }, owner);
    } finally {
      busy.current = false;
      if (live.current) setReadBusy(false);
    }
  }

  async function readMore(id: string, cursor: string) {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    const previous = readRef.current;
    if (
      !current(pathname, owner, lease) ||
      id !== operationId ||
      previous.state !== 'available' ||
      previous.next !== cursor ||
      busy.current
    )
      return;
    busy.current = true;
    setReadBusy(true);
    try {
      const result = await readBulkOperationRecoveryPage({ data: { operationId: id, cursor } });
      if (!current(pathname, owner, lease)) return;
      if (result.state === 'available') {
        updateRead(
          appendBulkOutcomePage({
            addressOperationId: requestedId ?? '',
            authorized: lease(),
            requestedOperationId: id,
            requestedCursor: cursor,
            current: readRef.current,
            page: result.page,
          }),
          owner,
        );
      } else {
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
      if (current(pathname, owner, lease)) updateRead({ state: 'unavailable', operationId: id }, owner);
    } finally {
      busy.current = false;
      if (live.current) setReadBusy(false);
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
      busy.current = false;
      if (live.current) setReadBusy(false);
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
      busy.current = false;
      if (live.current) setReadBusy(false);
    }
  }

  function retryCancel() {
    const owner = ownerKey;
    const lease = origin.capture('personal_library');
    if (cancelOwner !== owner || !cancelIntent || !cancelCsrf) return;
    void sendCancel(cancelIntent, cancelCsrf, owner, lease);
  }

  useEffect(() => {
    if (authorized && !firstReadStarted.current) {
      firstReadStarted.current = true;
      void readAgain(operationId);
    }
  }, [authorized, operationId]);

  if (
    requestedId !== operationId ||
    !hydrated ||
    value.state === 'unknown' ||
    (value.state === 'signed-in' && !value.authority && !value.unavailable)
  )
    return <p role="status">{m.library_bulk_recovery_address_pending()}</p>;

  return (
    <LibraryBulkOperationRecoveryView
      addressOperationId={operationId}
      authorized={authorized}
      read={visibleRead}
      readAgain={(id) => void readAgain(id)}
      readMore={(id, cursor) => void readMore(id, cursor)}
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
