import { UI_LOCALES, platformRegistry, zonePrimaryLanguage, type CompositionDocument } from '@rezics/composition';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useId } from 'react';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import type { Failure, ZoneConfigureInput } from './model';

export type FieldIssue = { pointer: string; code: string };
export type CorrectionTarget = {
  id: string;
  pageIndex?: number;
  language?: string;
};
export type Guidance = { label: string; help: string; target?: CorrectionTarget };
export type FailureContext = 'read' | 'save' | 'publish' | 'write' | 'preview';

/** Decode RFC 6901 once. URI fragments, URI encoding and malformed escapes are not pointer aliases. */
function segments(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer)) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}
const indexOf = (value: string | undefined) =>
  value !== undefined && /^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;

type PropertySchema = { properties?: Record<string, PropertySchema>; items?: PropertySchema };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function propertyPath(value: unknown, schema: PropertySchema | undefined, parts: string[]): boolean {
  for (const part of parts) {
    if (Array.isArray(value)) {
      const index = indexOf(part);
      if (index === undefined || index >= value.length) return false;
      value = value[index];
      schema = schema?.items;
    } else {
      const property =
        schema?.properties && Object.hasOwn(schema.properties, part) ? schema.properties[part] : undefined;
      if (!(object(value) && Object.hasOwn(value, part)) && !property) return false;
      value = object(value) && Object.hasOwn(value, part) ? value[part] : undefined;
      schema = property;
    }
  }
  return true;
}

/** Follow the current document and registry grammar without displaying any document values.
 * Missing required properties are known; removed nodes and invented paths are not targets. */
function documentPath(document: CompositionDocument, parts: string[]): boolean {
  if (!parts.length) return true;
  if (parts[0] === 'root')
    return (
      parts.length === 1 ||
      (parts[1] === 'props' &&
        propertyPath(document.root.props, platformRegistry.root as PropertySchema, parts.slice(2)))
    );
  function nodes(items: unknown, path: string[]): boolean {
    if (!path.length) return true;
    const index = indexOf(path[0]);
    if (!Array.isArray(items) || index === undefined || index >= items.length) return false;
    if (path.length === 1) return true;
    const node = items[index];
    if (!object(node)) return false;
    if (path[1] === 'type') return path.length === 2;
    if (path[1] !== 'props') return false;
    const component = platformRegistry.components.find((item) => item.type === node.type);
    if (path[2] && component?.slots.includes(path[2]))
      return nodes(object(node.props) ? node.props[path[2]] : undefined, path.slice(3));
    return propertyPath(node.props, component?.props as PropertySchema | undefined, path.slice(2));
  }
  return parts[0] === 'content' && nodes(document.content, parts.slice(1));
}

/** Only established configuration-relative and command-envelope forms acquire correction targets.
 * Labels never come from a pointer token or a problem payload value. */
export function fieldGuidance(issue: FieldIssue, draft: ZoneConfigureInput | undefined, locale: string): Guidance {
  const options = { locale: locale as never };
  const generic = { label: m.zone_editor_heading({}, options), help: m.zone_recovery_generic({}, options) };
  const parts = segments(issue.pointer);
  if (!parts) return generic;
  const configuration = parts[0] === 'configuration';
  if (configuration) parts.shift();
  const [field, token] = parts;
  const result = (label: string, help: string, target?: CorrectionTarget): Guidance => ({
    label,
    help,
    ...(target && draft ? { target } : {}),
  });
  if (field === 'labels') {
    if (parts.length === 1)
      return result(m.zone_editor_labels({}, options), m.zone_recovery_names({}, options), { id: 'zone-names' });
    if (parts.length !== 2 || !UI_LOCALES.some((language) => language === token)) return generic;
    const language = token!;
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
    const primary = draft ? (zonePrimaryLanguage(draft.configuration) ?? 'en') : undefined;
    const exists = draft && (language === primary || Object.hasOwn(draft.configuration.labels, language));
    return result(m.zone_recovery_name({ language: name }, options), m.zone_name_invalid({ language: name }, options), {
      id: exists ? `zone-label-${language}` : 'zone-names',
      ...(exists ? { language } : {}),
    });
  }
  if (field === 'primaryLanguage' && parts.length === 1)
    return result(m.zone_name_language({}, options), m.zone_recovery_names({}, options), {
      id: 'zone-primary-language',
    });
  if (field === 'pages') {
    if (parts.length === 1)
      return result(m.zone_editor_pages({}, options), m.zone_recovery_pages({}, options), { id: 'zone-pages-heading' });
    const index = indexOf(token);
    const page = index === undefined ? undefined : draft?.configuration.pages[index];
    // A removed or out-of-range page is never replaced by the first page or an adjacent index.
    if (!page || index === undefined) return generic;
    if (parts.length === 2)
      return result(m.zone_editor_pages({}, options), m.zone_recovery_pages({}, options), {
        id: 'zone-pages-heading',
        pageIndex: index,
      });
    if (parts[2] === 'route' && parts.length === 3)
      return result(m.zone_recovery_route({ page: index + 1 }, options), m.zone_editor_route_help({}, options), {
        id: page.route === '' ? 'zone-pages-heading' : 'zone-route',
        pageIndex: index,
      });
    if (parts[2] === 'document' && documentPath(page.document, parts.slice(3)))
      return result(m.zone_recovery_document({ page: index + 1 }, options), m.zone_recovery_composition({}, options), {
        id: 'zone-compose',
        pageIndex: index,
      });
    return generic;
  }
  if (field === 'scope' && (parts.length === 1 || (parts.length === 2 && indexOf(token) !== undefined))) {
    const index = indexOf(token);
    if (index !== undefined && (!draft || index >= draft.configuration.scope.length)) return generic;
    return result(m.zone_editor_scopes({}, options), m.zone_recovery_scopes({}, options), { id: 'zone-scopes' });
  }
  if (
    !configuration &&
    field === 'mounts' &&
    (parts.length === 1 || (parts.length === 2 && indexOf(token) !== undefined))
  ) {
    const index = indexOf(token);
    if (index !== undefined && (!draft || index >= draft.mounts.length)) return generic;
    return result(m.zone_editor_mounts({}, options), m.zone_recovery_mounts({}, options), { id: 'zone-mounts' });
  }
  if (!configuration && field === 'visibility' && parts.length === 1)
    return result(m.zone_editor_visibility({}, options), m.zone_recovery_visibility({}, options), {
      id: 'zone-visibility',
    });
  return generic;
}

export function TechnicalDetails({
  failure,
  issues = failure?.errors ?? [],
  locale,
}: {
  failure?: Failure;
  issues?: FieldIssue[];
  locale: string;
}) {
  const options = { locale: locale as never };
  return (
    <details className="min-w-0">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.zone_recovery_details({}, options)}</summary>
      {failure ? (
        <p className="break-words">
          <code>
            {failure.status} · {failure.code}
          </code>
        </p>
      ) : null}
      {issues.length ? (
        <ul className="list-disc ps-5">
          {issues.map((issue, index) => (
            <li key={index} className="break-all">
              <code>
                {JSON.stringify(issue.pointer)} · {issue.code}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function FieldGuidanceList({
  issues,
  draft,
  locale,
  onCorrect,
  issuePrefix,
}: {
  issues: FieldIssue[];
  issuePrefix?: string | undefined;
  draft?: ZoneConfigureInput | undefined;
  locale: string;
  onCorrect?: ((target: CorrectionTarget) => void) | undefined;
}) {
  const options = { locale: locale as never };
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {issues.map((issue, index) => {
        const guidance = fieldGuidance(issue, draft, locale);
        return (
          <li
            key={index}
            id={issuePrefix ? `${issuePrefix}-${index}` : undefined}
            className="flex min-w-0 flex-col items-start gap-1"
          >
            <p>
              <strong>{guidance.label}</strong>: {guidance.help}
            </p>
            {guidance.target && onCorrect ? (
              <Button
                type="button"
                variant="outline"
                className="h-auto max-w-full whitespace-normal py-2 text-start"
                onClick={() => onCorrect(guidance.target!)}
              >
                {m.zone_recovery_correct({ field: guidance.label }, options)}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function EditorFailure({
  failure,
  context = 'read',
  locale = getLocale(),
  draft,
  onCorrect,
  issuePrefix,
  id,
}: {
  failure: Failure;
  issuePrefix?: string;
  id?: string;
  context?: FailureContext;
  locale?: string;
  draft?: ZoneConfigureInput | undefined;
  onCorrect?: ((target: CorrectionTarget) => void) | undefined;
}) {
  const options = { locale: locale as never };
  const title =
    failure.status === 404
      ? m.not_found_message({}, options)
      : failure.status === 401
        ? m.zone_editor_signed_out({}, options)
        : failure.code === 'platform_closed'
          ? m.zone_editor_closed({}, options)
          : failure.status === 403
            ? m.zone_editor_denied({}, options)
            : failure.status === 412
              ? m.zone_editor_conflict({}, options)
              : failure.code === 'semantic_not_ready'
                ? m.zone_recovery_source({}, options)
                : failure.errors?.length
                  ? m.zone_editor_validation({}, options)
                  : m.zone_recovery_unavailable({}, options);
  const uncertain = ![400, 401, 403, 404, 412].includes(failure.status);
  const consequence =
    context === 'preview'
      ? m.zone_recovery_preview({}, options)
      : context === 'read'
        ? m.zone_recovery_read({}, options)
        : uncertain
          ? context === 'publish'
            ? m.zone_recovery_publish_unknown({}, options)
            : context === 'save'
              ? m.zone_recovery_save_unknown({}, options)
              : m.zone_recovery_write_unknown({}, options)
          : m.zone_recovery_retained({}, options);
  const description = useId();
  return (
    <Alert id={id} tabIndex={-1} className="min-w-0" aria-describedby={description}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription id={description} className="flex min-w-0 flex-col gap-3">
        <p>{consequence}</p>
        {failure.retryAfter ? <p>{m.zone_editor_retry_after({ seconds: failure.retryAfter }, options)}</p> : null}
        {failure.errors?.length ? (
          <FieldGuidanceList
            issues={failure.errors}
            draft={draft}
            locale={locale}
            onCorrect={onCorrect}
            issuePrefix={issuePrefix}
          />
        ) : null}
      </AlertDescription>
      <TechnicalDetails failure={failure} locale={locale} />
    </Alert>
  );
}
