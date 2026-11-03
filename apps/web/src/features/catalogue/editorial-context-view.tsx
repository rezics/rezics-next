import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Tombstone } from '@rezics/ui/tombstone';
import { m } from '../../paraglide/messages.js';
import { EditorialContextNavigation } from './editorial-context-navigation';
import { useEditorialCommandFocus } from './editorial-command-focus';
import {
  editorialCommand,
  type EditorialCommand,
  type EditorialFailure,
  type EditorialRead,
  type EditorialTransport,
} from './editorial-context';
import {
  capturedMatches,
  emptyLabelRow,
  labelsFromDraft,
  policyFingerprint,
  policyPreview,
  type LabelRow,
  type SettingsPreview,
  type SettingsRead,
} from './context-settings';
import { CapturedSettings, ContextLabelRows, SettingsPicker, SettingsReview } from './context-settings-view';

const actionControlClass =
  'h-auto min-h-8 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] py-1 max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

/** Private, short-lived reading. A known tombstone exists only after this workspace's native delete response. */
export const EditorialContextWorkspace = catalogueEditor(EditorialContextWorkspaceLive);

function EditorialContextWorkspaceLive({
  id,
  locale,
  transport,
  reviewHref,
  createHref,
  children,
}: {
  id?: string;
  locale: string;
  transport: EditorialTransport;
  reviewHref?: (id: string) => string;
  createHref?: string;
  children?: ((id: string) => ReactNode) | undefined;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const fieldId = useId();
  const [currentId, setCurrentId] = useState(id);
  const [reading, setReading] = useState<EditorialRead>();
  const [rows, setRows] = useState<LabelRow[]>(() => [emptyLabelRow(locale)]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inventory, setInventory] = useState<SettingsRead | undefined>();
  const [captured, setCaptured] = useState<SettingsRead | undefined>();
  const [changed, setChanged] = useState(false);
  const preview = useRef<SettingsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const commandFocus = useEditorialCommandFocus(lifetime.active, busy);
  const [pending, setPending] = useState<EditorialCommand>();
  const [failure, setFailure] = useState<EditorialFailure>();
  const [confirmation, setConfirmation] = useState<'delete' | 'restore'>();
  const [notice, setNotice] = useState<EditorialCommand['operation']>();
  const [knownDeleted, setKnownDeleted] = useState(false);
  const [restoreBlocked, setRestoreBlocked] = useState(false);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const active = reading?.ok ? reading.context : undefined;
  const action = knownDeleted ? 'restore' : 'delete';
  const eligibleAttempt = (knownDeleted && !restoreBlocked) || active?.kind === 'community';
  // A control admits only the observation that rendered it. Replay belongs to the
  // unresolved command instead, so later session/read observations cannot re-key it.
  const observed = { pending, restoreBlocked };
  const observation = useRef<typeof observed | undefined>(undefined);
  observation.current = observed;
  function admitted() {
    return lifetime.active() && mounted.current && !running.current && !busy && observation.current === observed;
  }
  function retireControls() {
    observation.current = undefined;
  }

  async function refresh(target = currentId) {
    if (!lifetime.active()) return;
    if (!target || running.current) return;
    retireControls();
    running.current = true;
    setBusy(true);
    // Do not retain private labels or review payloads across a failed current read.
    setReading(undefined);
    setConfirmation(undefined);
    try {
      const next = await transport.read({ id: target, ...(session.current ? { session: session.current } : {}) });
      if (!lifetime.active()) return;
      if (!mounted.current) return;
      session.current = next.session ?? session.current;
      setReading(next);
      if (next.ok) {
        setKnownDeleted(false);
        setRestoreBlocked(false);
      }
    } catch {
      if (!lifetime.active()) return;
      if (mounted.current) setReading({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (id) void refresh(id);
    return () => {
      mounted.current = false;
    };
    // Route/session identity remounts this private workspace. Mutations own subsequent reads.
  }, [id, transport]);
  useEffect(() => {
    if (!transport.settings || inventory) return;
    let cancelled = false;
    setInventory({ kind: 'loading' });
    void transport.settings.choices(session.current).then((latest) => {
      if (!cancelled && mounted.current && lifetime.active()) setInventory(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [transport, inventory, lifetime]);
  useEffect(() => {
    const digest = active?.settings?.release;
    if (!transport.settings || !digest) return;
    let cancelled = false;
    setCaptured({ kind: 'loading' });
    void transport.settings.captured(digest, session.current).then((latest) => {
      if (!cancelled && mounted.current && lifetime.active()) setCaptured(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [active?.settings?.release, transport, lifetime]);

  function submit(operation: EditorialCommand['operation']) {
    if (!admitted() || pending) return;
    if (operation === 'create') {
      if (currentId || !labelsFromDraft(rows)) return;
      void confirmCreate();
      return;
    }
    if (!currentId || !eligibleAttempt || operation !== action || confirmation !== action) return;
    let command: EditorialCommand;
    try {
      command = editorialCommand({
        operation,
        key: crypto.randomUUID(),
        ...(session.current ? { session: session.current } : {}),
        id: currentId,
      });
    } catch {
      setFailure({ ok: false, reason: 'invalid' });
      return;
    }
    setPending(command);
    void execute(command);
  }
  async function confirmCreate() {
    if (!admitted() || pending || currentId) return;
    const labels = labelsFromDraft(rows);
    if (!labels) return;
    let settings = selected ?? undefined;
    const snapshot = inventory?.kind === 'ready' ? inventory.snapshot : null;
    if (selected && transport.settings) {
      const latest = await transport.settings.choices(session.current);
      if (!lifetime.active() || !mounted.current) return;
      if (latest.kind === 'ready') {
        const next = policyPreview(latest.snapshot, selected);
        const previous = snapshot ? policyPreview(snapshot, selected) : next;
        setInventory(latest);
        if (!next.settings) {
          setFailure({ ok: false, reason: 'invalid' });
          return;
        }
        if (policyFingerprint(previous) !== policyFingerprint(next)) {
          setChanged(true);
          return;
        }
        settings = next.settings;
        preview.current = next;
      } else {
        setInventory(latest);
        preview.current = {
          settings: selected,
          release: snapshot?.digest ?? '',
          defaults: snapshot?.contexts[selected]?.defaults ?? {},
        };
      }
    } else {
      preview.current = snapshot
        ? policyPreview(snapshot, selected)
        : { settings: selected, release: '', defaults: {} };
    }
    let command: EditorialCommand;
    try {
      command = editorialCommand({
        operation: 'create',
        key: crypto.randomUUID(),
        ...(session.current ? { session: session.current } : {}),
        labels,
        ...(settings ? { settings } : {}),
      });
    } catch {
      setFailure({ ok: false, reason: 'invalid' });
      return;
    }
    if (!admitted()) return;
    setChanged(false);
    setPending(command);
    void execute(command);
  }
  function retry(command: EditorialCommand) {
    if (!lifetime.active() || !mounted.current || running.current) return;
    if (observation.current?.pending !== command || observation.current.restoreBlocked) return;
    void execute(command);
  }
  async function execute(command: EditorialCommand) {
    const focus = commandFocus.begin();
    retireControls();
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    setConfirmation(undefined);
    setReading(undefined);
    try {
      const result = await transport.submit(command);
      if (!lifetime.active()) return;
      if (!mounted.current) return;
      session.current = result.session ?? session.current;
      if (!result.ok) {
        setFailure(result);
        if (command.operation === 'restore' && result.reason === 'conflict') setRestoreBlocked(true);
        return;
      }
      // Drop all cached Context content before the ordinary reread. No cascade or cleanup claim.
      setReading(undefined);
      setCurrentId(result.id);
      setKnownDeleted(result.operation === 'delete');
      setNotice(result.operation);
      setPending(undefined);
      setRows([emptyLabelRow(locale)]);
      running.current = false;
      await refresh(result.id);
      if (!lifetime.active()) return;
    } catch {
      if (!lifetime.active()) return;
      if (mounted.current) setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      if (mounted.current) focus?.finish();
      if (mounted.current) setBusy(false);
    }
  }
  const errorText = (reason: EditorialFailure['reason']) =>
    reason === 'denied'
      ? m.editorial_denied({}, o)
      : reason === 'missing'
        ? m.editorial_missing({}, o)
        : reason === 'invalid'
          ? m.editorial_invalid({}, o)
          : reason === 'conflict'
            ? m.editorial_conflict({}, o)
            : m.editorial_unavailable({}, o);
  const uncertain = pending && failure?.reason === 'unavailable';
  const draftDirty = rows.some((row) => row.text !== '' || row.language !== locale) || selected !== null;
  // Protect the sent command, not an ordinary read (including the read after confirmed success).
  const commandUnsettled = !!pending && (busy || !!uncertain);
  return (
    <section
      ref={commandFocus.workspace}
      onKeyDownCapture={commandFocus.onKeyDownCapture}
      onClickCapture={commandFocus.onClickCapture}
      onPointerDownCapture={commandFocus.onPointerDownCapture}
      aria-label={m.editorial_title({}, o)}
      aria-busy={busy}
      className="min-w-0 space-y-6"
      data-editorial-workspace
    >
      <EditorialContextNavigation
        locale={locale}
        dirty={!currentId && draftDirty}
        unsettled={commandUnsettled}
        onLeave={lifetime.retire}
      />
      <ContentItemFrame as="div" className="min-w-0 space-y-6 p-4 [overflow-wrap:anywhere] sm:p-6" data-editorial-panel>
        <header className="space-y-2">
          <ContentItemHeading level={2} className="text-2xl font-semibold">
            {active ? pickText(active.labels, locale).text || m.context_unnamed({}, o) : m.editorial_title({}, o)}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">{m.editorial_intro({}, o)}</p>
        </header>
        <div
          ref={commandFocus.result}
          role="group"
          aria-label={m.editorial_title({}, o)}
          aria-describedby={`${fieldId}-result`}
          tabIndex={-1}
          hidden={!(busy || notice || knownDeleted || failure || (reading && !reading.ok))}
          data-editorial-result
        >
          <div id={`${fieldId}-result`} className="space-y-6">
            {busy && <p role="status">{m.candidate_loading({}, o)}</p>}
            {notice && (notice !== 'delete' || !knownDeleted) && (
              <p role="status">
                {notice === 'delete'
                  ? m.editorial_deleted({}, o)
                  : notice === 'restore'
                    ? m.editorial_restored({}, o)
                    : m.editorial_created({}, o)}
              </p>
            )}
            {knownDeleted && !active && (
              <div role="status">
                <Tombstone shape="row" reason="deleted" labels={{ deleted: m.editorial_deleted({}, o) }} />
              </div>
            )}
            {failure && <p role="alert">{errorText(failure.reason)}</p>}
            {reading && !reading.ok && <p role="status">{errorText(reading.reason)}</p>}
          </div>
        </div>
        {!currentId && (
          <form
            className="max-w-xl space-y-4"
            data-editorial-form
            onSubmit={(event) => {
              event.preventDefault();
              void submit('create');
            }}
          >
            <p>{m.editorial_empty({}, o)}</p>
            <ContextLabelRows
              locale={locale}
              rows={rows}
              disabled={busy || !!pending}
              languageLabel={m.catalogue_create_language({}, o)}
              nameLabel={m.catalogue_create_label({}, o)}
              nameHelp={m.ctxw_label_help({}, o)}
              control=""
              onChange={(next) => {
                if (!admitted() || pending) return;
                retireControls();
                setRows(next);
                setFailure(undefined);
                setChanged(false);
              }}
            />
            {transport.settings ? (
              <SettingsPicker
                locale={locale}
                inventory={inventory}
                selected={selected}
                disabled={busy || !!pending}
                control=""
                onSelect={(id) => {
                  if (!admitted() || pending) return;
                  retireControls();
                  setSelected(id);
                  setChanged(false);
                }}
                onReload={() => {
                  if (!transport.settings) return;
                  void transport.settings.choices(session.current).then((latest) => {
                    if (mounted.current && lifetime.active()) setInventory(latest);
                  });
                }}
              />
            ) : null}
            {labelsFromDraft(rows) ? (
              <SettingsReview
                locale={locale}
                labels={labelsFromDraft(rows)!}
                preview={
                  inventory?.kind === 'ready'
                    ? policyPreview(inventory.snapshot, selected)
                    : { settings: selected, release: '', defaults: {} }
                }
                snapshot={inventory?.kind === 'ready' ? inventory.snapshot : null}
                changed={changed}
              />
            ) : null}
            {!pending && (
              <Button
                type="submit"
                className={actionControlClass}
                data-editorial-control
                disabled={busy || !labelsFromDraft(rows)}
              >
                {m.editorial_create({}, o)}
              </Button>
            )}
          </form>
        )}
        {active?.kind === 'global' && <p>{m.editorial_global({}, o)}</p>}
        {active && (
          <CapturedSettings
            locale={locale}
            captured={{ settings: active.settings, defaults: active.defaults }}
            snapshot={captured?.kind === 'ready' ? captured.snapshot : null}
            {...(captured ? { labels: captured.kind === 'ready' ? 'ready' : captured.kind } : {})}
            {...(preview.current ? { preview: preview.current } : {})}
            mismatch={!!preview.current && notice === 'create' && !capturedMatches(preview.current, active)}
          />
        )}
        {active && (
          <div className="flex flex-wrap gap-3" data-editorial-action-row>
            {reviewHref && (
              <a
                className={buttonVariants({ variant: 'outline', className: actionControlClass })}
                data-editorial-control
                href={reviewHref(active.id)}
              >
                {m.editorial_review({}, o)}
              </a>
            )}
            <a
              className={buttonVariants({ variant: 'outline', className: actionControlClass })}
              data-editorial-control
              href={`/${locale}/contexts/${encodeURIComponent(active.id)}${createHref?.includes('?') ? createHref.slice(createHref.indexOf('?')) : ''}`}
            >
              {m.editorial_open({}, o)}
            </a>
          </div>
        )}
        {currentId && !pending && (
          <a
            className={buttonVariants({ variant: 'outline', className: actionControlClass })}
            data-editorial-control
            href={createHref ?? `/${locale}/contexts/new`}
          >
            {m.editorial_create({}, o)}
          </a>
        )}
        {(currentId || pending) && (
          <div className="min-w-0 space-y-3" data-content-item-slot="state">
            {currentId && <p className="text-sm text-muted-foreground">{m.editorial_authority({}, o)}</p>}
            {confirmation && (
              <p>
                {confirmation === 'delete' ? m.editorial_confirm_delete({}, o) : m.editorial_confirm_restore({}, o)}
              </p>
            )}
            <div className="flex flex-wrap gap-3" data-editorial-action-row>
              {pending ? (
                <>
                  {!restoreBlocked && (
                    <Button
                      className={actionControlClass}
                      data-editorial-control
                      disabled={busy}
                      onClick={() => retry(pending)}
                    >
                      {m.editorial_retry({}, o)}
                    </Button>
                  )}
                  {!uncertain && (
                    <Button
                      variant="outline"
                      className={actionControlClass}
                      data-editorial-control
                      disabled={busy}
                      onClick={() => {
                        if (!admitted() || uncertain) return;
                        retireControls();
                        setPending(undefined);
                        setFailure(undefined);
                        if (currentId) void refresh();
                      }}
                    >
                      {m.editorial_revise({}, o)}
                    </Button>
                  )}
                </>
              ) : (
                eligibleAttempt && (
                  <>
                    <Button
                      variant={action === 'delete' ? 'destructive' : 'default'}
                      className={actionControlClass}
                      data-editorial-control
                      disabled={busy}
                      onClick={() => {
                        if (!admitted() || !eligibleAttempt || pending) return;
                        if (confirmation) submit(action);
                        else {
                          retireControls();
                          setConfirmation(action);
                        }
                      }}
                    >
                      {confirmation
                        ? m.contribution_confirm({}, o)
                        : action === 'delete'
                          ? m.editorial_delete({}, o)
                          : m.editorial_restore({}, o)}
                    </Button>
                    {confirmation && (
                      <Button
                        variant="outline"
                        className={actionControlClass}
                        data-editorial-control
                        onClick={() => {
                          if (!admitted()) return;
                          retireControls();
                          setConfirmation(undefined);
                        }}
                      >
                        {m.candidate_cancel({}, o)}
                      </Button>
                    )}
                  </>
                )
              )}
              {currentId && !pending && (
                <Button
                  variant="outline"
                  className={actionControlClass}
                  data-editorial-control
                  disabled={busy}
                  onClick={() => admitted() && void refresh()}
                >
                  {m.candidate_reload({}, o)}
                </Button>
              )}
            </div>
          </div>
        )}
      </ContentItemFrame>
      {active && !busy && children?.(active.id)}
    </section>
  );
}
