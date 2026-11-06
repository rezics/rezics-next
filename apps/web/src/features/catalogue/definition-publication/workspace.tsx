import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { cn } from '@rezics/ui/utils';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { m } from '../../../paraglide/messages.js';
import { definitionGuideHref } from '../definition-guide';
import { diagnosticField } from './model';
import {
  activateBody,
  isExtensionComparison,
  isReleaseComparison,
  newPublicationKey,
  parseImportedText,
  publicationHref,
  publishBody,
  repairableDiagnostics,
  workspacePhase,
  type CatalogueBuildStatus,
  type PublicationCommand,
  type PublicationDocument,
  type PublicationFailure,
  type PublicationPreview,
  type PublicationRead,
  type PublicationResult,
  type PublicationScope,
  type PublicationTransport,
} from './model';
import { publicationCommand } from './native';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const recoveryClassName = 'rounded-sm focus:outline-2 focus:outline-offset-4 focus:outline-ring';

export type DefinitionPublicationWorkspaceProps = {
  locale: string;
  scope: PublicationScope;
  context?: string;
  initial: PublicationRead;
  transport: PublicationTransport;
};

function failureCopy(reason: PublicationFailure, locale: string) {
  const o = { locale: locale as never };
  if (reason === 'signed-out' || reason === 'denied') return m.definition_publication_denied({}, o);
  if (reason === 'closed') return m.definition_publication_closed({}, o);
  if (reason === 'stale') return m.definition_publication_stale({}, o);
  if (reason === 'uncertain') return m.definition_publication_uncertain({}, o);
  if (reason === 'missing') return m.definition_publication_missing({}, o);
  if (reason === 'conflict') return m.definition_publication_conflict({}, o);
  if (reason === 'invalid') return m.definition_publication_invalid({}, o);
  return m.definition_publication_unavailable({}, o);
}

export function DefinitionPublicationWorkspace({
  locale,
  scope,
  context,
  initial,
  transport,
}: DefinitionPublicationWorkspaceProps) {
  const o = { locale: locale as never };
  const fileId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [opening, setOpening] = useState<PublicationRead>(initial);
  const [document, setDocument] = useState<PublicationDocument>();
  const [filename, setFilename] = useState<string>();
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const [localDiagnostics, setLocalDiagnostics] = useState(repairableDiagnostics([]));
  const [busy, setBusy] = useState<'preview' | 'publish' | 'activate' | 'build' | 'create' | null>(null);
  const [uncertain, setUncertain] = useState<PublicationCommand | null>(null);
  const [stale, setStale] = useState(false);
  const [build, setBuild] = useState<CatalogueBuildStatus | null>(null);
  const [completed, setCompleted] = useState<PublicationResult | null>(null);
  const [independent, setIndependent] = useState<{ digest: string; subject?: string } | null>(null);
  const [alert, setAlert] = useState<PublicationFailure | null>(!initial.ok ? initial.reason : null);
  const [selectedType, setSelectedType] = useState<string>();
  const operations = opening.ok ? opening.operations : null;
  const current = opening.ok ? opening.current : null;
  const phase = workspacePhase({
    operations,
    preview,
    publishing: busy === 'publish',
    activating: busy === 'activate',
    uncertain: Boolean(uncertain),
    stale,
    build,
    completed,
  });

  async function reload() {
    const next = await transport.open(scope, context);
    setOpening(next);
    if (!next.ok) setAlert(next.reason);
    else setAlert(null);
    return next;
  }

  async function reloadComparison() {
    const next = await reload();
    if (!next.ok || document === undefined) return;
    const result = await transport.preview(document, context, next.current?.head ?? null);
    if (!('kind' in result)) {
      setAlert(result.reason);
      return;
    }
    setPreview(result);
    if (result.document) setDocument(result.document);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFilename(file.name);
    setCompleted(null);
    setIndependent(null);
    setUncertain(null);
    setStale(false);
    setBuild(null);
    const text = await file.text();
    const parsed = parseImportedText(file.name, text);
    if ('diagnostics' in parsed) {
      setDocument(undefined);
      setPreview(null);
      setLocalDiagnostics(parsed.diagnostics);
      return;
    }
    setLocalDiagnostics([]);
    setDocument(parsed.document);
    setBusy('preview');
    const result = await transport.preview(parsed.document, context, current?.head ?? null);
    setBusy(null);
    if (!('kind' in result)) {
      setAlert(result.reason);
      setPreview(null);
      return;
    }
    setAlert(null);
    setPreview(result);
    if (result.document) setDocument(result.document);
    setSelectedType(result.types[0]?.id);
  }

  async function run(command: PublicationCommand, kind: 'publish' | 'activate' | 'build') {
    setBusy(kind);
    setAlert(null);
    const result = await transport.submit(command);
    setBusy(null);
    if (!result.ok) {
      if (result.reason === 'uncertain') setUncertain(command);
      if (result.reason === 'stale') {
        setStale(true);
        await reloadComparison();
      }
      setAlert(result.reason);
      return;
    }
    setUncertain(null);
    setStale(false);
    if (kind === 'publish' && preview?.kind !== 'extension') {
      const published = await transport.readRelease(result.result.digest);
      if (published.ok) setIndependent({ digest: published.digest });
    }
    if (kind === 'publish' && preview?.kind === 'extension' && context) {
      const published = await transport.readExtension(context, result.result.digest);
      if (published.ok) setIndependent({ digest: published.digest });
    }
    if (kind === 'activate' || result.result.head !== undefined) setCompleted(result.result);
    if (kind === 'build') {
      const status = await transport.readBuild(result.result.digest);
      if ('ok' in status && status.ok === false) setAlert(status.reason);
      else {
        const next = status as CatalogueBuildStatus;
        setBuild(next);
        if (next.state === 'ready') setIndependent({ digest: next.pin.rootDigest });
      }
    }
  }

  async function onPublish(event: FormEvent) {
    event.preventDefault();
    if (!preview?.identity || document === undefined || !operations?.publish || uncertain) return;
    const published = preview.document ?? document;
    if (preview.kind === 'catalogue') {
      await run(publicationCommand(scope, 'build', newPublicationKey(), preview.identity, { pin: published }), 'build');
      return;
    }
    const body =
      preview.kind === 'extension' ? publishBody('extension', published, context) : publishBody('release', published);
    await run(publicationCommand(scope, 'publish', newPublicationKey(), preview.identity, body, context), 'publish');
  }

  async function onActivate(event: FormEvent) {
    event.preventDefault();
    if (!preview?.identity || !operations?.activate) return;
    const expected =
      preview.kind === 'catalogue'
        ? (preview.current?.head ?? null)
        : opening.ok
          ? (opening.current?.head ?? null)
          : null;
    await run(
      publicationCommand(scope, 'activate', newPublicationKey(), preview.identity, activateBody(expected), context),
      'activate',
    );
  }

  async function onContinueBuild() {
    if (!preview?.identity || !build || !operations?.build) return;
    await run(
      publicationCommand(
        scope,
        'step',
        newPublicationKey(),
        { ...preview.identity, digest: build.pin.rootDigest },
        {},
        context,
      ),
      'build',
    );
  }

  async function onResume() {
    if (!uncertain) return;
    await run(
      uncertain,
      uncertain.operation === 'activate'
        ? 'activate'
        : uncertain.operation === 'step' || uncertain.operation === 'build'
          ? 'build'
          : 'publish',
    );
  }

  async function onCreate() {
    if (!selectedType) return;
    setBusy('create');
    const created = await transport.createSubject(selectedType, newPublicationKey());
    setBusy(null);
    if (!created.ok) {
      setAlert(created.reason);
      return;
    }
    const read = await transport.readSubject(created.id);
    if (read.ok)
      setIndependent({ digest: independent?.digest ?? preview?.identity?.digest ?? created.id, subject: read.id });
  }

  const diagnostics = [...localDiagnostics, ...repairableDiagnostics(preview?.diagnostics ?? [])];
  const comparison = preview?.comparison ?? null;

  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-3">
        <h1
          ref={heading}
          tabIndex={-1}
          className={cn('text-4xl font-semibold tracking-tight text-balance', recoveryClassName)}
        >
          {m.definition_publication_title({}, o)}
        </h1>
        <p className="text-muted-foreground">
          {scope === 'context'
            ? m.definition_publication_extension_intro({}, o)
            : m.definition_publication_intro({}, o)}
        </p>
        <a
          className={buttonVariants({ variant: 'outline', className: actionClassName })}
          href={definitionGuideHref(locale)}
        >
          {m.definition_publication_guide({}, o)}
        </a>
      </header>
      {phase === 'closed' && (
        <p role="alert" tabIndex={-1} className={recoveryClassName}>
          {m.definition_publication_closed({}, o)}
        </p>
      )}
      {alert && phase !== 'closed' && (
        <p role="alert" tabIndex={-1} className={recoveryClassName}>
          {failureCopy(alert, locale)}
        </p>
      )}
      {phase === 'uncertain' && uncertain && (
        <section className="space-y-3">
          <p role="status">{m.definition_publication_uncertain({}, o)}</p>
          <Button className={actionClassName} disabled={busy !== null} onClick={() => void onResume()}>
            {m.definition_publication_resume({}, o)}
          </Button>
        </section>
      )}
      {phase === 'reconciling' && (
        <section className="space-y-3">
          <p role="status">{m.definition_publication_stale({}, o)}</p>
          <Button className={actionClassName} onClick={() => void reloadComparison().then(() => setStale(false))}>
            {m.definition_publication_reload({}, o)}
          </Button>
        </section>
      )}
      {operations?.admitted && phase !== 'closed' && (
        <form className="space-y-4" onSubmit={onPublish}>
          <Field>
            <FieldLabel htmlFor={fileId}>{m.definition_publication_file({}, o)}</FieldLabel>
            <input
              id={fileId}
              type="file"
              disabled={busy !== null || uncertain !== null}
              accept="application/json,.json,.yaml,.yml"
              className={cn(actionClassName, 'block w-full')}
              onChange={(event) => void onFile(event)}
            />
          </Field>
          {filename && <p className="text-sm text-muted-foreground">{filename}</p>}
          {busy === 'preview' && <p role="status">{m.definition_publication_reviewing({}, o)}</p>}
          {diagnostics.length > 0 && (
            <section aria-labelledby={`${fileId}-diagnostics`} className="space-y-2">
              <h2 id={`${fileId}-diagnostics`} className="text-lg font-semibold">
                {m.definition_publication_diagnostics({}, o)}
              </h2>
              <ul>
                {diagnostics.map((diagnostic) => (
                  <li key={`${diagnostic.file ?? ''}:${diagnostic.pointer}:${diagnostic.code}`}>
                    <code className="break-all">{diagnosticField(diagnostic)}</code> {diagnostic.code}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {preview?.identity && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{m.definition_publication_identity({}, o)}</h2>
              <p>
                {m.definition_publication_digest({}, o)}: <code className="break-all">{preview.identity.digest}</code>
              </p>
              {preview.identity.version && (
                <p>
                  {m.definition_publication_version({}, o)}: {preview.identity.version}
                </p>
              )}
              {current && (
                <p>
                  {m.definition_publication_current_head({}, o)}: {current.head}{' '}
                  <code className="break-all">{current.digest}</code>
                </p>
              )}
            </section>
          )}
          {isReleaseComparison(comparison) && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{m.definition_publication_comparison({}, o)}</h2>
              <ComparisonList
                locale={locale}
                label={m.definition_publication_added_types({}, o)}
                values={comparison.addedTypes}
              />
              <ComparisonList
                locale={locale}
                label={m.definition_publication_removed_types({}, o)}
                values={comparison.removedTypes}
              />
              <ComparisonList
                locale={locale}
                label={m.definition_publication_changed_types({}, o)}
                values={comparison.changedTypes}
              />
            </section>
          )}
          {isExtensionComparison(comparison) && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{m.definition_publication_comparison({}, o)}</h2>
              <ComparisonList
                locale={locale}
                label={m.definition_publication_added_terms({}, o)}
                values={comparison.addedTerms}
              />
              <ComparisonList
                locale={locale}
                label={m.definition_publication_removed_terms({}, o)}
                values={comparison.removedTerms}
              />
            </section>
          )}
          {preview?.identity && operations.publish && diagnostics.length === 0 && (
            <Button type="submit" className={actionClassName} disabled={busy !== null || uncertain !== null}>
              {m.definition_publication_publish({}, o)}
            </Button>
          )}
        </form>
      )}
      {phase === 'building' && build && (
        <section className="space-y-3">
          <p role="status">
            {m.definition_publication_build({}, o)}: {build.state} ({build.phase})
          </p>
          {build.missing_digest && <code className="block break-all">{build.missing_digest}</code>}
          {build.error && <p role="alert">{build.error}</p>}
          <Button
            className={actionClassName}
            disabled={busy !== null || uncertain !== null}
            onClick={() => void onContinueBuild()}
          >
            {m.definition_publication_continue_build({}, o)}
          </Button>
        </section>
      )}
      {preview?.identity && operations?.activate && (independent || completed) && phase !== 'completed' && (
        <form className="space-y-3" onSubmit={onActivate}>
          <Button type="submit" className={actionClassName} disabled={busy !== null || uncertain !== null}>
            {m.definition_publication_activate({}, o)}
          </Button>
        </form>
      )}
      {phase === 'completed' && completed && (
        <section className="space-y-4">
          <p role="status">
            {m.definition_publication_completed({}, o)} <code className="break-all">{completed.digest}</code>
          </p>
          {preview?.types.length ? (
            <Field>
              <FieldLabel htmlFor={`${fileId}-type`}>{m.definition_publication_create_type({}, o)}</FieldLabel>
              <NativeSelect
                id={`${fileId}-type`}
                value={selectedType ?? ''}
                onChange={(event) => setSelectedType(event.target.value)}
              >
                {preview.types.map((type) => (
                  <NativeSelectOption key={type.id} value={type.id}>
                    {type.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {selectedType && (
            <Button
              className={actionClassName}
              onClick={() => void onCreate()}
              disabled={busy !== null || uncertain !== null}
            >
              {m.definition_publication_create_subject({}, o)}
            </Button>
          )}
          {independent?.subject && (
            <a
              className={buttonVariants({ variant: 'outline', className: actionClassName })}
              href={`/${locale}/subjects/${independent.subject}`}
            >
              {m.definition_publication_read_subject({}, o)}
            </a>
          )}
          {independent?.digest && (
            <a
              className={buttonVariants({ variant: 'outline', className: actionClassName })}
              href={definitionGuideHref(locale, { release: independent.digest })}
            >
              {m.definition_publication_read_release({}, o)}
            </a>
          )}
        </section>
      )}
      <p className="sr-only">{publicationHref(locale, scope, context)}</p>
    </article>
  );
}

function ComparisonList({ locale, label, values }: { locale: string; label: string; values: readonly string[] }) {
  if (values.length === 0) return null;
  void locale;
  return (
    <div>
      <h3 className="font-medium">{label}</h3>
      <ul>
        {values.map((value) => (
          <li key={value}>
            <code className="break-all">{value}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
