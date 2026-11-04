import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { SubjectLibraryMutation, SubjectLibraryMutationResponse } from '../library/subject-slot';
import { changeDiscoveryEntry, type DiscoveryEntryCapability } from './discovery-personal-actions';
import type { DiscoveryPersonalPage, DiscoveryPersonalTarget } from './discovery-personal-state';

const subscribeBrowser = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;
const serverRevision = () => 0;
const controlClass =
  'min-h-11 rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * Controlled entry UI: no Subject read, session read, native writer or automatic retry lives in this component.
 * A host supplies released profile/exposure evidence and an existing current-reader native command adapter.
 */
export function DiscoveryPersonalControls({
  page,
  target,
  capability,
  locale,
  title,
  returnTo,
  write,
}: {
  page: DiscoveryPersonalPage;
  target: DiscoveryPersonalTarget;
  capability: DiscoveryEntryCapability;
  locale: string;
  title: string;
  returnTo: string;
  write: (command: SubjectLibraryMutation) => Promise<SubjectLibraryMutationResponse>;
}) {
  useSyncExternalStore(page.subscribe, page.snapshot, serverRevision);
  const hydrated = useSyncExternalStore(subscribeBrowser, browserSnapshot, serverSnapshot);
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const id = useId();
  const currentState = target.entry.state === 'present' ? target.entry.entryState : null;
  const choices = capability.state === 'ready' ? capability.states : [];
  const initial = choices.some((choice) => choice.id === currentState) ? currentState! : (choices[0]?.id ?? '');
  const [draft, setDraft] = useState(initial);
  const draftOwner = JSON.stringify([target.rowKey, target.subjectId, target.entry, locale, choices]);
  useEffect(() => setDraft(initial), [page, draftOwner, initial]);
  const state = page.state(target.rowKey, 'entry');
  const current = page.current() && page.accepts(target);
  const active = hydrated && current && state !== 'pending';

  const notice = (() => {
    switch (state) {
      case 'pending':
        return m.discovery_personal_pending({}, options);
      case 'rejected':
        return m.discovery_personal_rejected({}, options);
      case 'uncertain':
        return m.discovery_personal_uncertain({}, options);
      case 'successful':
        return m.discovery_personal_successful({}, options);
      case 'retired':
        return m.discovery_personal_retired({}, options);
      default:
        return !current ? m.discovery_personal_retired({}, options) : null;
    }
  })();
  if (capability.state === 'signed-out')
    return (
      <a className={controlClass} href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}>
        {m.account_sign_in({}, options)}
      </a>
    );
  if (capability.state !== 'ready' || target.entry.state === 'unavailable') {
    const message =
      capability.state === 'unknown'
        ? m.discovery_personal_unknown({}, options)
        : capability.state === 'unsupported'
          ? m.discovery_personal_unsupported({}, options)
          : capability.state === 'concealed'
            ? m.discovery_personal_concealed({}, options)
            : m.discovery_personal_unavailable({}, options);
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
    );
  }
  const save = () => {
    if (!active || !capability.save || !choices.some((choice) => choice.id === draft)) return;
    void changeDiscoveryEntry({ page, rowKey: target.rowKey, capability, action: { state: draft }, write });
  };
  return (
    <form
      data-slot="discovery-personal-controls"
      aria-busy={state === 'pending'}
      aria-labelledby={`${id}-label`}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {capability.save && choices.length > 0 ? (
        <>
          <label id={`${id}-label`} htmlFor={id} className="block text-sm font-medium">
            {m.discovery_personal_state({ title }, options)}
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              id={id}
              className={controlClass}
              disabled={!active}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id} lang={choice.label.lang}>
                  {choice.label.text}
                </option>
              ))}
            </select>
            <button type="submit" className={controlClass} disabled={!hydrated} aria-disabled={!active}>
              {m.library_subject_save({}, options)}
            </button>
          </div>
        </>
      ) : (
        <span id={`${id}-label`} className="sr-only">
          {m.discovery_personal_state({ title }, options)}
        </span>
      )}
      {capability.remove && target.entry.state === 'present' ? (
        <button
          type="button"
          className={controlClass}
          disabled={!hydrated}
          aria-disabled={!active}
          onClick={() => {
            if (active)
              void changeDiscoveryEntry({ page, rowKey: target.rowKey, capability, action: { remove: true }, write });
          }}
        >
          {m.library_remove({}, options)}
        </button>
      ) : null}
      {notice ? (
        <p id={`${id}-status`} role="status" className="text-sm" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
