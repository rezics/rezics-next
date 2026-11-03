import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import {
  MAL_UPLOAD_BYTES,
  newCommandKey,
  type MalApplyPage,
  type MalCommand,
  type MalFailure,
  type MalPage,
  type MalUnknown,
} from './contract';
import { MalConfirmPage } from './confirm';
import { MalAction } from './controls';
import { MalDeparture } from './departure';
import { malFailureLabel } from './meaning';
import { useMalImportPort } from './port';
import { MalResultPage } from './results';
import { MalReviewPage } from './review';
import type { RowDraft } from './row';
import { MalUploadForm } from './upload';
import { useMalVisit, type MalVisit } from './visit';

type Stage = 'upload' | 'review' | 'confirm' | 'results';
type Notice = MalFailure | MalUnknown | { kind: 'too-large' } | null;

function noticeText(notice: Notice): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_mal_uncertain();
  if (notice.kind === 'too-large') return m.library_mal_too_large();
  return malFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

export function PersonalMalImportPage({ visit }: { visit?: MalVisit | null }) {
  const observed = useMalVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.put');
  if (!current) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6">
        <PageHeading>{m.library_mal_title()}</PageHeading>
        <p role="status">{m.library_mal_sign_in()}</p>
      </main>
    );
  }
  return <MalImportSession key={`${current.subject}:${current.csrfToken}`} visit={current} />;
}

function MalImportSession({ visit }: { visit: MalVisit }) {
  const port = useMalImportPort();
  const [stage, setStage] = useState<Stage>('upload');
  const [page, setPage] = useState<MalPage | null>(null);
  const [after, setAfter] = useState(0);
  const [result, setResult] = useState<MalApplyPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const unknown = useRef<MalCommand | null>(null);
  const sender = useRef({ subject: visit.subject, csrfToken: visit.csrfToken });
  const titles = useRef(new Map<number, string>());
  const applyCommand = useRef<Extract<MalCommand, { kind: 'apply' }> | null>(null);
  const uploadId = useRef<string | null>(null);

  useEffect(() => () => visit.retire(), [visit]);

  function live() {
    return visit.current() && sender.current.subject === visit.subject && sender.current.csrfToken === visit.csrfToken;
  }

  function resetPrivate() {
    unknown.current = null;
    applyCommand.current = null;
    uploadId.current = null;
    titles.current = new Map();
    setPage(null);
    setAfter(0);
    setResult(null);
    setStage('upload');
    setNotice(null);
  }

  async function run<T extends { kind: string }>(
    command: MalCommand,
    send: () => Promise<T | MalFailure | MalUnknown>,
  ) {
    if (!live() || busy) return;
    setBusy(true);
    const response = await send();
    if (!live()) return;
    setBusy(false);
    if (response.kind === 'unknown') {
      const lost = response as MalUnknown;
      unknown.current = lost.command;
      setNotice(lost);
      return;
    }
    unknown.current = null;
    if (
      response.kind === 'previewed' ||
      response.kind === 'page' ||
      response.kind === 'reviewed' ||
      response.kind === 'applied' ||
      response.kind === 'done'
    ) {
      setNotice(null);
      return response;
    }
    setNotice(response as MalFailure);
    return;
  }

  async function loadPage(id: string, cursor: number) {
    const response = await run({ kind: 'page', id, after: cursor }, () =>
      port.page({ kind: 'page', id, after: cursor }),
    );
    if (!response || response.kind !== 'page' || !live()) return;
    for (const row of response.page.rows) titles.current.set(row.index, row.title);
    setPage(response.page);
    setAfter(cursor);
    setStage('review');
  }

  async function upload(xml: string) {
    if (!xml) {
      setNotice({ kind: 'too-large' });
      return;
    }
    if (new TextEncoder().encode(xml).length > MAL_UPLOAD_BYTES) {
      setNotice({ kind: 'too-large' });
      return;
    }
    const previous = uploadId.current;
    if (previous) {
      await port.delete({ kind: 'delete', id: previous, key: newCommandKey() });
      if (!live()) return;
      resetPrivate();
    }
    const command: Extract<MalCommand, { kind: 'preview' }> = { kind: 'preview', key: newCommandKey(), xml };
    const response = await run(command, () => port.preview(command));
    if (!response || response.kind !== 'previewed' || !live()) return;
    uploadId.current = response.id;
    await loadPage(response.id, 0);
  }

  async function saveReview(draft: RowDraft) {
    const id = uploadId.current;
    if (!id || !page) return;
    const command: Extract<MalCommand, { kind: 'review' }> = {
      kind: 'review',
      key: newCommandKey(),
      id,
      input: { row: draft.row, target: draft.target, skip: draft.skip, replace: draft.replace },
    };
    const response = await run(command, () => port.review(command));
    if (!response || response.kind !== 'reviewed' || !live()) return;
    await loadPage(id, after);
  }

  async function confirm() {
    const id = uploadId.current;
    if (!id || !page) return;
    const rows = page.rows.flatMap((row) => {
      const review = row.review;
      if (!review) return [];
      return [{ row: row.index, version: review.version, fields: review.skip ? [] : draftFields(row) }];
    });
    if (!rows.length) return;
    const command: Extract<MalCommand, { kind: 'apply' }> = { kind: 'apply', id, body: { confirm: true, rows } };
    applyCommand.current = command;
    const response = await run(command, () => port.apply(command));
    if (!response || response.kind !== 'applied' || !live()) return;
    setResult(response.result);
    setStage('results');
  }

  async function retryUnknown() {
    const command = unknown.current;
    if (!command || !live()) return;
    if (command.kind === 'preview') await upload(command.xml);
    else if (command.kind === 'page') await loadPage(command.id, command.after);
    else if (command.kind === 'review') {
      const response = await run(command, () => port.review(command));
      if (response?.kind === 'reviewed' && uploadId.current) await loadPage(uploadId.current, after);
    } else if (command.kind === 'apply') {
      applyCommand.current = command;
      const response = await run(command, () => port.apply(command));
      if (response?.kind === 'applied') {
        setResult(response.result);
        setStage('results');
      }
    } else if (command.kind === 'cancel') {
      await run(command, () => port.cancel(command));
    } else {
      await run(command, () => port.delete(command));
    }
  }

  async function discard() {
    const id = uploadId.current;
    if (id) await port.delete({ kind: 'delete', id, key: newCommandKey() });
    if (live()) resetPrivate();
  }

  const locked = busy || notice?.kind === 'unknown';
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_mal_title()}</PageHeading>
      {noticeText(notice) ? <p role="status">{noticeText(notice)}</p> : null}
      {notice?.kind === 'unknown' ? (
        <MalAction type="button" disabled={busy} onClick={() => void retryUnknown()}>
          {m.library_mal_retry_command()}
        </MalAction>
      ) : null}
      {stage === 'upload' ? <MalUploadForm busy={busy} onUpload={(xml) => void upload(xml)} /> : null}
      {stage === 'review' && page ? (
        <MalReviewPage
          page={page}
          after={after}
          busy={busy}
          onSave={(draft) => void saveReview(draft)}
          onNext={() => page.next !== null && uploadId.current && void loadPage(uploadId.current, page.next)}
          onConfirm={() => setStage('confirm')}
        />
      ) : null}
      {stage === 'confirm' && page ? (
        <MalConfirmPage
          rows={page.rows}
          busy={busy}
          onBack={() => setStage('review')}
          onConfirm={() => void confirm()}
        />
      ) : null}
      {stage === 'results' && result ? (
        <MalResultPage
          result={result}
          titles={titles.current}
          busy={busy}
          canRetry={!!applyCommand.current && result.outcomes.some((item) => item.status === 'failed')}
          onRetry={() => {
            const command = applyCommand.current;
            if (!command) return;
            void run(command, () => port.apply(command)).then((response) => {
              if (response?.kind === 'applied' && live()) setResult(response.result);
            });
          }}
          onReview={() => setStage('review')}
          onRefresh={() => uploadId.current && void loadPage(uploadId.current, after)}
        />
      ) : null}
      {uploadId.current ? (
        <MalAction type="button" variant="outline" disabled={locked} onClick={() => void discard()}>
          {m.library_mal_discard()}
        </MalAction>
      ) : null}
      <MalDeparture active={!!uploadId.current} locked={locked} onDiscard={() => void discard()} />
    </main>
  );
}

function draftFields(row: NonNullable<MalPage['rows'][number]>): string[] {
  return row.review?.skip || !row.state ? [] : ['status'];
}
