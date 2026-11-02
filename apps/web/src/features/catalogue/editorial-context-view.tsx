import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Tombstone } from '@rezics/ui/tombstone';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { locales } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { EditorialContextNavigation } from './editorial-context-navigation';
import {
  editorialCommand,
  type EditorialCommand,
  type EditorialFailure,
  type EditorialRead,
  type EditorialTransport,
} from './editorial-context';

const actionControlClass =
  'h-auto min-h-8 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] py-1 max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';
const formControlClass =
  'h-auto min-h-8 min-w-0 max-w-full max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const languageControlClass =
  'max-w-full max-md:w-full pointer-coarse:w-full md:pointer-fine:w-fit max-md:[&_select]:h-11 max-md:[&_select]:min-h-11 max-md:[&_select]:min-w-11 pointer-coarse:[&_select]:h-11 pointer-coarse:[&_select]:min-h-11 pointer-coarse:[&_select]:min-w-11 md:pointer-fine:[&_select]:h-8 md:pointer-fine:[&_select]:min-h-8';

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
  const [name, setName] = useState('');
  const [language, setLanguage] = useState(locale);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<EditorialCommand>();
  const [failure, setFailure] = useState<EditorialFailure>();
  const [confirmation, setConfirmation] = useState<'delete' | 'restore'>();
  const [notice, setNotice] = useState<EditorialCommand['operation']>();
  const [knownDeleted, setKnownDeleted] = useState(false);
  const [restoreBlocked, setRestoreBlocked] = useState(false);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const languageNames = new Intl.DisplayNames([locale], { type: 'language' });

  async function refresh(target = currentId) {
    if (!lifetime.active()) return;
    if (!target || running.current) return;
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

  async function submit(operation: EditorialCommand['operation']) {
    if (!lifetime.active()) return;
    if (running.current) return;
    let command = pending;
    if (!command) {
      try {
        command = editorialCommand({
          operation,
          key: crypto.randomUUID(),
          ...(session.current ? { session: session.current } : {}),
          ...(operation === 'create' ? { labels: { [language]: name.trim() } } : { id: currentId }),
        });
      } catch {
        if (!lifetime.active()) return;
        setFailure({ ok: false, reason: 'invalid' });
        return;
      }
      setPending(command);
    }
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
      setName('');
      running.current = false;
      await refresh(result.id);
      if (!lifetime.active()) return;
    } catch {
      if (!lifetime.active()) return;
      if (mounted.current) setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const active = reading?.ok ? reading.context : undefined;
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
  const draftDirty = name !== '' || language !== locale;
  // Protect the sent command, not an ordinary read (including the read after confirmed success).
  const commandUnsettled = !!pending && (busy || !!uncertain);
  const action = knownDeleted ? 'restore' : 'delete';
  const eligibleAttempt = (knownDeleted && !restoreBlocked) || active?.kind === 'community';
  return (
    <section
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
            <Field>
              <FieldLabel htmlFor={`${fieldId}-language`}>{m.catalogue_create_language({}, o)}</FieldLabel>
              <NativeSelect
                id={`${fieldId}-language`}
                className={languageControlClass}
                data-editorial-control
                value={language}
                disabled={busy || !!pending}
                onChange={(event) =>
                  lifetime.active() && !running.current && !pending && setLanguage(event.target.value)
                }
              >
                {locales.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {languageNames.of(value) ?? value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-name`}>{m.catalogue_create_label({}, o)}</FieldLabel>
              <Input
                id={`${fieldId}-name`}
                className={formControlClass}
                data-editorial-control
                value={name}
                maxLength={250}
                required
                disabled={busy || !!pending}
                onChange={(event) => {
                  if (!lifetime.active() || running.current || pending) return;
                  setName(event.target.value);
                  setFailure(undefined);
                }}
              />
            </Field>
            {!pending && (
              <Button
                type="submit"
                className={actionControlClass}
                data-editorial-control
                disabled={busy || !name.trim()}
              >
                {m.editorial_create({}, o)}
              </Button>
            )}
          </form>
        )}
        {active?.kind === 'global' && <p>{m.editorial_global({}, o)}</p>}
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
                      onClick={() => void submit(pending.operation)}
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
                        if (!lifetime.active() || running.current || uncertain) return;
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
                      onClick={() =>
                        lifetime.active() &&
                        !running.current &&
                        (confirmation ? void submit(action) : setConfirmation(action))
                      }
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
                        onClick={() => lifetime.active() && !running.current && setConfirmation(undefined)}
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
                  onClick={() => void refresh()}
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
