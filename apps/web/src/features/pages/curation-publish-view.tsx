import {
  isView,
  platformRegistry,
  profileDigest,
  templateViews,
  validateProfile,
  type CompositionNode,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { languageName } from '../../subject/language';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { presentationMessageOptions } from './curate-view-editor-messages';
import { useCurationPublicationFocus } from './curation-publication-focus';
import {
  CurationPublication,
  type ActiveCuration,
  type PublicationConfirmation,
  type PublicationRead,
  type CurationPublicationVisit,
} from './curation-publish';

export type ValidationCorrection = { describe: (pointer: string) => string; correct: (pointer: string) => void };
type MessageOptions = ReturnType<typeof presentationMessageOptions>;

export function CurationFailureNotice({
  failure,
  correction,
  busy = false,
  locale,
}: {
  failure: Exclude<PublicationRead, { ok: true }>;
  correction?: ValidationCorrection | undefined;
  busy?: boolean;
  locale?: string | undefined;
}) {
  const options = presentationMessageOptions(locale);
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-card p-4">
      {failure.reason === 'invalid' && failure.phase === 'activate' ? null : (
        <p>
          {failure.reason === 'invalid'
            ? m.curation_invalid({}, options)
            : failure.reason === 'stale'
              ? m.curation_stale({}, options)
              : failure.reason === 'signed-out'
                ? m.curation_signed_out({}, options)
                : failure.reason === 'forbidden'
                  ? m.curation_forbidden({}, options)
                  : failure.reason === 'rate-limited'
                    ? m.curation_limited({}, options)
                    : failure.reason === 'unavailable' && failure.outcome === 'unknown'
                      ? m.curation_unknown({}, options)
                      : m.curation_unavailable({}, options)}
        </p>
      )}
      {'phase' in failure && failure.phase === 'activate' ? <p>{m.curation_partial({}, options)}</p> : null}
      {failure.reason === 'rate-limited' && failure.retryAfter !== undefined ? (
        <p>{m.curation_retry_after({ seconds: failure.retryAfter }, options)}</p>
      ) : null}
      {failure.reason === 'invalid' && failure.phase !== 'activate' ? (
        <ul className="space-y-3">
          {failure.errors.map(({ pointer, code }, index) => (
            <li key={index}>
              <p>{correction?.describe(pointer) ?? m.curation_correction_unknown({}, options)}</p>
              {correction && (
                <Button
                  className="min-h-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                  disabled={busy}
                  onClick={() => correction.correct(pointer)}
                >
                  {m.curation_correct({}, options)}
                </Button>
              )}
              <details className="break-all text-sm">
                <summary>{m.curation_diagnostics({}, options)}</summary>
                <code>
                  {pointer || '/'} — {code}
                </code>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type ReviewSchema = {
  properties?: Record<string, ReviewSchema>;
  items?: ReviewSchema;
  anyOf?: readonly ReviewSchema[];
  const?: unknown;
};
type ReviewField = { section: string; label: string; value: unknown; schema?: ReviewSchema | undefined };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const reviewComponents = new Map(platformRegistry.components.map((component) => [component.type, component]));
const bounded = (value: string) => (value.length > 180 ? `${value.slice(0, 180)}…` : value);
const emptyObject = Symbol('empty object');

function fieldLabel(field: string, known: boolean, options: MessageOptions): string {
  const labels: Record<string, () => string> = {
    appearance: () => m.curation_review_appearance({}, options),
    density: () => m.curation_review_density({}, options),
    radius: () => m.curation_review_radius({}, options),
    surface: () => m.curation_review_surface({}, options),
    cover: () => m.curation_review_cover({}, options),
    headingScale: () => m.curation_review_heading_scale({}, options),
    text: () => m.curation_review_text({}, options),
    title: () => m.curation_review_title({}, options),
    level: () => m.curation_review_level({}, options),
    gap: () => m.curation_review_gap({}, options),
    split: () => m.curation_review_split({}, options),
    limit: () => m.curation_review_limit({}, options),
    paged: () => m.curation_review_paged({}, options),
    id: () => m.curation_review_reference({}, options),
    children: () => m.curation_review_children({}, options),
    start: () => m.curation_review_first_column({}, options),
    end: () => m.curation_review_last_column({}, options),
  };
  if (!known) return m.curation_review_unknown_field({ field: bounded(field) }, options);
  // Other registered fields retain the same names as the installed editor.
  return labels[field]?.() ?? field.replace(/([a-z])([A-Z])/gu, '$1 $2');
}

/** A bounded, local reading of actual profile fields; never resolves templates or reads page data. */
function reviewFields(profile: PresentationProfile, locale?: string): Map<string, ReviewField> {
  const options = presentationMessageOptions(locale);
  const namesLocale = options?.locale ?? getLocale();
  const fields = new Map<string, ReviewField>();
  const viewLabels: Record<View, () => string> = {
    overview: () => m.subject_overview({}, options),
    editions: () => m.subject_editions({}, options),
    contents: () => m.subject_contents({}, options),
    characters: () => m.subject_characters({}, options),
    appearances: () => m.subject_appearances({}, options),
    credits: () => m.subject_credits({}, options),
    works: () => m.subject_works({}, options),
    relations: () => m.subject_relations({}, options),
    posts: () => m.subject_posts({}, options),
    reviews: () => m.subject_reviews({}, options),
    discussion: () => m.subject_discussion({}, options),
    lists: () => m.subject_lists({}, options),
    collections: () => m.subject_collections({}, options),
    details: () => m.subject_details({}, options),
  };
  const scopes = {
    generic: () => m.curation_generic({}, options),
    base: () => m.curation_base({}, options),
    type: () => m.curation_type({}, options),
    route: () => m.curation_route({}, options),
  };
  function add(section: string, path: string[], label: string[], value: unknown, schema?: ReviewSchema) {
    fields.set(JSON.stringify([section, ...path]), { section, label: label.join(' · '), value, schema });
  }
  function walk(section: string, path: string[], labels: string[], value: unknown, schema?: ReviewSchema) {
    if (record(value)) {
      const choice = schema?.anyOf?.find((option) =>
        Object.entries(option.properties ?? {}).some(
          ([key, property]) => Object.hasOwn(property, 'const') && value[key] === property.const,
        ),
      );
      const properties = (choice ?? schema)?.properties;
      // Localized text maps keep every language, including changes outside the current UI language.
      const localized = (schema as { '~safety'?: string } | undefined)?.['~safety'] === 'localizedText';
      if (!Object.keys(value).length) add(section, path, labels, emptyObject);
      for (const [key, child] of Object.entries(value)) {
        const language = localized ? languageName(key, namesLocale) : undefined;
        walk(
          section,
          [...path, key],
          [...labels, language ? `${language} (${key})` : fieldLabel(key, !!properties?.[key], options)],
          child,
          properties?.[key],
        );
      }
    } else if (Array.isArray(value)) {
      add(section, [...path, '$count'], labels, value.length);
      value.forEach((child, index) =>
        walk(section, [...path, String(index)], [...labels, String(index + 1)], child, schema?.items),
      );
    } else add(section, path, labels, value, schema);
  }
  add(m.curation_review_profile({}, options), ['format'], [m.curation_review_format({}, options)], profile.format);
  for (const [key, value] of Object.entries(profile)) {
    if (!['format', 'generic', 'bases', 'types', 'routes'].includes(key))
      walk(m.curation_review_profile({}, options), [key], [fieldLabel(key, false, options)], value);
  }
  const templates = [
    { scope: 'generic' as const, key: null, body: profile.generic },
    ...profile.bases.map((body) => ({ scope: 'base' as const, key: body.base, body })),
    ...profile.types.map((body) => ({ scope: 'type' as const, key: body.type, body })),
    ...profile.routes.map((body) => ({ scope: 'route' as const, key: body.route, body })),
  ];
  for (const template of templates) {
    const { body } = template;
    const documents = templateViews(body);
    const templateName = template.key === null ? scopes.generic() : `${scopes[template.scope]()} · ${template.key}`;
    for (const [view, document] of Object.entries(documents)) {
      const section = `${templateName} · ${isView(view) ? viewLabels[view]() : m.curation_review_unknown_field({ field: bounded(view) }, options)}`;
      // Template keys and view names, not array positions, identify corresponding documents.
      const prefix = [template.scope, template.key ?? '', view];
      add(section, [...prefix, '$document'], [m.curation_view({}, options)], m.curation_review_present({}, options));
      walk(
        section,
        [...prefix, 'root'],
        [m.curation_page_settings({}, options)],
        document.root.props,
        platformRegistry.root as ReviewSchema,
      );
      function nodes(content: CompositionNode[], path: string[], labels: string[]) {
        add(section, [...path, '$count'], [...labels, m.curation_review_components({}, options)], content.length);
        content.forEach((node, index) => {
          const definition = reviewComponents.get(node.type);
          const name = definition
            ? node.type.replace(/([a-z])([A-Z])/gu, '$1 $2')
            : m.curation_review_unknown_component({ type: bounded(node.type) }, options);
          const nodePath = [...path, String(index)];
          const nodeLabels = [
            ...labels,
            m.curation_review_component({ position: index + 1, component: name }, options),
          ];
          add(section, [...nodePath, '$type'], nodeLabels, node.type);
          const properties = (definition?.props as ReviewSchema | undefined)?.properties;
          for (const [key, value] of Object.entries(node.props)) {
            if (definition?.slots.includes(key) && Array.isArray(value))
              nodes(value as CompositionNode[], [...nodePath, key], [...nodeLabels, fieldLabel(key, true, options)]);
            else
              walk(
                section,
                [...nodePath, key],
                [
                  ...nodeLabels,
                  fieldLabel(key, key === 'id' || !!properties?.[key] || !!definition?.slots.includes(key), options),
                ],
                value,
                properties?.[key],
              );
          }
          for (const [key, value] of Object.entries(node)) {
            if (!['type', 'props'].includes(key))
              walk(section, [...nodePath, '$extra', key], [...nodeLabels, fieldLabel(key, false, options)], value);
          }
        });
      }
      nodes(document.content, [...prefix, 'content'], []);
      for (const [key, value] of Object.entries(document)) {
        if (!['root', 'content'].includes(key))
          walk(section, [...prefix, '$documentExtra', key], [fieldLabel(key, false, options)], value);
      }
      for (const [key, value] of Object.entries(document.root)) {
        if (key !== 'props')
          walk(
            section,
            [...prefix, '$rootExtra', key],
            [m.curation_page_settings({}, options), fieldLabel(key, false, options)],
            value,
          );
      }
      for (const [key, value] of Object.entries(body)) {
        if (
          body !== document &&
          !['views', 'document', ...(template.key === null ? [] : [template.scope])].includes(key)
        )
          walk(section, [...prefix, '$extra', key], [fieldLabel(key, false, options)], value);
      }
    }
  }
  return fields;
}

function reviewValue(field: ReviewField | undefined, options: MessageOptions) {
  if (!field) return m.curation_review_absent({}, options);
  const value = field.value;
  const choices =
    field.schema && Object.hasOwn(field.schema, 'const')
      ? [field.schema.const]
      : field.schema?.anyOf?.filter((option) => Object.hasOwn(option, 'const')).map((option) => option.const);
  if (choices?.length && !choices.includes(value))
    return m.curation_review_unknown_value({ value: bounded(String(value)) }, options);
  const tokens: Record<string, () => string> = {
    compact: () => m.curation_review_compact({}, options),
    comfortable: () => m.curation_review_comfortable({}, options),
    sm: () => m.library_size_small({}, options),
    md: () => m.library_size_medium({}, options),
    lg: () => m.library_size_large({}, options),
    flat: () => m.curation_review_flat({}, options),
    cards: () => m.curation_review_cards({}, options),
    portrait: () => m.curation_review_portrait({}, options),
    square: () => m.curation_review_square({}, options),
    landscape: () => m.curation_review_landscape({}, options),
    even: () => m.curation_review_even({}, options),
    start: () => m.curation_review_start({}, options),
    end: () => m.curation_review_end({}, options),
  };
  if (choices?.includes(value) && typeof value === 'string') return tokens[value]?.() ?? value;
  if (typeof value === 'boolean') return value ? m.curation_review_yes({}, options) : m.curation_review_no({}, options);
  if (value === emptyObject) return m.curation_review_empty_object({}, options);
  if (value === null) return m.curation_review_unknown_value({ value: 'null' }, options);
  if (value === '') return m.curation_review_empty({}, options);
  return bounded(String(value));
}

/** Native details remain exact; this summary uses only the two supplied snapshots. */
export function CurationProfileComparison({
  draft,
  active,
  locale,
}: {
  draft: PresentationProfile;
  active: PresentationProfile;
  locale?: string | undefined;
}) {
  const options = presentationMessageOptions(locale);
  const left = reviewFields(draft, locale);
  const right = reviewFields(active, locale);
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key);
    const b = right.get(key);
    (a && b && Object.is(a.value, b.value) ? unchanged : changed).push(key);
  }
  function rows(keys: string[]) {
    const sections = new Map<string, string[]>();
    for (const key of keys) {
      const section = (left.get(key) ?? right.get(key))!.section;
      const group = sections.get(section) ?? [];
      group.push(key);
      sections.set(section, group);
    }
    return [...sections].map(([section, entries]) => (
      <section key={section} className="min-w-0 space-y-2">
        <h4 className="font-semibold [overflow-wrap:anywhere]">{section}</h4>
        <dl className="space-y-3">
          {entries.map((key) => (
            <div key={key} className="min-w-0 rounded-lg border border-border p-3 [overflow-wrap:anywhere]">
              <dt className="text-sm font-medium">{(left.get(key) ?? right.get(key))!.label}</dt>
              <dd className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{m.curation_draft({}, options)}</p>
                  <p className="whitespace-pre-wrap">{reviewValue(left.get(key), options)}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{m.curation_active({}, options)}</p>
                  <p className="whitespace-pre-wrap">{reviewValue(right.get(key), options)}</p>
                </div>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    ));
  }
  return (
    <section aria-label={m.curation_compare({}, options)} className="min-w-0 space-y-4">
      <h3 className="font-semibold">{m.curation_compare({}, options)}</h3>
      <p className="text-sm">{m.curation_review_scope({}, options)}</p>
      <p role="status">
        {changed.length
          ? m.curation_review_changed({ count: changed.length }, options)
          : m.curation_review_same({}, options)}
      </p>
      {rows(changed)}
      {unchanged.length ? (
        <details className="min-w-0 space-y-3">
          <summary className="cursor-pointer [overflow-wrap:anywhere]">
            {m.curation_review_unchanged({ count: unchanged.length }, options)}
          </summary>
          {rows(unchanged)}
        </details>
      ) : null}
    </section>
  );
}

/** Publication recovery consumes the editor's draft, without owning document selection or edits. */
export function CurationPublicationRecovery({
  publication,
  visit,
  profile,
  head,
  onPublished,
  onReviewed,
  correction,
  locale,
}: {
  publication: CurationPublication;
  visit?: CurationPublicationVisit;
  profile: PresentationProfile;
  head: number;
  onPublished: (confirmation: PublicationConfirmation) => void;
  onReviewed: (active: ActiveCuration, choice: 'keep' | 'discard') => void;
  correction?: ValidationCorrection;
  locale?: string | undefined;
}) {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [publication]);
  const { intent, result, active, readFailure, busy, retryAt, readRetryAt } = useSyncExternalStore(
    publication.subscribe,
    publication.getSnapshot,
    publication.getSnapshot,
  );
  const focus = useCurationPublicationFocus(
    visit ? { publication, visit } : { publication },
    busy,
    intent,
    result,
  );
  const waiting = useSearchRetryWait(result?.ok === false && result.reason === 'rate-limited' ? retryAt : undefined);
  const inspectionWaiting = useSearchRetryWait(readRetryAt);
  const options = presentationMessageOptions(locale);
  if (!intent && !result) return null;
  const stale = result?.ok === false && result.reason === 'stale';
  const invalid = result?.ok === false && result.reason === 'invalid' && result.phase !== 'activate';
  function reconcile(choice: 'keep' | 'discard') {
    if (!mounted.current || (visit && !visit.isCurrent())) return;
    const reviewed = visit ? visit.reconcile(profile, choice) : publication.reconcile(profile, choice);
    if (mounted.current && (!visit || visit.isCurrent()) && reviewed) onReviewed(reviewed, choice);
  }
  async function retry() {
    if (!mounted.current || (visit && !visit.isCurrent())) return;
    const confirmation = visit ? await visit.retry() : await publication.retry();
    if (mounted.current && (!visit || visit.isCurrent()) && confirmation) onPublished(confirmation);
  }
  async function replaceIntent() {
    if (!mounted.current || (visit && !visit.isCurrent())) return;
    const confirmation = visit
      ? await visit.replaceInvalid(profile, head)
      : await publication.replaceInvalid(profile, head);
    if (mounted.current && (!visit || visit.isCurrent()) && confirmation) onPublished(confirmation);
  }
  const inspect = () => {
    if (!mounted.current || (visit && !visit.isCurrent())) return;
    void (visit ? visit.inspect() : publication.inspect());
  };
  const draftValid = validateProfile(platformRegistry, profile).length === 0;
  const draftDigest = draftValid ? profileDigest(profile) : undefined;
  const originalDigest = intent ? profileDigest(intent.profile) : undefined;
  const revisedValid = invalid && draftValid;
  const laterChanges = !!intent && (!draftValid || draftDigest !== originalDigest);
  const controlClass = 'min-h-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';
  return (
    <section
      ref={focus.regionRef}
      tabIndex={-1}
      aria-label={m.curation_recovery({}, options)}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-busy={busy}
    >
      <h2 className="font-semibold">{m.curation_recovery({}, options)}</h2>
      {result?.ok ? (
        <>
          <p role="status">{m.presentation_editor_published({}, options)}</p>
          <details className="text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_publication_details({}, options)}</summary>
            <p className="mt-2 break-all font-mono">
              {m.presentation_editor_version_reference({ head: result.head, digest: result.digest }, options)}
            </p>
            <p>{m.curation_published({ head: result.head }, options)}</p>
          </details>
        </>
      ) : null}
      {result?.ok === false ? (
        <CurationFailureNotice failure={result} correction={correction} busy={busy} locale={locale} />
      ) : null}
      {busy ? <p role="status">{m.curation_review_working({}, options)}</p> : null}
      {intent ? (
        <>
          <p>
            {invalid
              ? m.curation_invalid_retained({}, options)
              : stale
                ? m.curation_review_stale({}, options)
                : m.presentation_editor_publication_pending({}, options)}
          </p>
          <p className="text-sm">
            {laterChanges ? m.curation_review_later({}, options) : m.curation_review_original_unchanged({}, options)}
          </p>
          <div className="space-y-2">
            <p className="text-sm">{m.curation_review_inspect_help({}, options)}</p>
            <Button variant="outline" className={controlClass} disabled={busy || inspectionWaiting} onClick={inspect}>
              {m.curation_reload_head({}, options)}
            </Button>
          </div>
        </>
      ) : null}
      {readFailure ? (
        <div className="space-y-2">
          <h3 className="font-semibold">{m.curation_review_read_failed({}, options)}</h3>
          <CurationFailureNotice failure={readFailure} locale={locale} />
        </div>
      ) : null}
      {intent && !active ? <p>{m.curation_review_no_active({}, options)}</p> : null}
      {active ? (
        <div className="min-w-0 space-y-4">
          <CurationProfileComparison draft={profile} active={active.profile} locale={locale} />
          {stale ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <p>{m.curation_review_help({}, options)}</p>
                <Button className={controlClass} disabled={busy} onClick={() => reconcile('keep')}>
                  {m.curation_reconcile({}, options)}
                </Button>
              </div>
              <div className="space-y-2">
                <p>{m.curation_review_discard_help({}, options)}</p>
                <Button variant="outline" className={controlClass} disabled={busy} onClick={() => reconcile('discard')}>
                  {m.curation_discard({}, options)}
                </Button>
              </div>
            </div>
          ) : (
            <p>{m.curation_resolve_first({}, options)}</p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_active_version_details({}, options)}</summary>
            <p className="mt-2 break-all font-mono">
              {m.curation_actual_head({ head: active.head, digest: active.digest }, options)}
            </p>
            <pre className="mt-2 max-h-80 overflow-auto text-xs" tabIndex={0}>
              {JSON.stringify(active.profile, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
      {intent ? (
        <>
          {!invalid ? (
            <div className="space-y-2">
              <p className="text-sm">{m.curation_review_retry_help({}, options)}</p>
              <Button
                ref={focus.actionRef}
                variant="outline"
                className={controlClass}
                disabled={busy || waiting}
                onClick={(event) => {
                  focus.noteActivation(event.currentTarget);
                  void retry();
                }}
              >
                {m.curation_retry_original({}, options)}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p>{m.curation_review_replace_help({}, options)}</p>
              {!revisedValid || !laterChanges ? (
                <p className="text-sm">{m.curation_review_revision_required({}, options)}</p>
              ) : null}
              <Button
                ref={focus.actionRef}
                className={controlClass}
                disabled={busy || !revisedValid || !laterChanges}
                onClick={(event) => {
                  focus.noteActivation(event.currentTarget);
                  void replaceIntent();
                }}
              >
                {m.curation_new_intent({}, options)}
              </Button>
            </div>
          )}
          <details className="min-w-0 space-y-3 text-sm">
            <summary className="cursor-pointer">{m.presentation_editor_publication_details({}, options)}</summary>
            <section className="min-w-0 space-y-2">
              <h3 className="font-semibold">{m.curation_review_original({}, options)}</h3>
              <p>{m.curation_retained({ head: intent.expectedHead }, options)}</p>
              <p className="break-all font-mono">
                {m.presentation_editor_version_reference(
                  { head: intent.expectedHead, digest: originalDigest! },
                  options,
                )}
              </p>
              <pre className="max-h-80 overflow-auto text-xs" tabIndex={0}>
                {JSON.stringify(intent.profile, null, 2)}
              </pre>
            </section>
            <section className="min-w-0 space-y-2">
              <h3 className="font-semibold">{m.curation_draft({}, options)}</h3>
              <p className="break-all font-mono">
                {draftDigest
                  ? m.presentation_editor_version_reference({ head, digest: draftDigest }, options)
                  : m.curation_head({ head }, options)}
              </p>
              <pre className="max-h-80 overflow-auto text-xs" tabIndex={0}>
                {JSON.stringify(profile, null, 2)}
              </pre>
            </section>
          </details>
        </>
      ) : null}
    </section>
  );
}
