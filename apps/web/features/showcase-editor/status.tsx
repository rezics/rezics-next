import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Spinner } from '@rezics/ui/spinner';
import { CircleCheckIcon, HourglassIcon, RefreshCwIcon, ShieldAlertIcon, TriangleAlertIcon } from 'lucide-react';
import type { Size } from './frame.ts';
import type { FileProblem } from './image-file.ts';
import type { EditorCopy } from './messages.ts';
import type { Refusal } from './refusal.ts';
import type { Uploaded, UploadStage } from './upload.ts';

/** Where one slot's last action stands, in the terms the person can act on. */
export type SlotStatus =
  | { kind: 'busy'; stage: UploadStage | 'saving' }
  /** The chosen file was refused before any upload. */
  | { kind: 'file'; problem: FileProblem | 'small'; size?: Size; min?: Size }
  | { kind: 'upload'; reason: Extract<Uploaded, { status: 'refused' }>['reason']; retryAfter?: number }
  | { kind: 'refused'; refusal: Refusal; detail: string | null; current: string | null }
  | { kind: 'saved'; replayed: boolean };

const fileText = (status: Extract<SlotStatus, { kind: 'file' }>, t: EditorCopy) => status.problem === 'small' && status.size && status.min
  ? t.fileSmall({ width: String(status.size.width), height: String(status.size.height), minWidth: String(status.min.width),
    minHeight: String(status.min.height) })
  : { type: t.fileType, bytes: t.fileBytes, pixels: t.filePixels, unreadable: t.fileUnreadable, alpha: t.fileAlpha, small: t.fileUnreadable }[status.problem];

const refusalText = (refusal: Refusal, t: EditorCopy) => ({
  'sign-in': t.refusalSignIn, denied: t.refusalDenied, gone: t.refusalGone, conflict: t.refusalConflict, crop: t.refusalCrop,
  ratio: t.refusalRatio, resolution: t.refusalResolution, alpha: t.refusalAlpha, trailer: t.refusalTrailer, missing: t.refusalMissing,
  repeat: t.refusalRepeat, limited: t.refusalLimited, invalid: t.refusalInvalid, unavailable: t.refusalUnavailable,
})[refusal];

/** One slot's status line: progress and screening as status, refusals as alerts with what to do next. */
export function SlotStatusView({ status, t, onReload, reloading = false }: {
  status: SlotStatus | undefined; t: EditorCopy; onReload?: () => void; reloading?: boolean;
}) {
  if (!status) return null;
  if (status.kind === 'busy') {
    const text = { uploading: t.stageUploading, screening: t.stageScreening, held: t.stageHeld, saving: t.stageSaving }[status.stage];
    return <Alert variant="info" role="status" className="py-2.5">
      {status.stage === 'held' ? <HourglassIcon aria-hidden="true" /> : <Spinner aria-hidden="true" />}
      <AlertDescription>{text}</AlertDescription></Alert>;
  }
  if (status.kind === 'saved') {
    return <Alert variant="success" role="status" className="py-2.5"><CircleCheckIcon aria-hidden="true" />
      <AlertDescription>{status.replayed ? t.savedReplayed : t.savedNotice}</AlertDescription></Alert>;
  }
  if (status.kind === 'upload' && status.reason === 'held') {
    return <Alert variant="warning" role="status" className="py-2.5"><HourglassIcon aria-hidden="true" />
      <AlertDescription>{t.uploadHeld}</AlertDescription></Alert>;
  }
  const text = status.kind === 'file' ? fileText(status, t)
    : status.kind === 'upload' ? { rejected: t.uploadRejected, held: t.uploadHeld, slow: t.uploadSlow, failed: t.uploadFailed,
      limited: t.uploadLimited({ seconds: String(status.retryAfter ?? 60) }) }[status.reason]
      : refusalText(status.refusal, t);
  const conflict = status.kind === 'refused' && status.refusal === 'conflict';
  return <Alert variant="destructive" role="alert" className="py-2.5">
    {status.kind === 'upload' && status.reason === 'rejected' ? <ShieldAlertIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
    <AlertDescription className="grid gap-2">
      <span>{text}</span>
      {status.kind === 'refused' && status.detail && !conflict ? <span><span className="font-medium">{t.mainSays}:</span> {status.detail}</span> : null}
      {conflict && onReload ? <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onReload}
        isLoading={reloading} disabled={reloading}><RefreshCwIcon aria-hidden="true" />{t.reloadLatest}</Button> : null}
    </AlertDescription></Alert>;
}
