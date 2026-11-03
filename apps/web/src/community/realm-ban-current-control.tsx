import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { RealmBanLifetime } from './realm-ban-lifetime';
import {
  admitRealmBanCurrent,
  currentBanAccountKey,
  type InspectRealmBanCurrent,
  type RealmBanCurrentInput,
  type RealmBanCurrentObservation,
  type RealmBanCurrentResult,
} from './realm-ban-current';

const actionClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2';

/** Selection is independent of the list frontier and can never submit a command. */
export function RealmBanCurrentControl({
  realmId,
  inspect,
  cursor,
  gate,
  disabled,
}: {
  realmId: string;
  inspect: InspectRealmBanCurrent;
  cursor?: string | undefined;
  gate: RealmBanLifetime;
  disabled: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<RealmBanCurrentInput | null>(null);
  const [result, setResult] = useState<RealmBanCurrentResult | null>(null);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  const draftNow = useRef('');
  const selectedNow = useRef<RealmBanCurrentInput | null>(null);
  const active = useRef(false);
  const working = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current++;
    };
  }, []);
  useAuthoringDeparture(
    () => gate.current() && (draftNow.current.length > 0 || selectedNow.current !== null),
    () => false,
    JSON.stringify([gate.id, draft, selection]),
    undefined,
    () => {
      sequence.current++;
    },
    'realm-ban',
  );

  async function review(accountId: string, source: HTMLButtonElement) {
    if (!gate.current() || disabled || working.current || active.current === false) return;
    working.current = true;
    const current = ++sequence.current;
    const ticket = gate.ticket();
    const owns = () => active.current && gate.owns(ticket) && sequence.current === current;
    const input = selectedNow.current ?? Object.freeze({ realmId, accountId, ...(cursor ? { cursor } : {}) });
    selectedNow.current = input;
    setSelection(input);
    setResult(null);
    setPending(true);
    let next: RealmBanCurrentResult;
    try {
      await Promise.resolve();
      if (!owns()) return;
      next = admitRealmBanCurrent(input, await inspect(input));
    } catch {
      next = { state: 'unavailable' };
    }
    if (!owns()) return;
    setResult(next);
    working.current = false;
    setPending(false);
    // Keep keyboard position when the submitted action is replaced by retry.
    if (document.activeElement === source) {
      queueMicrotask(() => {
        if (owns() && (document.activeElement === source || document.activeElement === document.body))
          status.current?.focus();
      });
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="min-w-0 max-w-xl space-y-3 wrap-anywhere">
      <h3 id={`${id}-heading`} className="font-semibold">
        {m.realm_bans_inspect_heading()}
      </h3>
      <Field>
        <FieldLabel htmlFor={`${id}-account`}>{m.realm_bans_inspect_account()}</FieldLabel>
        <Input
          ref={field}
          id={`${id}-account`}
          className="min-h-11 min-w-11"
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
          value={draft}
          disabled={disabled || pending}
          onChange={(event) => {
            if (!gate.current() || disabled || working.current) return;
            sequence.current++;
            draftNow.current = event.target.value;
            setDraft(event.target.value);
            selectedNow.current = null;
            setSelection(null);
            setResult(null);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={disabled || pending || !currentBanAccountKey(draft)}
          onClick={(event) => {
            const key = currentBanAccountKey(draft);
            if (key) void review(key, event.currentTarget);
          }}
        >
          {selection ? m.realm_bans_inspect_retry() : m.realm_bans_inspect_action()}
        </Button>
        {draft.length > 0 || selection ? (
          <Button
            type="button"
            variant="ghost"
            className={actionClass}
            disabled={disabled || pending}
            onClick={() => {
              if (!gate.current() || disabled || working.current) return;
              sequence.current++;
              draftNow.current = '';
              selectedNow.current = null;
              setDraft('');
              setSelection(null);
              setResult(null);
              field.current?.focus();
            }}
          >
            {m.realm_bans_cancel()}
          </Button>
        ) : null}
      </div>
      {selection ? (
        <p className="text-sm">
          <bdi>{selection.accountId}</bdi>
        </p>
      ) : null}
      {pending || result ? (
        <div ref={status} role="status" tabIndex={-1} className="text-sm text-muted-foreground">
          {pending ? (
            m.realm_bans_loading()
          ) : result?.state === 'current' || result?.state === 'absent' ? (
            <RealmBanCurrentObservationView observation={result} />
          ) : result?.state === 'forbidden' ? (
            m.realm_bans_forbidden()
          ) : result?.state === 'signed-out' ? (
            m.realm_bans_signed_out()
          ) : result?.state === 'closed' ? (
            m.realm_bans_closed()
          ) : (
            m.realm_bans_inspect_unavailable()
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Operational facts stay separate from the writer's definitive command receipt. */
export function RealmBanCurrentObservationView({ observation }: { observation: RealmBanCurrentObservation }) {
  if (observation.state === 'absent') return <p>{m.realm_bans_inspect_absent()}</p>;
  const { ban } = observation;
  return (
    <dl className="space-y-3">
      <div>
        <dt className="font-medium">{m.realm_bans_details_reason()}</dt>
        <dd className="whitespace-pre-wrap wrap-anywhere">{ban.reason || m.realm_bans_no_reason()}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.realm_bans_details_moderator()}</dt>
        <dd>{ban.actor ? <bdi>{ban.actor}</bdi> : m.realm_bans_moderator_erased()}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.realm_bans_details_at()}</dt>
        <dd>
          <time dateTime={ban.at} dir="ltr">
            {ban.at.replace('T', ' ').replace(/Z$/, '')} UTC
          </time>
        </dd>
      </div>
      <div>
        <dd>{m.realm_bans_active()}</dd>
      </div>
      <div>
        <dd>{m.realm_bans_help()}</dd>
      </div>
    </dl>
  );
}
