import { LoaderCircleIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@rezics/ui/shadcn/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { Textarea } from '@rezics/ui/shadcn/textarea';

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

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

/**
 * A focused report form. shadcn has no report form; this composes `dialog`, `radio-group`, `field` and `textarea`.
 * The host supplies the verification widget and its verified state.
 */
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
  const incarnation = useRef(0);
  const mounted = useRef(false);
  const openRef = useRef(open);
  const pendingRef = useRef(false);
  const successRef = useRef(false);
  const operationRef = useRef<object | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const failureLabelRef = useRef(labels.failure);
  const id = useId().replaceAll(':', '');
  const requiresDetails = reason === 'illegal' || reason === 'other';
  const hasRequiredDetails = !requiresDetails || details.trim().length > 0;
  const withinDetailsLimit = details.length <= detailsLimit;
  const canSubmit = Boolean(reason) && verified && hasRequiredDetails && withinDetailsLimit && !pending && !success;
  const detailsId = `${id}-details`;
  const detailsHintId = `${id}-details-hint`;
  const characterCountId = `${id}-character-count`;
  const reasonsLabelId = `${id}-reasons-label`;

  useClientLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    failureLabelRef.current = labels.failure;
  });

  useClientLayoutEffect(() => {
    mounted.current = true;
    openRef.current = open;
    incarnation.current += 1;
    operationRef.current = null;
    pendingRef.current = false;
    successRef.current = false;

    if (open) {
      setReason('');
      setDetails('');
      setPending(false);
      setSuccess(false);
      setFailure('');
    }

    return () => {
      mounted.current = false;
      openRef.current = false;
      incarnation.current += 1;
      operationRef.current = null;
      pendingRef.current = false;
      successRef.current = false;
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !openRef.current ||
      !mounted.current ||
      pendingRef.current ||
      successRef.current ||
      !reason ||
      !verified ||
      !hasRequiredDetails ||
      !withinDetailsLimit
    )
      return;

    const operation = {};
    const operationIncarnation = incarnation.current;
    operationRef.current = operation;
    pendingRef.current = true;
    setPending(true);
    setFailure('');
    const isCurrent = () =>
      mounted.current &&
      openRef.current &&
      incarnation.current === operationIncarnation &&
      operationRef.current === operation;

    try {
      await onSubmit({ reason, details });
      if (!isCurrent()) return;

      successRef.current = true;
      setSuccess(true);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        if (mounted.current && openRef.current && incarnation.current === operationIncarnation && successRef.current)
          onOpenChangeRef.current(false);
      }, 900);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      setFailure(message || failureLabelRef.current);
    } finally {
      if (isCurrent()) {
        operationRef.current = null;
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  const updateDetails = (value: string) => {
    setDetails(value);
    setFailure('');
  };

  return (
    <Dialog
      onOpenChange={(next, details) => {
        // A report in flight finishes before the dialog may close.
        if (!next && pendingRef.current) details.cancel();
        else onOpenChangeRef.current(next);
      }}
      open={open}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {success ? (
          <div aria-label={labels.success} className="flex flex-col gap-2" role="status">
            <p className="font-medium">{labels.success}</p>
            <p className="text-muted-foreground text-sm">{labels.successDescription}</p>
          </div>
        ) : (
          <form className="flex min-w-0 flex-col gap-5" onSubmit={submit}>
            <div className="flex flex-col gap-3">
              <p className="font-medium text-sm" id={reasonsLabelId}>
                {labels.reasons}
              </p>
              <RadioGroup
                aria-labelledby={reasonsLabelId}
                className="gap-3"
                disabled={pending}
                name="report-reason"
                onValueChange={(next) => {
                  setReason(next as ReportReason);
                  setFailure('');
                }}
                value={reason}
              >
                {reasons.map(({ value, label, description }) => {
                  const radioId = `${id}-reason-${value}`;
                  const descriptionId = `${radioId}-description`;

                  return (
                    <Field key={value} orientation="horizontal">
                      <RadioGroupItem
                        aria-describedby={descriptionId}
                        aria-labelledby={`${radioId}-label`}
                        id={radioId}
                        value={value}
                      />
                      <FieldContent className="min-w-0">
                        <FieldLabel htmlFor={radioId} id={`${radioId}-label`}>
                          {labels[label]}
                        </FieldLabel>
                        <FieldDescription id={descriptionId}>{labels[description]}</FieldDescription>
                      </FieldContent>
                    </Field>
                  );
                })}
              </RadioGroup>
            </div>

            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor={detailsId}>
                {labels.details}
                {requiresDetails ? <span aria-hidden="true"> *</span> : null}
              </FieldLabel>
              <Textarea
                aria-describedby={`${detailsHintId} ${characterCountId}`}
                aria-required={requiresDetails}
                className="min-h-24 resize-y"
                disabled={pending}
                id={detailsId}
                maxLength={detailsLimit}
                onChange={(event) => updateDetails(event.currentTarget.value)}
                required={requiresDetails}
                value={details}
              />
              <FieldDescription id={detailsHintId}>{labels.detailsRequiredHint}</FieldDescription>
              <p
                aria-label={labels.characterCount}
                aria-live="polite"
                className="text-end text-muted-foreground text-sm tabular-nums"
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
              <p className="text-destructive text-sm" role="alert">
                {failure}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose render={<Button disabled={pending} variant="outline" />}>{labels.cancel}</DialogClose>
              <Button aria-busy={pending} disabled={!canSubmit} type="submit">
                {pending ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" /> : null}
                {labels.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
