import { useEffect, useRef, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from '../threads/composer';
import { usePrivateReportOrigin } from './private-report-current-origin';
import { readBulkOperation } from './bulk-operation-recovery-server';
import { prepareBulkOperationUndo } from './bulk-operation-undo-server';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import { restorePersonalLibraryEntryAction } from './entries-actions';
import { BulkOperationUndo, type UndoAttempt, type UndoState } from './bulk-operation-undo';
import { BulkOperationUndoView } from './bulk-operation-undo-view';

function addressed(href: string) {
  const url = new URL(href, 'https://site.invalid');
  return url.pathname + url.search;
}

export function BulkOperationUndoPage({ id, href }: { id: string; href: string }) {
  const { origin, value, hydrated } = usePrivateReportOrigin(addressed(href), getLocale(), addressed, false);
  return <UndoReader key={value.owner} id={id} href={href} origin={origin} hydrated={hydrated} />;
}

function UndoReader({
  id,
  href,
  origin,
  hydrated,
}: {
  id: string;
  href: string;
  origin: ReturnType<typeof usePrivateReportOrigin>['origin'];
  hydrated: boolean;
}) {
  const model = useRef<BulkOperationUndo | null>(null);
  const attempted = useRef(false);
  const [visible, setVisible] = useState<{ version: string; state: UndoState }>();
  const current = () => hydrated && origin.capture('personal_library')();
  const restore = () => current() && origin.capture('library_entry.restore')();
  const version = origin.version('personal_library');
  const locale = getLocale();
  useEffect(() => {
    const viewer = origin.read().subject;
    if (!viewer) return;
    const { owner, mount } = origin.read();
    const owned = () => current() && origin.read().owner === owner && origin.read().mount === mount;
    attempted.current = false;
    const reader = new BulkOperationUndo(
      { id, viewer },
      {
        current: owned,
        capture: () => origin.capture('personal_library'),
        captureRestore: () => origin.capture('personal_library', 'library_entry.restore'),
        restore,
        csrf: () => origin.read().csrfToken,
        headers: () => new Headers(csrfHeaders()),
      },
      {
        read: async (address) => receiveUndoEvidence(await readBulkOperation({ data: address })),
        prepare: (target, headers) => prepareBulkOperationUndo({ data: target, headers }),
        sender: () => restorePersonalLibraryEntryAction,
      },
      () => setVisible({ version: origin.version('personal_library'), state: reader.state }),
    );
    model.current = reader;
    return () => {
      reader.retire();
      model.current = null;
    };
  }, [id, origin, hydrated]);
  useEffect(() => {
    if (!attempted.current && current() && model.current) {
      attempted.current = true;
      void model.current.read();
    }
  }, [version, hydrated]);
  const allowed = current();
  const state = allowed && visible?.version === version ? visible.state : undefined;
  const busy = model.current?.busy ?? false;
  const write = restore();

  return (
    <BulkOperationUndoView
      href={addressed(href)}
      authorized={allowed}
      state={state}
      busy={busy}
      writeAvailable={write}
      csrfToken={origin.read().csrfToken}
      attempts={model.current?.attempts ?? EMPTY_ATTEMPTS}
      locale={locale}
      onRead={() => void model.current?.read()}
      onMore={() => void model.current?.more()}
      onRestore={(ordinal, retry) => void model.current?.restore(ordinal, retry)}
    />
  );
}

const EMPTY_ATTEMPTS: ReadonlyMap<string, UndoAttempt> = new Map();
