import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from './dialog.tsx';
import { Textarea } from './textarea.tsx';

export const reportDialogLabels = {
  title: 'Report this content',
  description: 'Choose the reason that best explains your report.',
  reasons: 'Why are you reporting this?',
  offTopic: 'Off topic',
  offTopicDescription: 'This content does not belong in this discussion.',
  inappropriate: 'Inappropriate',
  inappropriateDescription: 'This content is harmful or unsuitable.',
  spam: 'Spam',
  spamDescription: 'This content is repetitive or promotional.',
  illegal: 'Illegal activity',
  illegalDescription: 'This content may break the law.',
  other: 'Other',
  otherDescription: 'The issue does not fit the options above.',
  details: 'Additional details',
  detailsRequiredHint: 'Required for illegal activity and other reports.',
  characterCount: 'Character count',
  characterCountText: '{count} of {max} characters',
  verification: 'Verification',
  submit: 'Submit report',
  submitting: 'Submitting report',
  cancel: 'Cancel',
  success: 'Thank you for your report.',
  successDescription: 'Our moderation team will review it.',
  failure: 'Your report could not be submitted.',
} as const;

export type ReportDialogLabels = { readonly [K in keyof typeof reportDialogLabels]: string };

export type ReportReason = 'off_topic' | 'inappropriate' | 'spam' | 'illegal' | 'other';

export interface ReportSubmission {
  reason: ReportReason;
  details: string;
}

export interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (report: ReportSubmission) => Promise<void>;
  verified: boolean;
  verification?: ReactNode;
  maxDetails?: number;
  labels?: Partial<ReportDialogLabels>;
}

const reasons: { value: ReportReason; label: keyof ReportDialogLabels; description: keyof ReportDialogLabels }[] = [
  { value: 'off_topic', label: 'offTopic', description: 'offTopicDescription' },
  { value: 'inappropriate', label: 'inappropriate', description: 'inappropriateDescription' },
  { value: 'spam', label: 'spam', description: 'spamDescription' },
  { value: 'illegal', label: 'illegal', description: 'illegalDescription' },
  { value: 'other', label: 'other', description: 'otherDescription' },
];

/** A focused report form. The host supplies the verification widget and its verified state. */
export function ReportDialog({
  open,
  onOpenChange,
  onSubmit,
  verified,
  verification,
  maxDetails = 2000,
  labels: labelOverrides,
}: ReportDialogProps) {
  const labels = { ...reportDialogLabels, ...labelOverrides };
  const detailsLimit = Number.isFinite(maxDetails) && maxDetails >= 0 ? Math.floor(maxDetails) : 2000;
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [failure, setFailure] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId().replaceAll(':', '');
  const requiresDetails = reason === 'illegal' || reason === 'other';
  const hasRequiredDetails = !requiresDetails || details.trim().length > 0;
  const canSubmit = Boolean(reason) && verified && hasRequiredDetails && !pending && !success;
  const detailsId = `${id}-details`;
  const detailsHintId = `${id}-details-hint`;
  const characterCountId = `${id}-character-count`;
  const reasonsLabelId = `${id}-reasons-label`;

  useEffect(() => {
    if (open) {
      setReason('');
      setDetails('');
      setPending(false);
      setSuccess(false);
      setFailure('');
    }

    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !reason) return;

    setPending(true);
    setFailure('');

    try {
      await onSubmit({ reason, details });
      setSuccess(true);
      closeTimer.current = setTimeout(() => onOpenChange(false), 900);
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      setFailure(message || labels.failure);
    } finally {
      setPending(false);
    }
  };

  const updateDetails = (value: string) => {
    setDetails(value);
    setFailure('');
  };

  return (
    <Dialog open={open} onOpenChange={({ open: nextOpen }) => onOpenChange(nextOpen)} pending={pending}>
      <DialogContent aria-label={labels.title} size="md">
        <DialogHeader description={labels.description} title={labels.title} />
        <DialogBody>
          {success ? (
            <div aria-label={labels.success} className="flex flex-col gap-2" role="status">
              <p className="font-medium">{labels.success}</p>
              <p className="text-muted-foreground text-sm">{labels.successDescription}</p>
            </div>
          ) : (
            <form className="flex flex-col gap-5" onSubmit={submit}>
              <div aria-labelledby={reasonsLabelId} className="flex flex-col gap-3" role="radiogroup">
                <p className="font-medium text-sm" id={reasonsLabelId}>
                  {labels.reasons}
                </p>
                {reasons.map(({ value, label, description }) => {
                  const reasonLabel = labels[label];
                  const descriptionId = `${id}-reason-${value}-description`;

                  return (
                    <label className="inline-flex items-start gap-2" key={value}>
                      <input
                        aria-describedby={descriptionId}
                        aria-label={reasonLabel}
                        checked={reason === value}
                        className="mt-0.5 size-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        disabled={pending}
                        name="report-reason"
                        onChange={() => {
                          setReason(value);
                          setFailure('');
                        }}
                        type="radio"
                        value={value}
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-medium text-sm">{reasonLabel}</span>
                        <span className="text-muted-foreground text-sm" id={descriptionId}>
                          {labels[description]}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm" htmlFor={detailsId}>
                  {labels.details}
                  {requiresDetails ? <span aria-hidden="true"> *</span> : null}
                </label>
                <Textarea
                  aria-describedby={`${detailsHintId} ${characterCountId}`}
                  aria-required={requiresDetails}
                  disabled={pending}
                  id={detailsId}
                  maxLength={detailsLimit}
                  onChange={(event) => updateDetails(event.currentTarget.value)}
                  required={requiresDetails}
                  value={details}
                />
                <p className="text-muted-foreground text-sm" id={detailsHintId}>
                  {labels.detailsRequiredHint}
                </p>
                <p
                  aria-label={labels.characterCount}
                  aria-live="polite"
                  className="text-end text-muted-foreground text-sm"
                  id={characterCountId}
                  role="status"
                >
                  {labels.characterCountText
                    .replace('{count}', String(details.length))
                    .replace('{max}', String(detailsLimit))}
                </p>
              </div>

              {verification ? (
                <div aria-label={labels.verification} data-slot="report-verification" role="group">
                  {verification}
                </div>
              ) : null}
              {pending ? (
                <p aria-live="polite" className="sr-only" role="status">
                  {labels.submitting}
                </p>
              ) : null}
              {failure ? (
                <p className="text-sm" role="alert">
                  {failure}
                </p>
              ) : null}
              <DialogFooter className="-mx-(--space) -mb-1 px-0 pb-0">
                <DialogClose asChild>
                  <Button disabled={pending} variant="outline">
                    {labels.cancel}
                  </Button>
                </DialogClose>
                <Button disabled={!canSubmit} isLoading={pending} type="submit">
                  {labels.submit}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
