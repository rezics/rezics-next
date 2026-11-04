import { profileDigest, VIEWS, type PresentationProfile, type View } from '@rezics/composition';
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { presentationMessageOptions } from './curate-view-editor-messages';
import { presentationViewNames } from './curate-view-editor';
import type { CurationAdmissionLease } from './curation-reader-admission';
import {
  captureDraftPreview,
  type DraftPreviewInput,
  type DraftPreviewRead,
  type DraftPreviewResult,
} from './draft-preview';
import { PublishedPresentationPage } from './presentation-preview-view';

type Owner = { lease: CurationAdmissionLease; locale: string; read: DraftPreviewRead };
type Capture = { owner: Owner; input: DraftPreviewInput; digest: string };
const sameOwner = (a: Owner, b: Owner) => a.lease === b.lease && a.locale === b.locale && a.read === b.read;
const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';

/** Only the deliberate capture sends a candidate. Edits keep the captured result visibly out of date. */
export function DraftPreviewPanel({
  profile,
  locale,
  lease,
  read,
  focusHandoff,
}: {
  profile: PresentationProfile;
  locale: string;
  lease: CurationAdmissionLease;
  read: DraftPreviewRead;
  focusHandoff?: Set<string>;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const options = presentationMessageOptions(locale);
  const [kind, setKind] = useState<'subject' | 'account' | 'route'>('subject');
  const [address, setAddress] = useState('');
  const [realm, setRealm] = useState('');
  const [view, setView] = useState<View>('overview');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [output, setOutput] = useState<DraftPreviewResult | null>(null);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const captureButton = useRef<HTMLButtonElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const restoreCaptureFocus = useRef(false);
  const owner = { lease, locale, read };
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const previousOwner = useRef(owner);

  function retire() {
    const document = sectionRef.current?.ownerDocument;
    if (document && outputRef.current?.contains(document.activeElement)) restoreCaptureFocus.current = true;
    sequence.current++;
    setCapture(null);
    setOutput(null);
    setPending(false);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const document = section?.ownerDocument;
    if (!section || !document) return;
    if (focusHandoff?.has(lease.reader)) {
      focusHandoff.delete(lease.reader);
      const active = document.activeElement;
      if (active === document.body || !active?.isConnected) captureButton.current?.focus();
    }
    return () => {
      if (section.contains(document.activeElement)) focusHandoff?.add(lease.reader);
    };
  }, [focusHandoff, lease.reader]);
  useLayoutEffect(() => {
    if (!restoreCaptureFocus.current) return;
    restoreCaptureFocus.current = false;
    const document = sectionRef.current?.ownerDocument;
    const active = document?.activeElement;
    if (document && (active === document.body || !active?.isConnected)) captureButton.current?.focus();
  }, [capture, output, pending]);
  useLayoutEffect(() => {
    if (!sameOwner(previousOwner.current, owner)) retire();
    previousOwner.current = owner;
  }, [lease, locale, read]);
  useLayoutEffect(
    () =>
      lease.onRetire((silent) => {
        sequence.current++;
        if (!silent && mounted.current) {
          setCapture(null);
          setOutput(null);
          setPending(false);
        }
      }),
    [lease],
  );
  // The admission lease owns reader health. A same-reader credential rotation retires only preview work.
  useLayoutEffect(() => {
    const credential = () => queryClient.getQueryData<{ csrfToken?: string | null }>(['session'])?.csrfToken;
    let previous = credential();
    return queryClient.getQueryCache().subscribe(() => {
      const next = credential();
      if (next === previous) return;
      previous = next;
      retire();
    });
  }, [queryClient]);
  const active = capture && sameOwner(capture.owner, owner) && lease.isCurrent() ? capture : null;
  const result = lease.isCurrent() && sameOwner(previousOwner.current, owner) ? output : null;
  const busy = !!active && pending;
  let changed = false;
  if (active) {
    try {
      changed = profileDigest(profile) !== active.digest;
    } catch {
      changed = true;
    }
  }

  async function execute(captured: Capture) {
    if (!lease.isCurrent()) return;
    const document = sectionRef.current?.ownerDocument;
    if (document && outputRef.current?.contains(document.activeElement)) restoreCaptureFocus.current = true;
    const serial = ++sequence.current;
    setPending(true);
    setOutput(null);
    let result: DraftPreviewResult;
    try {
      result = await captured.owner.read(structuredClone(captured.input));
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (
      !mounted.current ||
      serial !== sequence.current ||
      !captured.owner.lease.isCurrent() ||
      !sameOwner(captured.owner, currentOwner.current)
    )
      return;
    setPending(false);
    setOutput(result);
  }
  function takeCapture(event: FormEvent) {
    event.preventDefault();
    retire();
    if (!lease.isCurrent()) return;
    const input = captureDraftPreview({
      expectedReader: lease.reader,
      profile,
      locale,
      target:
        kind === 'route'
          ? { route: address.trim() }
          : kind === 'account'
            ? { account: address.trim(), view }
            : { subject: address.trim(), ...(realm.trim() ? { realm: realm.trim() } : {}), view },
    });
    if (!input) {
      setOutput({ ok: false, reason: 'invalid' });
      return;
    }
    const captured = { owner, input, digest: profileDigest(input.profile) };
    setCapture(captured);
    void execute(captured);
  }
  const views = presentationViewNames(locale);
  const failures = {
    invalid: m.presentation_preview_invalid,
    denied: m.presentation_preview_denied,
    missing: m.presentation_preview_missing,
    unavailable: m.presentation_preview_unavailable,
    interrupted: m.draft_preview_interrupted,
    redirect: m.presentation_preview_redirect,
  };
  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {m.draft_preview_title({}, options)}
      </h2>
      <p className="text-sm text-muted-foreground">{m.draft_preview_help({}, options)}</p>
      <form onSubmit={takeCapture} aria-busy={busy} className="space-y-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-kind`}>{m.presentation_preview_target({}, options)}</FieldLabel>
            <NativeSelect
              id={`${id}-kind`}
              value={kind}
              className="w-full min-w-0 [&_select]:min-h-11"
              onChange={(event) => {
                retire();
                setKind(event.target.value as typeof kind);
              }}
            >
              <NativeSelectOption value="subject">{m.presentation_preview_subject({}, options)}</NativeSelectOption>
              <NativeSelectOption value="account">{m.draft_preview_account({}, options)}</NativeSelectOption>
              <NativeSelectOption value="route">{m.presentation_preview_route({}, options)}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-address`}>{m.draft_preview_address({}, options)}</FieldLabel>
            <Input
              id={`${id}-address`}
              value={address}
              className="min-h-11"
              onChange={(event) => {
                retire();
                setAddress(event.target.value);
              }}
            />
          </Field>
          {kind === 'subject' && (
            <Field>
              <FieldLabel htmlFor={`${id}-realm`}>{m.presentation_preview_realm({}, options)}</FieldLabel>
              <Input
                id={`${id}-realm`}
                value={realm}
                className="min-h-11"
                onChange={(event) => {
                  retire();
                  setRealm(event.target.value);
                }}
              />
            </Field>
          )}
          {kind !== 'route' && (
            <Field>
              <FieldLabel htmlFor={`${id}-view`}>{m.draft_preview_view({}, options)}</FieldLabel>
              <NativeSelect
                id={`${id}-view`}
                value={view}
                className="w-full min-w-0 [&_select]:min-h-11"
                onChange={(event) => {
                  retire();
                  setView(event.target.value as View);
                }}
              >
                {VIEWS.map((name) => (
                  <NativeSelectOption key={name} value={name}>
                    {views[name]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button ref={captureButton} type="submit" className={control} disabled={!lease.isCurrent()}>
            {m.draft_preview_capture({}, options)}
          </Button>
          {busy && (
            <Button
              type="button"
              variant="outline"
              className={control}
              onClick={() => {
                restoreCaptureFocus.current = true;
                sequence.current++;
                setPending(false);
                setOutput({ ok: false, reason: 'interrupted' });
              }}
            >
              {m.draft_preview_interrupt({}, options)}
            </Button>
          )}
          {active && !busy && (
            <Button
              type="button"
              variant="outline"
              className={control}
              onClick={(event) => {
                if (sectionRef.current?.ownerDocument.activeElement === event.currentTarget)
                  restoreCaptureFocus.current = true;
                void execute(active);
              }}
            >
              {m.draft_preview_retry({}, options)}
            </Button>
          )}
        </div>
      </form>
      {active && (
        <div className="space-y-2 text-sm wrap-anywhere">
          <p className="break-all font-mono">{m.draft_preview_digest({ digest: active.digest }, options)}</p>
          <p>
            {JSON.stringify(active.input.target)} · {active.input.locale}
          </p>
          {changed && <p role="status">{m.draft_preview_changed({}, options)}</p>}
        </div>
      )}
      {busy && <p role="status">{m.curation_loading({}, options)}</p>}
      <div ref={outputRef}>
        {result && !result.ok && (
          <div role="alert" className="space-y-2">
            <p>{failures[result.reason]({}, options)}</p>
            {result.reason === 'redirect' && (
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={() => {
                  retire();
                  setKind('account');
                  setAddress(result.handle);
                  setRealm('');
                }}
              >
                {m.draft_preview_correct({ handle: result.handle }, options)}
              </Button>
            )}
          </div>
        )}
        {active && result?.ok && (
          <div className="min-w-0 space-y-3">
            <p role="status">{m.draft_preview_success({}, options)}</p>
            <PublishedPresentationPage result={result} />
          </div>
        )}
      </div>
    </section>
  );
}
