import { profileDigest, UI_LOCALES, VIEWS, type PresentationProfile, type View } from '@rezics/composition';
import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  isSupportedDraftPreviewTarget,
  type DraftPreviewInput,
  type DraftPreviewRead,
  type DraftPreviewResult,
  type DraftPreviewTarget,
} from './draft-preview';
import { PublishedPresentationPage } from './presentation-preview-view';

type Owner = { lease: CurationAdmissionLease; read: DraftPreviewRead };
type Capture = { owner: Owner; input: DraftPreviewInput; digest: string };
type Kind = 'subject' | 'account' | 'route';
const sameOwner = (a: Owner, b: Owner) => a.lease === b.lease && a.read === b.read;
const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const accountPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function kindOf(target: DraftPreviewTarget): Kind {
  if ('subject' in target) return 'subject';
  if ('account' in target) return 'account';
  return 'route';
}

function kindName(target: DraftPreviewTarget, options: ReturnType<typeof presentationMessageOptions>) {
  const kind = kindOf(target);
  return kind === 'subject'
    ? m.presentation_preview_subject({}, options)
    : kind === 'account'
      ? m.draft_preview_account({}, options)
      : m.presentation_preview_route({}, options);
}

function identityOf(target: DraftPreviewTarget) {
  if ('subject' in target) return target.subject;
  if ('account' in target) return target.account;
  return target.route;
}

function viewOf(target: DraftPreviewTarget) {
  return 'view' in target ? (target.view ?? 'overview') : null;
}

function realmOf(target: DraftPreviewTarget) {
  return 'subject' in target ? (target.realm?.trim() || null) : null;
}

function targetFromFields(kind: Kind, address: string, realm: string, view: View): DraftPreviewTarget {
  const entered = address.trim();
  if (kind === 'route') return { route: entered };
  if (kind === 'account') return { account: entered, view };
  const selectedRealm = realm.trim();
  return { subject: entered, ...(selectedRealm ? { realm: selectedRealm } : {}), view };
}

function TargetSummary({
  target,
  locale,
  options,
  page,
}: {
  target: DraftPreviewTarget;
  locale: string;
  options: ReturnType<typeof presentationMessageOptions>;
  page?: Extract<DraftPreviewResult, { ok: true }>['page'];
}) {
  const kind = kindOf(target);
  const identity = identityOf(target);
  const nativeIdentity =
    page && kind === 'subject' && typeof page.subject === 'string'
      ? page.subject
      : page && 'account' in target && page.account?.handle === target.account
        ? page.account.handle
        : page && 'route' in target && page.template.scope === 'route' && page.template.key === target.route
          ? page.template.key
          : null;
  const nativeLabel =
    kind === 'subject'
      ? m.draft_preview_native_subject({}, options)
      : kind === 'account'
        ? m.draft_preview_native_account({}, options)
        : m.draft_preview_native_route({}, options);
  const viewNames = presentationViewNames(locale);

  return (
    <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
      <div className="min-w-0 rounded-md bg-muted/40 p-3">
        <dt className="text-muted-foreground">{m.presentation_preview_target({}, options)}</dt>
        <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">{kindName(target, options)}</dd>
      </div>
      <div className="min-w-0 rounded-md bg-muted/40 p-3">
        <dt className="text-muted-foreground">{m.draft_preview_entered_intent({}, options)}</dt>
        <dd className="mt-1 break-all font-medium">{identity || m.draft_preview_not_entered({}, options)}</dd>
      </div>
      <div className="min-w-0 rounded-md bg-muted/40 p-3">
        <dt className="text-muted-foreground">{m.draft_preview_locale_label({}, options)}</dt>
        <dd className="mt-1 break-all font-medium">{locale}</dd>
      </div>
      {kind !== 'route' && (
        <div className="min-w-0 rounded-md bg-muted/40 p-3">
          <dt className="text-muted-foreground">{m.draft_preview_view({}, options)}</dt>
          <dd className="mt-1 break-words font-medium [overflow-wrap:anywhere]">
            {viewNames[viewOf(target) ?? 'overview']}
          </dd>
        </div>
      )}
      {kind === 'subject' && (
        <div className="min-w-0 rounded-md bg-muted/40 p-3">
          <dt className="text-muted-foreground">{m.presentation_preview_realm({}, options)}</dt>
          <dd className="mt-1 break-all font-medium">
            {realmOf(target) ?? m.draft_preview_global_realm({}, options)}
          </dd>
        </div>
      )}
      {page && (
        <div className="min-w-0 rounded-md bg-muted/40 p-3">
          <dt className="text-muted-foreground">{nativeLabel}</dt>
          <dd className="mt-1 break-all font-medium">
            {nativeIdentity ?? m.draft_preview_native_identity_unavailable({}, options)}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Only deliberate capture sends a candidate; edits keep one frozen result available for review. */
export function DraftPreviewPanel({
  profile,
  locale,
  lease,
  read,
  focusHandoff,
  onReturn,
}: {
  profile: PresentationProfile;
  locale: string;
  lease: CurationAdmissionLease;
  read: DraftPreviewRead;
  focusHandoff?: Set<string>;
  onReturn?: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const options = presentationMessageOptions(locale);
  const [kind, setKind] = useState<Kind>('subject');
  const [address, setAddress] = useState('');
  const [realm, setRealm] = useState('');
  const [view, setView] = useState<View>('overview');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [output, setOutput] = useState<DraftPreviewResult | null>(null);
  const [pending, setPending] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const captureButton = useRef<HTMLButtonElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const restoreCaptureFocus = useRef(false);
  const focusAfterOpen = useRef(false);
  const owner = { lease, read };
  const currentOwner = useRef(owner);
  const previousOwner = useRef(owner);
  currentOwner.current = owner;

  const profileRevision = useRef({ profile, value: 0 });
  if (profileRevision.current.profile !== profile)
    profileRevision.current = { profile, value: profileRevision.current.value + 1 };
  const localeRevision = useRef({ locale, value: 0 });
  if (localeRevision.current.locale !== locale)
    localeRevision.current = { locale, value: localeRevision.current.value + 1 };
  const observedProfile = useRef(profile);
  const observedLocale = useRef(locale);

  const candidateTarget = useMemo(() => targetFromFields(kind, address, realm, view), [kind, address, realm, view]);
  const localErrors = useMemo(() => {
    const localeError = !(UI_LOCALES as readonly string[]).includes(locale);
    const entered = address.trim();
    const addressError =
      !entered
        ? 'required'
        : kind === 'subject'
          ? uuidPattern.test(entered)
            ? null
            : 'subject'
          : kind === 'account'
            ? accountPattern.test(entered)
              ? null
              : 'account'
            : isSupportedDraftPreviewTarget(candidateTarget, locale)
              ? null
              : 'route';
    const realmError = kind === 'subject' && realm.trim() && !uuidPattern.test(realm.trim()) ? 'realm' : null;
    return { localeError, addressError, realmError };
  }, [address, candidateTarget, kind, locale, realm]);
  const candidateInput = useMemo(() => {
    if (
      localErrors.localeError ||
      localErrors.addressError ||
      localErrors.realmError ||
      !isSupportedDraftPreviewTarget(candidateTarget, locale)
    )
      return null;
    return captureDraftPreview({ expectedReader: lease.reader, profile, locale, target: candidateTarget });
  }, [candidateTarget, lease.reader, locale, localErrors, profile]);
  const currentProfileDigest = useMemo(() => {
    try {
      return profileDigest(profile);
    } catch {
      return null;
    }
  }, [profile]);

  function stopPendingForCandidateChange() {
    if (!pendingRef.current) return;
    sequence.current++;
    pendingRef.current = false;
    setPending(false);
    setOutput({ ok: false, reason: 'interrupted' });
  }

  function retire() {
    const document = sectionRef.current?.ownerDocument;
    if (document && outputRef.current?.contains(document.activeElement)) restoreCaptureFocus.current = true;
    sequence.current++;
    pendingRef.current = false;
    setCapture(null);
    setOutput(null);
    setPending(false);
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      pendingRef.current = false;
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
    if (focusAfterOpen.current && reviewOpen) {
      focusAfterOpen.current = false;
      captureButton.current?.focus();
    }
  }, [reviewOpen]);
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
  }, [lease, read]);
  useLayoutEffect(() => {
    if (observedLocale.current !== locale) {
      observedLocale.current = locale;
      stopPendingForCandidateChange();
    }
  }, [locale]);
  useLayoutEffect(() => {
    if (observedProfile.current !== profile) {
      observedProfile.current = profile;
      stopPendingForCandidateChange();
    }
  }, [profile]);
  useLayoutEffect(
    () =>
      lease.onRetire((silent) => {
        sequence.current++;
        pendingRef.current = false;
        if (!silent && mounted.current) {
          setCapture(null);
          setOutput(null);
          setPending(false);
        }
      }),
    [lease],
  );
  // The admission lease owns reader health. Credential rotation retires only preview work.
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
  const result = active ? output : null;
  const busy = !!active && pending;
  const candidateChanged = active
    ? currentProfileDigest !== active.digest ||
      locale !== active.input.locale ||
      kindOf(candidateTarget) !== kindOf(active.input.target) ||
      identityOf(candidateTarget) !== identityOf(active.input.target) ||
      viewOf(candidateTarget) !== viewOf(active.input.target) ||
      realmOf(candidateTarget) !== realmOf(active.input.target)
    : false;
  const views = presentationViewNames(locale);
  const failures = {
    invalid: m.presentation_preview_invalid,
    denied: m.draft_preview_native_refusal,
    missing: m.presentation_preview_missing,
    unavailable: m.draft_preview_dependency_failure,
    interrupted: m.draft_preview_interrupted,
    redirect: m.presentation_preview_redirect,
  };
  const addressLabel =
    kind === 'subject'
      ? m.draft_preview_subject_id({}, options)
      : kind === 'account'
        ? m.draft_preview_account({}, options)
        : m.presentation_preview_route({}, options);
  const addressHelp =
    kind === 'subject'
      ? m.draft_preview_subject_help({}, options)
      : kind === 'account'
        ? m.draft_preview_account_help({}, options)
        : m.draft_preview_route_help({}, options);
  const addressError =
    attempted && localErrors.addressError
      ? localErrors.addressError === 'required'
        ? m.draft_preview_address_required({}, options)
        : localErrors.addressError === 'subject'
          ? m.draft_preview_subject_invalid({}, options)
          : localErrors.addressError === 'account'
            ? m.draft_preview_account_invalid({}, options)
            : m.draft_preview_route_invalid({}, options)
      : null;
  const realmError =
    attempted && localErrors.realmError ? m.draft_preview_realm_invalid({}, options) : null;
  const localeError = attempted && localErrors.localeError ? m.draft_preview_locale_invalid({}, options) : null;
  const currentCandidateInvalid = attempted && !candidateInput && !addressError && !realmError && !localeError;

  async function execute(captured: Capture) {
    if (!lease.isCurrent()) return;
    const document = sectionRef.current?.ownerDocument;
    if (document && outputRef.current?.contains(document.activeElement)) restoreCaptureFocus.current = true;
    const serial = ++sequence.current;
    const profileAtStart = profileRevision.current.value;
    const localeAtStart = localeRevision.current.value;
    pendingRef.current = true;
    setPending(true);
    setOutput(null);
    let next: DraftPreviewResult;
    try {
      next = await captured.owner.read(structuredClone(captured.input));
    } catch {
      next = { ok: false, reason: 'unavailable' };
    }
    if (
      !mounted.current ||
      serial !== sequence.current ||
      !captured.owner.lease.isCurrent() ||
      !sameOwner(captured.owner, currentOwner.current) ||
      profileAtStart !== profileRevision.current.value ||
      localeAtStart !== localeRevision.current.value
    )
      return;
    pendingRef.current = false;
    setPending(false);
    setOutput(next);
  }

  function takeCapture(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (
      localErrors.localeError ||
      localErrors.addressError ||
      localErrors.realmError ||
      !candidateInput
    ) return;
    if (!lease.isCurrent()) return;
    const captured = { owner, input: candidateInput, digest: profileDigest(candidateInput.profile) };
    setCapture(captured);
    setOutput(null);
    void execute(captured);
  }

  function interrupt() {
    if (!active || !busy) return;
    sequence.current++;
    pendingRef.current = false;
    setPending(false);
    setOutput({ ok: false, reason: 'interrupted' });
  }

  function returnToEditor() {
    setReviewOpen(false);
    onReturn?.();
  }

  function reopenReview() {
    focusAfterOpen.current = true;
    setReviewOpen(true);
  }

  const capturedView = active ? viewOf(active.input.target) : null;
  const currentView = viewOf(candidateTarget);
  const targetChanged =
    !!active &&
    (kindOf(active.input.target) !== kindOf(candidateTarget) ||
      identityOf(active.input.target) !== identityOf(candidateTarget));
  const realmChanged = !!active && realmOf(active.input.target) !== realmOf(candidateTarget);

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <header className="space-y-2">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {m.draft_preview_title({}, options)}
        </h2>
        <p className="text-sm text-muted-foreground">{m.draft_preview_help({}, options)}</p>
      </header>

      {!reviewOpen ? (
        <div className="flex flex-wrap gap-3">
          <Button type="button" className={control} onClick={reopenReview}>
            {m.draft_preview_reopen({}, options)}
          </Button>
          <Button type="button" variant="outline" className={control} onClick={onReturn}>
            {m.draft_preview_return_editor({}, options)}
          </Button>
        </div>
      ) : (
        <>
          <form onSubmit={takeCapture} aria-busy={busy} className="space-y-4">
            <div className="space-y-2">
              <h3 className="font-semibold">{m.draft_preview_current_candidate({}, options)}</h3>
              <TargetSummary target={candidateTarget} locale={locale} options={options} />
            </div>

            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-kind`}>{m.presentation_preview_target({}, options)}</FieldLabel>
                <NativeSelect
                  id={`${id}-kind`}
                  value={kind}
                  className="w-full min-w-0 [&_select]:min-h-11"
                  onChange={(event) => setKind(event.target.value as Kind)}
                >
                  <NativeSelectOption value="subject">
                    {m.presentation_preview_subject({}, options)}
                  </NativeSelectOption>
                  <NativeSelectOption value="account">{m.draft_preview_account({}, options)}</NativeSelectOption>
                  <NativeSelectOption value="route">{m.presentation_preview_route({}, options)}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field data-invalid={!!addressError}>
                <FieldLabel htmlFor={`${id}-address`}>{addressLabel}</FieldLabel>
                <Input
                  id={`${id}-address`}
                  value={address}
                  maxLength={kind === 'route' ? 512 : 64}
                  className="min-h-11"
                  aria-invalid={!!addressError}
                  aria-describedby={`${id}-address-help${addressError ? ` ${id}-address-error` : ''}`}
                  onChange={(event) => setAddress(event.target.value)}
                />
                <p id={`${id}-address-help`} className="text-sm text-muted-foreground">
                  {addressHelp}
                </p>
                {addressError && (
                  <p id={`${id}-address-error`} className="text-sm text-destructive" role="alert">
                    {addressError}
                  </p>
                )}
              </Field>
              {kind === 'subject' && (
                <Field data-invalid={!!realmError}>
                  <FieldLabel htmlFor={`${id}-realm`}>{m.presentation_preview_realm({}, options)}</FieldLabel>
                  <Input
                    id={`${id}-realm`}
                    value={realm}
                    maxLength={36}
                    className="min-h-11"
                    aria-invalid={!!realmError}
                    aria-describedby={`${id}-realm-help${realmError ? ` ${id}-realm-error` : ''}`}
                    onChange={(event) => setRealm(event.target.value)}
                  />
                  <p id={`${id}-realm-help`} className="text-sm text-muted-foreground">
                    {m.presentation_preview_realm_help({}, options)}
                  </p>
                  {realmError && (
                    <p id={`${id}-realm-error`} className="text-sm text-destructive" role="alert">
                      {realmError}
                    </p>
                  )}
                </Field>
              )}
              {kind !== 'route' && (
                <Field>
                  <FieldLabel htmlFor={`${id}-view`}>{m.draft_preview_view({}, options)}</FieldLabel>
                  <NativeSelect
                    id={`${id}-view`}
                    value={view}
                    className="w-full min-w-0 [&_select]:min-h-11"
                    onChange={(event) => setView(event.target.value as View)}
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
            {localeError && <p role="alert" className="text-sm text-destructive">{localeError}</p>}
            {currentCandidateInvalid && (
              <p role="alert" className="text-sm text-destructive">
                {m.draft_preview_profile_invalid({}, options)}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button ref={captureButton} type="submit" className={control} disabled={!lease.isCurrent()}>
                {active ? m.draft_preview_recapture({}, options) : m.draft_preview_capture({}, options)}
              </Button>
              {busy && (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  onClick={(event) => {
                    if (sectionRef.current?.ownerDocument.activeElement === event.currentTarget)
                      restoreCaptureFocus.current = true;
                    interrupt();
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
            <section aria-labelledby={`${id}-captured`} className="min-w-0 space-y-3 border-t border-border pt-4">
              <h3 id={`${id}-captured`} className="font-semibold">
                {m.draft_preview_captured_summary({}, options)}
              </h3>
              <TargetSummary
                target={active.input.target}
                locale={active.input.locale}
                options={options}
                {...(result?.ok ? { page: result.page } : {})}
              />
              {candidateChanged && (
                <div role="status" className="space-y-2 rounded-md border border-border p-3 text-sm">
                  <p>{m.draft_preview_changed({}, options)}</p>
                  {targetChanged && (
                    <p className="break-words [overflow-wrap:anywhere]">
                      <strong>{m.presentation_preview_target({}, options)}: </strong>
                      {kindName(active.input.target, options)} · {identityOf(active.input.target)} →{' '}
                      {kindName(candidateTarget, options)} · {identityOf(candidateTarget)}
                    </p>
                  )}
                  {active.input.locale !== locale && (
                    <p>
                      <strong>{m.draft_preview_locale_label({}, options)}: </strong>
                      {active.input.locale} → {locale}
                    </p>
                  )}
                  {capturedView !== currentView && (capturedView !== null || currentView !== null) && (
                    <p>
                      <strong>{m.draft_preview_view({}, options)}: </strong>
                      {capturedView ? presentationViewNames(active.input.locale)[capturedView] : '—'} →{' '}
                      {currentView ? views[currentView] : '—'}
                    </p>
                  )}
                  {realmChanged && kindOf(active.input.target) === 'subject' && kind === 'subject' && (
                    <p className="break-all">
                      <strong>{m.presentation_preview_realm({}, options)}: </strong>
                      {realmOf(active.input.target) ?? m.draft_preview_global_realm({}, options)} →{' '}
                      {realmOf(candidateTarget) ?? m.draft_preview_global_realm({}, options)}
                    </p>
                  )}
                  {currentProfileDigest !== active.digest && (
                    <p>{m.draft_preview_profile_changed({}, options)}</p>
                  )}
                </div>
              )}
              <details className="text-sm">
                <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {m.draft_preview_technical_details({}, options)}
                </summary>
                <dl className="grid min-w-0 gap-2 pt-2 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.draft_preview_digest_label({}, options)}</dt>
                    <dd className="break-all font-mono">{active.digest}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.draft_preview_exact_target({}, options)}</dt>
                    <dd className="break-all font-mono">{JSON.stringify(active.input.target)}</dd>
                  </div>
                </dl>
              </details>
            </section>
          )}

          {busy && (
            <p role="status" aria-live="polite">
              {m.draft_preview_running({}, options)}
            </p>
          )}
          <div ref={outputRef} className="min-w-0 space-y-3">
            {result && !result.ok && (
              <div role="alert" className="space-y-2">
                <p>{failures[result.reason]({}, options)}</p>
                {result.reason === 'interrupted' && (
                  <p className="text-sm text-muted-foreground">
                    {m.draft_preview_stop_request({}, options)}
                  </p>
                )}
                {result.reason === 'redirect' && (
                  <Button
                    type="button"
                    variant="outline"
                    className={control}
                    onClick={() => {
                      setKind('account');
                      setAddress(result.handle);
                      setRealm('');
                      captureButton.current?.focus();
                    }}
                  >
                    {m.draft_preview_correct({ handle: result.handle }, options)}
                  </Button>
                )}
              </div>
            )}
            {active && result?.ok && (
              <div className="min-w-0 space-y-3">
                <p role="status" aria-live="polite">{m.draft_preview_success({}, options)}</p>
                <p className="text-sm text-muted-foreground">{m.draft_preview_not_publication({}, options)}</p>
                <PublishedPresentationPage result={result} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" className={control} onClick={returnToEditor}>
              {m.draft_preview_return_editor({}, options)}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
