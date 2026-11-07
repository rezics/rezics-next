import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from '@rezics/ui/shadcn/combobox';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { createVerificationApplication, VerificationSubjectSearch } from '../application/verification';
import type { VerificationCapability } from '../ports/verification';
import {
  unwrapVerificationRead,
  type VerificationOperations,
  type VerificationSnapshot,
  type VerificationSubject,
} from '../contract/verification';
import { createBrowserSettingsAmbient } from './ambient';
import { useSettingsAmbient } from './ambient-view.tsx';
import {
  searchVerificationSubjects,
  readVerificationState,
  requestVerificationAction,
  withdrawVerificationAction,
} from '../verification-actions';

export { verificationSearchRetryAt } from '../core/verification';

/** Enable a manual action after the native delay, without fetching or polling. */
export function useVerificationRetryWait(retryAt?: number): boolean {
  const ambient = useSettingsAmbient();
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (retryAt === undefined) return;
    let handle: { cancel: () => void } | undefined;
    const update = () => {
      const current = ambient.now();
      setNow(current);
      if (retryAt > current)
        handle = ambient.timer.schedule(update, Math.min(retryAt - current, 2_147_483_647));
    };
    update();
    return () => handle?.cancel();
  }, [ambient, retryAt]);
  return retryAt !== undefined && (now === undefined || retryAt > now);
}

type ChooserProps = {
  selected: VerificationSubject | null;
  onSelect: (subject: VerificationSubject | null) => void;
  disabled?: boolean;
  search: VerificationCapability['search'];
};

export function VerificationSubjectChooser({ owner, ...props }: ChooserProps & { owner: string | null }) {
  const onSelect = useRef(props.onSelect);
  useEffect(() => {
    onSelect.current = props.onSelect;
  }, [props.onSelect]);
  const [previousOwner, setPreviousOwner] = useState(owner);
  const changed = previousOwner !== owner;
  useEffect(() => {
    if (changed) {
      onSelect.current(null);
      setPreviousOwner(owner);
    }
  }, [changed, owner]);
  useEffect(() => () => onSelect.current(null), []);
  return (
    <VerificationSubjectChooserView
      key={`${owner}:${getLocale()}`}
      {...props}
      selected={owner && !changed ? props.selected : null}
      disabled={props.disabled || !owner || changed}
    />
  );
}

/** The chooser view; stories and the production consumer both pass the transport explicitly. */
export function VerificationSubjectChooserView({ selected, onSelect, disabled = false, search }: ChooserProps) {
  const id = useId();
  const ambient = useSettingsAmbient();
  const input = useRef<HTMLInputElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const focus = useRef<'input' | 'change' | null>(null);
  const highlighted = useRef<VerificationSubject | undefined>(undefined);
  const [lookup] = useState(
    () =>
      new VerificationSubjectSearch(search, ambient, {
        unavailable: () => m.settings_verification_search_unavailable(),
      }),
  );
  const state = useSyncExternalStore(lookup.subscribe, lookup.snapshot, lookup.snapshot);
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  const episode = lookup.currentEpisode();
  const retryWaiting = useVerificationRetryWait(state.retryAt);
  useEffect(() => {
    lookup.setEnabled(!disabled && !selected);
    if (disabled || selected) setOpen(false);
    return () => lookup.setEnabled(false);
  }, [lookup, disabled, selected, locale]);
  useEffect(() => {
    if (disabled) focus.current = null;
    else if (focus.current === 'input' && !selected) {
      input.current?.focus();
      focus.current = null;
    } else if (focus.current === 'change' && selected) {
      change.current?.focus();
      focus.current = null;
    }
  }, [disabled, selected]);
  const subjects = !disabled && !selected && state.phase === 'ready' ? state.subjects : [];
  const busy = state.phase === 'pending' || state.phase === 'loading';
  return (
    <Field>
      <FieldLabel id={`${id}-label`} htmlFor={selected ? undefined : `${id}-input`}>
        {m.settings_verification_subject()}
      </FieldLabel>
      {selected ? (
        <div className="flex flex-wrap items-center gap-3" role="group" aria-labelledby={`${id}-label`}>
          <span className="min-w-0 break-words">
            {selected.title} · {selected.type}
          </span>
          <Button
            ref={change}
            type="button"
            variant="outline"
            className="min-h-11 whitespace-normal"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              lookup.clear();
              focus.current = 'input';
              onSelect(null);
            }}
          >
            {m.settings_verification_change_subject()}
          </Button>
        </div>
      ) : (
        <>
          <Combobox
            items={subjects}
            filter={null}
            value={null}
            inputValue={state.query}
            autoHighlight={false}
            disabled={disabled}
            open={!disabled && open && subjects.length > 0}
            onOpenChange={setOpen}
            itemToStringLabel={(subject: VerificationSubject) => subject.title}
            onItemHighlighted={(subject) => {
              highlighted.current = subject;
            }}
            onInputValueChange={(value, details) => {
              if (details.reason === 'input-change' || details.reason === 'input-clear') {
                lookup.edit(value, episode);
                setOpen(true);
              }
            }}
            onValueChange={(subject) => {
              if (disabled || !subject || !lookup.current(subject, episode)) return;
              lookup.clear();
              setOpen(false);
              focus.current = 'change';
              onSelect(subject);
            }}
          >
            <ComboboxInput
              ref={input}
              id={`${id}-input`}
              className="w-full min-h-11"
              showTrigger={false}
              autoComplete="off"
              maxLength={100}
              disabled={disabled}
              aria-describedby={`${id}-help ${id}-status`}
              aria-busy={!disabled && busy}
              onBlur={() => setOpen(false)}
              onCompositionStart={() => {
                lookup.startComposition(episode);
                setOpen(false);
              }}
              onCompositionEnd={(event) => {
                lookup.endComposition(event.currentTarget.value, episode);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                // Enter chooses only an explicitly highlighted result; it never submits the parent form.
                const composing = lookup.isComposing(episode) || event.nativeEvent.isComposing || event.keyCode === 229;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (composing || !open || !highlighted.current || !lookup.current(highlighted.current, episode))
                    event.preventBaseUIHandler();
                }
                if (composing) {
                  event.preventBaseUIHandler();
                  return;
                }
                if (event.key === 'Escape') setOpen(false);
              }}
            />
            <ComboboxContent>
              <ComboboxList aria-labelledby={`${id}-label`} className="space-y-2 p-2">
                {(subject: VerificationSubject) => (
                  <ComboboxItem key={subject.id} value={subject} className="min-h-11 gap-3 py-3">
                    <span className="min-w-0 break-words">
                      {subject.title} · {subject.type}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription id={`${id}-help`}>{m.settings_verification_search_help()}</FieldDescription>
          <p id={`${id}-status`} role="status" aria-live="polite" aria-atomic="true">
            {!disabled && busy ? m.settings_verification_search_loading() : null}
            {!disabled && state.phase === 'ready'
              ? subjects.length
                ? m.settings_verification_search_results({ count: subjects.length })
                : m.settings_verification_search_empty()
              : null}
            {!disabled && state.phase === 'failed'
              ? (state.failure?.message ?? m.settings_verification_search_failed())
              : null}
            {!disabled && state.phase === 'failed' && retryWaiting
              ? ` ${m.settings_verification_search_retry_wait()}`
              : null}
          </p>
          {!disabled && state.phase === 'failed' ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 justify-self-start"
              disabled={retryWaiting || state.failure?.retryable === false}
              onClick={() => {
                lookup.retry(episode);
                setOpen(true);
                input.current?.focus();
              }}
            >
              {m.settings_retry()}
            </Button>
          ) : null}
        </>
      )}
    </Field>
  );
}

const nativeSearch: VerificationCapability['search'] = (query, signal) =>
  searchVerificationSubjects({ data: { query }, signal });

function nativeOperations(): VerificationOperations {
  return {
    status: async (accountId, signal) => {
      const result = await readVerificationState({ data: { accountId }, ...(signal ? { signal } : {}) });
      const snapshot = unwrapVerificationRead<VerificationSnapshot>(result);
      return { verificationRequest: snapshot.verificationRequest, viewerActions: snapshot.viewerActions };
    },
    request: (accountId, input, signal) =>
      requestVerificationAction({ data: { ...input, accountId }, ...(signal ? { signal } : {}) }),
    withdraw: (accountId, idempotencyKey, signal) =>
      withdrawVerificationAction({ data: { idempotencyKey, accountId }, ...(signal ? { signal } : {}) }),
    eligibility: async () => {
      throw new Error('Eligibility is bound only on the native search action');
    },
    title: async () => null,
    suggest: async () => {
      throw new Error('Suggestions are bound only on the native search action');
    },
  };
}

function verificationCapability(
  ambient: ReturnType<typeof createBrowserSettingsAmbient>,
): VerificationCapability {
  return {
    application: createVerificationApplication(nativeOperations(), nativeEligibleCopy(), ambient),
    search: nativeSearch,
    ownerKey: (accountId, csrfToken) => (accountId && csrfToken ? `${accountId}:${csrfToken}` : null),
  };
}

function nativeEligibleCopy() {
  return {
    person: m.settings_verification_person(),
    organization: m.settings_verification_organization(),
  };
}

const VerificationContext = createContext<VerificationCapability>(verificationCapability(createBrowserSettingsAmbient()));
export function VerificationProvider({ value, children }: { value: VerificationCapability; children: ReactNode }) {
  return <VerificationContext.Provider value={value}>{children}</VerificationContext.Provider>;
}
export function useVerification(): VerificationCapability {
  return useContext(VerificationContext);
}

export function NativeVerificationProvider({ children }: { children: ReactNode }) {
  const ambient = useSettingsAmbient();
  const value = useMemo(() => verificationCapability(ambient), [ambient]);
  return <VerificationProvider value={value}>{children}</VerificationProvider>;
}

export type { VerificationInput, VerificationSearchFailure, VerificationSubject } from '../contract/verification';
export type Search = VerificationCapability['search'];
export { nativeSearch as searchVerificationSubjectsTransport };
