import { platformRegistry, validateProfile, type CompositionDocument } from '@rezics/composition';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, useState, type CSSProperties, type FormEvent } from 'react';
import { getLocale } from '../../paraglide/runtime';
import { ErrorPage } from '../../shell/shell';
import { csrfHeaders } from '../../threads/composer';
import { overviewOf, profileTemplates, withTemplate, type CurationFailure, type Template } from './curate';
import { publishCuration, readCuration, type CurationRead } from './curate-actions';

const PageEditor = lazy(() => import('./editor').then((module) => ({ default: module.PageEditor })));
const control =
  'min-h-11 rounded-lg border border-border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring';
const button = `${control} hover:bg-muted disabled:opacity-50`;
const editorTheme = {
  '--puck-color-surface': 'var(--card)',
  '--puck-color-surface-muted': 'var(--muted)',
  '--puck-color-surface-subtle': 'var(--background)',
  '--puck-color-border': 'var(--border)',
  '--puck-color-border-muted': 'var(--border)',
  '--puck-color-text': 'var(--foreground)',
  '--puck-color-text-secondary': 'var(--muted-foreground)',
  '--puck-color-text-muted': 'var(--muted-foreground)',
  '--puck-color-interactive': 'var(--primary)',
  '--puck-color-interactive-neutral-hover': 'var(--muted)',
  '--puck-color-interactive-soft': 'var(--muted)',
  '--puck-button-primary-color-text': 'var(--primary-foreground)',
  '--puck-button-primary-color-bg-hover': 'var(--primary)',
  '--puck-button-primary-color-bg-active': 'var(--primary)',
  '--puck-font-family': 'var(--font-interface)',
} as CSSProperties;

function Failure({ failure }: { failure: CurationFailure | Exclude<CurationRead, { ok: true }> }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
      <p>
        {failure.reason === 'invalid'
          ? 'This profile cannot be published.'
          : failure.reason === 'rate-limited'
            ? `Too many requests. Try again${failure.retryAfter === undefined ? ' later' : ` in ${failure.retryAfter} seconds`}.`
            : 'Presentation is unavailable. Please try again.'}
      </p>
      {failure.reason === 'invalid' ? (
        <ul className="list-disc break-all ps-5">
          {failure.errors.map(({ pointer, code }, index) => (
            <li key={index}>
              <code>
                {pointer || '/'} — {code}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CurationView({ initial }: { initial: CurationRead }) {
  const [current, setCurrent] = useState(initial);
  const [failure, setFailure] = useState<CurationFailure | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Template | null>(null);
  const [scope, setScope] = useState<'type' | 'route'>('type');
  const [key, setKey] = useState('');

  if ((!current.ok && current.reason === 'forbidden') || failure?.reason === 'forbidden') return <ErrorPage />;

  async function reload() {
    setBusy(true);
    setFailure(null);
    try {
      setCurrent(await readCuration({ headers: csrfHeaders() }));
      setSelected(null);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }

  if (!current.ok)
    return (
      <div className="space-y-4">
        <Failure failure={current} />
        <button type="button" className={button} disabled={busy} onClick={reload}>
          Reload presentation
        </button>
      </div>
    );

  const { profile, head } = current;
  const templates = profileTemplates(profile);
  const document = !selected ? null : (overviewOf(profile, selected) ?? null);

  function addTemplate(event: FormEvent) {
    event.preventDefault();
    if (!current.ok || busy) return;
    const template = { scope, key };
    if (templates.some((item) => item.scope === scope && item.key === key)) {
      setFailure({
        ok: false,
        reason: 'invalid',
        errors: [{ pointer: `/${scope === 'type' ? 'types' : 'routes'}`, code: 'duplicate' }],
      });
      return;
    }
    const next = withTemplate(
      profile,
      template,
      structuredClone(overviewOf(profile, { scope: 'generic', key: null })!),
    );
    const errors = validateProfile(platformRegistry, next);
    if (errors.length > 0) {
      setFailure({ ok: false, reason: 'invalid', errors });
      return;
    }
    setCurrent({ ...current, profile: next });
    setSelected(template);
    setKey('');
    setFailure(null);
    setMessage('Template added to the draft. Publish to activate it.');
  }

  async function publish(edited?: CompositionDocument) {
    if (!current.ok || busy) return;
    const next = edited && selected ? withTemplate(profile, selected, edited) : profile;
    setCurrent({ ...current, profile: next });
    setBusy(true);
    setFailure(null);
    setMessage('');
    try {
      const result = await publishCuration({
        data: {
          profile: next,
          expectedHead: head,
          keys: { publish: crypto.randomUUID(), activate: crypto.randomUUID() },
        },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setCurrent({ ok: true, profile: next, digest: result.digest, head: result.head });
        setMessage(`Presentation published. New head: ${result.head}.`);
      } else if (result.reason === 'stale') {
        setSelected(null);
        setCurrent(await readCuration({ headers: csrfHeaders() }));
        setMessage('The active presentation changed. Reloaded the active profile; your draft was discarded.');
      } else setFailure(result);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="min-w-0 space-y-6 text-foreground" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Curate presentation</h1>
        <p className="text-muted-foreground">Active head: {head}. Edit a template, then publish the whole profile.</p>
        <p className="text-sm text-muted-foreground">
          The editor's Publish button activates all draft templates. Close the editor before switching templates;
          unpublished editor changes are discarded.
        </p>
      </header>
      {message ? (
        <p role="status" className="rounded-lg border border-border bg-card p-4">
          {message}
        </p>
      ) : null}
      {failure ? <Failure failure={failure} /> : null}
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <section aria-label="Templates" className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-semibold">Templates</h2>
          <ul className="flex flex-wrap gap-2">
            {templates.map((template) => (
              <li key={`${template.scope}:${template.key}`} className="min-w-0 max-w-full">
                <button
                  type="button"
                  className={`${button} max-w-full break-all py-2 text-start`}
                  aria-pressed={selected?.scope === template.scope && selected.key === template.key}
                  disabled={selected !== null}
                  onClick={() => {
                    setSelected(template);
                    setMessage('');
                  }}
                >
                  <span className="text-sm text-muted-foreground">{template.scope}: </span>
                  {template.key ?? 'Generic page'}
                </button>
              </li>
            ))}
          </ul>
        </section>
        {selected && document ? (
          <section className="min-w-0 space-y-3" aria-label="Template editor">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="break-all font-semibold">
                Editing {selected.scope}: {selected.key ?? 'Generic page'}
              </h2>
              <button type="button" className={button} onClick={() => setSelected(null)}>
                Close editor
              </button>
            </div>
            <div className="overflow-auto rounded-xl border border-border bg-card" style={editorTheme}>
              <ClientOnly fallback={<p className="p-4">Loading editor…</p>}>
                <Suspense fallback={<p className="p-4">Loading editor…</p>}>
                  <PageEditor
                    key={`${selected.scope}:${selected.key}`}
                    document={document}
                    locale={getLocale()}
                    onPublish={(edited) => void publish(edited)}
                  />
                </Suspense>
              </ClientOnly>
            </div>
          </section>
        ) : (
          <>
            <form className="space-y-3 rounded-xl border border-border bg-card p-4" onSubmit={addTemplate}>
              <h2 className="font-semibold">Add template</h2>
              <p className="text-sm text-muted-foreground">
                Start from the generic page. Type keys use a CURIE such as schema:Book; routes use paths such as /books.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  Scope
                  <select
                    className={`${control} block`}
                    value={scope}
                    onChange={(event) => setScope(event.target.value as 'type' | 'route')}
                  >
                    <option value="type">Type</option>
                    <option value="route">Route</option>
                  </select>
                </label>
                <label className="min-w-0 flex-1 space-y-1">
                  Key
                  <input
                    className={`${control} block w-full`}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                <button type="submit" className={button}>
                  Add template
                </button>
              </div>
            </form>
            <button type="button" className={button} onClick={() => void publish()}>
              Publish profile
            </button>
          </>
        )}
      </fieldset>
    </article>
  );
}
