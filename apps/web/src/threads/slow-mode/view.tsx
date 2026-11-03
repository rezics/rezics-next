import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { WriteFailure } from '../actions';
import { fullDateTime } from '../byline';
import {
  deadlineFromRetryAfter,
  remainingSeconds,
  SLOW_MODE_INTERVALS,
  waitUntilFromPolicy,
  type SlowModeChange,
  type SlowModeInterval,
  type SlowModePolicy,
} from './contract';
import { rememberSlowModeRead, useSlowModePort, useSlowModeRead, type SlowModeVisit } from './caller';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-2 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function intervalLabel(seconds: SlowModeInterval): string {
  return seconds === 0 ? m.slow_mode_interval_off() : m.slow_mode_interval_seconds({ seconds });
}

function policyWaitUntil(policy: SlowModePolicy | undefined, refusal: WriteFailure | null, receivedAt: number): number | null {
  if (refusal?.reason === 'rate-limited' && refusal.retryAfter !== undefined)
    return deadlineFromRetryAfter(refusal.retryAfter, receivedAt);
  if (!policy) return null;
  return waitUntilFromPolicy(policy, receivedAt);
}

function useDisplayNow(waitUntil: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (waitUntil === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= waitUntil) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waitUntil]);
  return now;
}

function EligibilityCopy({ policy, waitUntil, now }: { policy?: SlowModePolicy; waitUntil: number | null; now: number }) {
  const locale = getLocale();
  if (waitUntil !== null && waitUntil > now) {
    return (
      <>
        <p>{m.slow_mode_next_at({ time: fullDateTime(new Date(waitUntil).toISOString(), locale) })}</p>
        <p>{m.thread_write_rate_limited({ seconds: remainingSeconds(waitUntil, now) })}</p>
        <p>{m.slow_mode_guidance()}</p>
      </>
    );
  }
  if (policy && policy.intervalSeconds > 0) return <p>{m.slow_mode_next_now()}</p>;
  return null;
}

export function SlowModeEligibility({ boardId, refusal }: { boardId: string; refusal: WriteFailure | null }) {
  const { visit, read, preparing, reload } = useSlowModeRead(boardId);
  const receivedAt = useRef({ refusal, at: Date.now() });
  if (receivedAt.current.refusal !== refusal) receivedAt.current = { refusal, at: Date.now() };
  if (!visit) return null;
  const policy = read?.kind === 'available' ? read.policy : undefined;
  const waitUntil = policyWaitUntil(policy, refusal, receivedAt.current.at);
  const now = useDisplayNow(waitUntil);
  const showInterval = policy && policy.intervalSeconds > 0;
  const waiting = waitUntil !== null && waitUntil > now;
  const empty = read?.kind === 'available' && !showInterval && !waiting && refusal?.reason !== 'rate-limited';
  if (empty || (!preparing && read === undefined && !waiting && refusal?.reason !== 'rate-limited')) return null;
  return (
    <div className="mb-4 min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]" data-slot="board-slow-mode" role="status">
      {preparing ? <p>{m.slow_mode_preparing()}</p> : null}
      {read?.kind === 'unavailable' ? (
        <>
          <p>{m.slow_mode_next_unavailable()}</p>
          <Button type="button" variant="outline" className={actionClass} onClick={reload}>
            {m.slow_mode_retry()}
          </Button>
        </>
      ) : null}
      {showInterval ? <p>{m.slow_mode_interval_label({ label: intervalLabel(policy.intervalSeconds) })}</p> : null}
      <EligibilityCopy {...(policy ? { policy } : {})} waitUntil={waitUntil} now={now} />
    </div>
  );
}

function applyChange(visit: SlowModeVisit, result: SlowModeChange, remember: (read: import('./contract').SlowModeRead) => void) {
  if (result.kind === 'applied') remember({ kind: 'available', policy: result.policy });
}

export function SlowModeSetting({ boardId }: { boardId: string }) {
  const { visit, read, preparing, reload } = useSlowModeRead(boardId);
  if (!visit) return null;
  if (read?.kind === 'denied') return null;
  if (read?.kind === 'available' && !read.policy.canChange) return null;
  return (
    <SlowModeSettingForm
      key={`${visit.boardId}:${visit.subject}:${visit.csrfToken}`}
      visit={visit}
      read={read}
      preparing={preparing}
      reload={reload}
    />
  );
}

function SlowModeSettingForm({
  visit,
  read,
  preparing,
  reload,
}: {
  visit: SlowModeVisit;
  read: import('./contract').SlowModeRead | undefined;
  preparing: boolean;
  reload: () => void;
}) {
  const ids = useId();
  const client = useQueryClient();
  const port = useSlowModePort();
  const [draft, setDraft] = useState<SlowModeInterval | null>(null);
  const [outcome, setOutcome] = useState<SlowModeChange | null>(null);
  const [pending, setPending] = useState(false);
  const commandKey = useRef(crypto.randomUUID());
  const policy = read?.kind === 'available' ? read.policy : undefined;
  const selected = draft ?? policy?.intervalSeconds ?? 0;
  const busy = pending || preparing;

  async function save() {
    if (!visit.current() || pending) return;
    setPending(true);
    setOutcome(null);
    const owner = visit.controller.signal;
    try {
      const result = await port.change({
        boardId: visit.boardId,
        intervalSeconds: selected,
        idempotencyKey: commandKey.current,
        signal: owner,
      });
      if (!visit.current(owner)) return;
      setOutcome(result);
      if (result.kind === 'applied') {
        commandKey.current = crypto.randomUUID();
        setDraft(null);
        applyChange(visit, result, (next) => rememberSlowModeRead(client, visit, next));
      } else if (result.kind !== 'unknown') commandKey.current = crypto.randomUUID();
    } catch {
      if (!visit.current(owner)) return;
      setOutcome({ kind: 'unknown' });
    } finally {
      if (visit.current(owner)) setPending(false);
    }
  }

  return (
    <section className="min-w-0 space-y-3 border-t border-border pt-5 [overflow-wrap:anywhere]" data-slot="board-slow-mode-setting">
      {preparing ? (
        <p role="status">{m.slow_mode_preparing()}</p>
      ) : read?.kind === 'unavailable' || !read ? (
        <div className="space-y-2" role="status">
          <p>{m.slow_mode_unavailable()}</p>
          <Button type="button" variant="outline" className={actionClass} onClick={reload}>
            {m.slow_mode_retry()}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FieldSet className="gap-2" disabled={busy}>
            <FieldLegend id={`${ids}-legend`} variant="label">
              {m.slow_mode_setting_legend()}
            </FieldLegend>
            <p className="text-sm text-muted-foreground">{m.slow_mode_setting_help()}</p>
            <RadioGroup
              value={String(selected)}
              onValueChange={(value) => {
                const next = Number(value);
                if (next === 0 || next === 30 || next === 60 || next === 300) setDraft(next);
              }}
              aria-labelledby={`${ids}-legend`}
            >
              {SLOW_MODE_INTERVALS.map((interval) => (
                <Field key={interval} orientation="horizontal" className="min-h-11 items-center">
                  <RadioGroupItem id={`${ids}-${interval}`} value={String(interval)} />
                  <FieldLabel htmlFor={`${ids}-${interval}`} className="min-h-11 items-center">
                    {intervalLabel(interval)}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          {outcome?.kind === 'denied' ? <p role="alert">{m.slow_mode_denied()}</p> : null}
          {outcome?.kind === 'unavailable' || outcome?.kind === 'conflict' ? (
            <p role="alert">{m.slow_mode_unavailable()}</p>
          ) : null}
          {outcome?.kind === 'unknown' ? <p role="alert">{m.slow_mode_unknown()}</p> : null}
          {outcome?.kind === 'applied' ? <p role="status">{m.slow_mode_saved()}</p> : null}
          <Button type="submit" className={actionClass} disabled={busy}>
            {m.slow_mode_apply()}
          </Button>
        </form>
      )}
    </section>
  );
}
