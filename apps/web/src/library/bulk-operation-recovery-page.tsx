import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { usePrivateReportOrigin } from './private-report-current-origin';
import { BulkOperationRecovery, type RecoveryState } from './bulk-operation-recovery';
import { readBulkOperation, cancelBulkOperation } from './bulk-operation-recovery-server';
import type { BulkOperation } from './bulk-operation-recovery-native';

function addressed(href: string) {
  const url = new URL(href, 'https://site.invalid');
  return url.pathname + url.search;
}

export function BulkOperationPage({ id, href }: { id: string; href: string }) {
  const { origin, value, hydrated } = usePrivateReportOrigin(addressed(href), getLocale(), addressed, false);
  return <OperationReader key={value.owner} id={id} origin={origin} hydrated={hydrated} />;
}

function OperationReader({ id, origin, hydrated }: {
  id: string;
  origin: ReturnType<typeof usePrivateReportOrigin>['origin'];
  hydrated: boolean;
}) {
  const model = useRef<BulkOperationRecovery | null>(null);
  const attempted = useRef(false);
  const [visible, setVisible] = useState<{ version: string; state: RecoveryState }>();
  const current = () => hydrated && origin.capture('personal_library')();
  const version = origin.version('personal_library');
  useEffect(() => {
    const viewer = origin.read().subject;
    if (!viewer) return;
    const owner = origin.read().owner;
    const mount = origin.read().mount;
    const owned = () => current() && origin.read().owner === owner && origin.read().mount === mount;
    attempted.current = false;
    const reader = new BulkOperationRecovery({ id, viewer }, {
      current: owned,
      capture: () => origin.capture('personal_library'),
      csrf: () => origin.read().csrfToken,
    }, {
      read: (address) => readBulkOperation({ data: address }),
      cancel: (command) => cancelBulkOperation({ data: command, headers: { 'X-CSRF-Token': command.csrf } }),
    }, () => setVisible({ version: origin.version('personal_library'), state: reader.state }));
    model.current = reader;
    return () => { reader.retire(); model.current = null; };
  }, [id, origin, hydrated]);
  useEffect(() => {
    if (!attempted.current && current() && model.current) {
      attempted.current = true;
      void model.current.read();
    }
  }, [version, hydrated]);
  const allowed = current();
  const state = allowed && visible?.version === version ? visible.state : undefined;
  const cancellation = model.current?.state.cancel;
  const operation = state?.read === 'ready' ? state.operation : undefined;
  const cancellable = operation && !operation.cancelRequested &&
    !['completed', 'completed_with_errors', 'cancelled', 'stopped', 'expired'].includes(operation.phase);
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
    <h1 className="text-2xl font-semibold">{m.bulk_operation_title()}</h1>
    <p role="status">{!allowed ? m.bulk_operation_forbidden() :
      !state ? m.bulk_operation_recover_needed() :
      state.read === 'loading' ? m.bulk_operation_loading() :
      state.read === 'ready' ? '' : readMessage(state.read)}</p>
    <button type="button" className="min-h-11 underline" disabled={!allowed || state?.read === 'loading'}
      onClick={() => void model.current?.read()}>{m.bulk_operation_recover()}</button>
    {operation && <>
      <OperationDetails operation={operation} />
      <section aria-label={m.bulk_operation_results()} className="space-y-3">
        <h2 className="text-xl font-semibold">{m.bulk_operation_results()}</h2>
        {state?.page?.outcomes.length === 0 && <p>{operation.phase === 'completed' || operation.phase === 'completed_with_errors'
          ? m.bulk_operation_empty_completed() : m.bulk_operation_empty_page()}</p>}
        <ul className="space-y-3">{state?.page?.outcomes.map((outcome) => <li key={outcome.ordinal}>
          <code>{outcome.subjectId}</code>{' · '}{m.bulk_operation_value({ value: outcome.state })}
          {outcome.reason && <> · {m.bulk_operation_value({ value: outcome.reason })}</>}
          {outcome.memberId && <p>{m.bulk_operation_member({ id: outcome.memberId })}</p>}
          {outcome.resultingMemberId && <p>{m.bulk_operation_member({ id: outcome.resultingMemberId })}</p>}
        </li>)}</ul>
        {state?.page?.next && <button type="button" className="min-h-11 underline"
          onClick={() => void model.current?.more()}>{m.bulk_operation_more()}</button>}
      </section>
    </>}
    {allowed && <section className="space-y-3">
      <p>{m.bulk_operation_cancel_effect()}</p>
      {cancellable && !cancellation && <button type="button" className="min-h-11 underline"
        disabled={!origin.read().csrfToken} onClick={() => void model.current?.cancel()}>{m.bulk_operation_cancel()}</button>}
      {cancellation && <p role="status">{cancellation === 'sending' ? m.bulk_operation_cancelling() :
        cancellation === 'ready' ? m.bulk_operation_cancelled() : cancellation === 'uncertain'
          ? m.bulk_operation_uncertain() : readMessage(cancellation)}</p>}
      {cancellation === 'uncertain' && <button type="button" className="min-h-11 underline"
        disabled={!origin.read().csrfToken} onClick={() => void model.current?.cancel(true)}>{m.bulk_operation_retry_cancel()}</button>}
    </section>}
  </main>;
}

function readMessage(state: string) {
  return state === 'forbidden' ? m.bulk_operation_forbidden() : state === 'expired' ? m.bulk_operation_expired() :
    state === 'invalid' ? m.bulk_operation_invalid() : m.bulk_operation_unavailable();
}

export function OperationDetails({ operation: op }: { operation: BulkOperation }) {
  return <dl className="space-y-2">
    <dt>{m.bulk_operation_identity()}</dt><dd><code>{op.id}</code></dd>
    <dt>{m.bulk_operation_action()}</dt><dd>{m.bulk_operation_value({ value: op.action })}{op.state && <> · {op.state}</>}</dd>
    {op.collectionId && <><dt>{m.bulk_operation_collection()}</dt><dd><code>{op.collectionId}</code></dd></>}
    <dt>{m.bulk_operation_phase()}</dt><dd>{m.bulk_operation_value({ value: op.phase })}{op.reason && <> · {op.reason}</>}</dd>
    <dt>{m.bulk_operation_targets()}</dt><dd>{op.counts.targets}</dd>
    <dt>{m.bulk_operation_progress()}</dt><dd>{m.bulk_operation_counts({
      applied: op.counts.applied, unchanged: op.counts.no_effect, pending: op.counts.pending,
      reconciling: op.counts.reconciling, failed: op.counts.failed + op.counts.denied + op.counts.conflict,
      cancelled: op.counts.cancelled,
    })}</dd>
    <dt>{m.bulk_operation_admitted()}</dt><dd><time dateTime={op.admittedAt}>{op.admittedAt}</time></dd>
    <dt>{m.bulk_operation_deadline()}</dt><dd><time dateTime={op.expiresAt}>{op.expiresAt}</time></dd>
    <dt>{m.bulk_operation_results_deadline()}</dt><dd><time dateTime={op.resultsExpireAt}>{op.resultsExpireAt}</time></dd>
    {op.finishedAt && <><dt>{m.bulk_operation_finished()}</dt><dd><time dateTime={op.finishedAt}>{op.finishedAt}</time></dd></>}
  </dl>;
}
