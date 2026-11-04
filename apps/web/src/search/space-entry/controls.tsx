import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { SpaceEntryRow } from './contract';
import type { SpaceEntryCommands } from './commands';

const control =
  'relative z-10 inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-sm disabled:opacity-60';
export function SpaceEntryControls({
  id,
  row,
  locale,
  returnTo,
  commands,
  signedOut = false,
}: {
  id: string;
  row: SpaceEntryRow | undefined;
  locale: string;
  returnTo: string;
  commands?: SpaceEntryCommands | undefined;
  signedOut?: boolean;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const origin = useRef({ active: true, row, commands, locale });
  if (origin.current.row !== row || origin.current.commands !== commands || origin.current.locale !== locale) {
    origin.current.active = false;
    origin.current = { active: true, row, commands, locale };
  }
  const owner = origin.current;
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const [result, setResult] = useState<{
    owner: typeof owner;
    state: 'pending' | 'failed' | 'uncertain' | 'successful';
  } | null>(null);
  const state = result?.owner === owner ? result.state : null;
  const follow = row?.follow;
  const ready = follow?.state === 'current' && follow.action === 'allowed' && commands?.current();
  const signIn = signedOut || follow?.state === 'sign-in';
  const followLabel =
    follow?.state === 'current' && follow.following
      ? m.library_follow_unfollow({}, options)
      : m.library_follow({}, options);
  async function change() {
    if (!ready || !commands || follow?.state !== 'current' || state === 'pending' || !owner.active) return;
    setResult({ owner, state: 'pending' });
    const reply = await commands.execute({
      targetId: id,
      following: !follow.following,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!owner.active || !commands.current()) return;
    setResult({
      owner,
      state: !reply ? 'failed' : reply.ok ? 'successful' : reply.reason === 'unavailable' ? 'uncertain' : 'failed',
    });
  }
  const destination = row?.destination;
  const href =
    destination?.kind === 'realm'
      ? `/${encodeURIComponent(locale)}/realms/${encodeURIComponent(destination.realmId)}`
      : destination?.kind === 'space'
        ? `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(destination.address)}`
        : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2" data-search-space-actions={id}>
      {signIn ? (
        <a className={control} href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}>
          {m.search_space_sign_in({}, options)}
        </a>
      ) : (
        <button
          className={control}
          type="button"
          onClick={() => void change()}
          disabled={!ready || state === 'pending' || state === 'uncertain' || state === 'successful'}
          aria-busy={state === 'pending'}
        >
          {state === 'pending' ? m.search_space_pending({}, options) : followLabel}
        </button>
      )}
      {!signIn &&
      (!follow || follow.state === 'unavailable' || (follow.state === 'current' && follow.action !== 'allowed')) ? (
        <span role="status" className="text-sm text-muted-foreground">
          {follow?.state === 'current' && follow.action === 'disabled'
            ? m.search_space_follow_disabled({}, options)
            : m.search_space_follow_unavailable({}, options)}
        </span>
      ) : null}
      {href && row?.entry === 'allowed' ? (
        <a
          className={control}
          href={href}
          onClick={(event) => {
            if (commands && !commands.current()) event.preventDefault();
          }}
        >
          {destination?.kind === 'realm' ? m.search_space_enter_realm({}, options) : m.search_space_open({}, options)}
        </a>
      ) : (
        <span role="status" className="text-sm text-muted-foreground">
          {row?.entry === 'disabled'
            ? m.search_space_entry_disabled({}, options)
            : m.search_space_entry_unavailable({}, options)}
        </span>
      )}
      {destination?.kind === 'realm' ? (
        <span className="text-sm text-muted-foreground">
          {row?.admission === 'allowed'
            ? m.search_space_rules({}, options)
            : row?.admission === 'disabled'
              ? m.search_space_admission_disabled({}, options)
              : row?.admission === 'sign-in'
                ? m.search_space_admission_sign_in({}, options)
                : m.search_space_admission_unavailable({}, options)}
        </span>
      ) : null}
      {state === 'failed' || state === 'uncertain' ? (
        <span role="alert">
          {state === 'uncertain' ? m.discovery_personal_uncertain({}, options) : m.search_space_failed({}, options)}
        </span>
      ) : null}
      {state === 'successful' ? <span role="status">{m.discovery_personal_successful({}, options)}</span> : null}
    </div>
  );
}
