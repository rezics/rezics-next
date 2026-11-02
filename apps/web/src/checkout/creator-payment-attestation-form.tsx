import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { useCreatorIntent } from './creator-current-origin';
import type { CreatorOfferGuard } from './creator-offers';
import type { CreatorStatement } from './creator-statements';
import { StatementPayment, StatementTime } from './creator-statements-page';
import { attestCreatorPayment } from './creator-payment-attestation';
import {
  CreatorPaymentAttempt,
  validPaymentReference,
  type PaymentAttestationInput,
  type PaymentAttestationResult,
} from './creator-payment-attestation-state';
import { hasUnsentPaymentReference, PaymentReferenceDraftNavigation } from './payment-reference-draft-navigation';

function terminalPaymentResult(result: PaymentAttestationResult | null) {
  return result?.kind === 'saved' || result?.kind === 'conflict';
}

/** This region shares the statement reader's current origin; it starts no parallel reader. */
export function CreatorPaymentAttestation({
  statement,
  subject,
  locale,
  guard,
  refresh,
}: {
  statement: CreatorStatement;
  subject: string;
  locale: string;
  guard: CreatorOfferGuard;
  refresh(): Promise<boolean>;
}) {
  const memory = useCreatorIntent<CreatorPaymentAttempt>(guard, 'payment-attestation');
  const sender = useCreatorIntent<(data: PaymentAttestationInput) => Promise<PaymentAttestationResult>>(
    guard,
    'payment-attestation-sender',
  );
  const [attempt] = useState(() => memory.value ?? new CreatorPaymentAttempt(statement.id, subject));
  memory.value = attempt;
  const [reference, setReference] = useState(attempt.request?.paidReference ?? '');
  useSyncExternalStore(attempt.subscribe, attempt.snapshot, attempt.snapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const active = useRef(false);
  const referenceField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const current = () => active.current && guard.isCurrent();
  const fieldId = useId();
  const result = attempt.result;
  const admitted = guard.isCurrent() && !!guard.csrfToken();
  const locked = !!attempt.request && !attempt.correctionEditing;
  const canRetry = attempt.canRetry;

  async function refreshEvidence() {
    if (!current() || refreshing) return;
    setRefreshing(true);
    let accepted = false;
    try {
      accepted = await refresh();
    } catch {
      /* Keep the confirmed command result. */
    }
    if (!current()) return;
    setRefreshFailed(!accepted);
    setRefreshing(false);
  }

  async function submit() {
    if (terminalPaymentResult(attempt.result)) return;
    const csrfToken = guard.csrfToken();
    if (!current() || !csrfToken || (!attempt.request && statement.state !== 'open')) return;
    const startsFreshRequest = !attempt.request || attempt.correctionEditing;
    if (startsFreshRequest) {
      if (!validPaymentReference(reference) || (attempt.correctionEditing && !attempt.canSubmitCorrection(reference)))
        return;
      const execute = attestCreatorPayment;
      sender.value = (data) => execute({ data, headers: { 'X-CSRF-Token': csrfToken } });
    }
    const pending = attempt.submit(reference, sender.value!, current);
    await pending;
    if (!current()) return;
    if (attempt.result?.kind === 'saved') await refreshEvidence();
  }

  return (
    <div className="space-y-4">
      <StatementPayment statement={statement} locale={locale} />
      {(statement.state === 'open' || attempt.request) && (
        <form
          className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
          aria-labelledby={`${fieldId}-heading`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h3 id={`${fieldId}-heading`} className="font-semibold">
            {m.payment_attestation_heading()}
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground" id={`${fieldId}-help`}>
            {m.payment_attestation_help()}
          </p>
          <Field>
            <FieldLabel htmlFor={fieldId}>{m.statements_paid_reference()}</FieldLabel>
            <Input
              ref={referenceField}
              id={fieldId}
              name="paidReference"
              value={reference}
              required
              maxLength={256}
              autoComplete="off"
              disabled={locked || !admitted}
              aria-describedby={`${fieldId}-help ${fieldId}-validation`}
              aria-invalid={!!reference && !validPaymentReference(reference)}
              className="min-h-11"
              onChange={(event) => {
                setReference(event.target.value);
                attempt.setCorrectionDraft(event.target.value);
              }}
            />
            <p id={`${fieldId}-validation`} className="text-sm text-muted-foreground">
              {m.payment_attestation_validation()}
            </p>
          </Field>
          {attempt.request && (
            <dl className="space-y-2 text-sm">
              <div>
                <dt>{m.payment_attestation_statement()}</dt>
                <dd className="break-all">{attempt.request.statementId}</dd>
              </div>
              <div>
                <dt>{m.payment_attestation_request()}</dt>
                <dd className="break-all">{attempt.request.idempotencyKey}</dd>
              </div>
            </dl>
          )}
          <p role="status" className="text-sm whitespace-pre-wrap" aria-live="polite">
            {attempt.busy
              ? m.payment_attestation_submitting()
              : result?.kind === 'uncertain'
                ? m.payment_attestation_uncertain()
                : result?.kind === 'saved'
                  ? m.payment_attestation_saved()
                  : result?.kind === 'conflict'
                    ? m.payment_attestation_conflict()
                    : result?.kind === 'denied'
                      ? m.creator_denied()
                      : result?.kind === 'rejected'
                        ? attempt.correctionAvailable
                          ? m.payment_attestation_correction_available()
                          : m.payment_attestation_correction_rejected()
                        : ''}
          </p>
          {result?.kind === 'saved' && (
            <dl className="space-y-2 text-sm">
              <div>
                <dt>{m.statements_paid_reference()}</dt>
                <dd className="break-words whitespace-pre-wrap">{result.statement.paidReference}</dd>
              </div>
              <div>
                <dt>{m.statements_paid_at()}</dt>
                <dd>
                  <StatementTime value={result.statement.paidAt} locale={locale} />
                </dd>
              </div>
            </dl>
          )}
          {attempt.correctionAvailable && !attempt.correctionEditing && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!admitted || attempt.busy}
              onClick={() => {
                if (!current() || !attempt.beginCorrection()) return;
                setReference(attempt.correctionDraft);
                referenceField.current?.focus();
              }}
            >
              {m.payment_attestation_correction_edit()}
            </Button>
          )}
          {attempt.correctionEditing ? (
            <Button
              type="submit"
              className="min-h-11"
              disabled={!admitted || attempt.busy || !attempt.canSubmitCorrection(reference)}
            >
              {m.payment_attestation_correction_submit()}
            </Button>
          ) : (
            (!locked || canRetry) && (
              <Button
                type="submit"
                className="min-h-11"
                disabled={!admitted || attempt.busy || (!locked && !validPaymentReference(reference))}
              >
                {locked ? m.payment_attestation_retry() : m.payment_attestation_submit()}
              </Button>
            )
          )}
          {result && !attempt.busy && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!guard.isCurrent() || refreshing}
              onClick={() => void refreshEvidence()}
            >
              {m.statements_refresh()}
            </Button>
          )}
          {refreshFailed && <p role="alert">{m.payment_attestation_refresh_failed()}</p>}
        </form>
      )}
      {(statement.state === 'open' || attempt.request) && (
        <PaymentReferenceDraftNavigation
          active={
            attempt.correctionEditing
              ? reference !== attempt.request?.paidReference && hasUnsentPaymentReference(reference, false)
              : hasUnsentPaymentReference(reference, !!attempt.request)
          }
          isCurrent={() => guard.isCurrent()}
          focus={() => referenceField.current}
        />
      )}
    </div>
  );
}
