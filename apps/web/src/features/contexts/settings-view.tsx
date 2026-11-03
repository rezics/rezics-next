import { useId, useState } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import {
  emptyLabelRow,
  filterSettings,
  labelRowIssue,
  pageSettings,
  propertyCaption,
  settingsChoice,
  type CapturedPolicy,
  type DefaultMode,
  type LabelRow,
  type SettingsPreview,
  type SettingsRead,
  type SettingsSnapshot,
} from './settings';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] max-md:min-h-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const formControlClass =
  'h-auto min-h-8 min-w-0 max-w-full max-md:min-h-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const languageControlClass =
  'max-w-full max-md:w-full pointer-coarse:w-full md:pointer-fine:w-fit max-md:[&_select]:h-11 max-md:[&_select]:min-h-11 pointer-coarse:[&_select]:h-11 pointer-coarse:[&_select]:min-h-11 md:pointer-fine:[&_select]:h-8';
const summaryClassName =
  'min-h-11 min-w-11 cursor-pointer content-center py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const options = (locale: string) => ({ locale: locale as never });

export function ContextLabelRows({
  locale,
  rows,
  disabled,
  invalidId,
  onChange,
  control,
  languageLabel,
  nameLabel,
  nameHelp,
}: {
  locale: string;
  rows: readonly LabelRow[];
  disabled: boolean;
  invalidId?: string;
  onChange: (rows: LabelRow[]) => void;
  control?: string;
  languageLabel?: string;
  nameLabel?: string;
  nameHelp?: string;
}) {
  const o = options(locale);
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const languageText = languageLabel ?? m.ctxw_language({}, o);
  const nameText = nameLabel ?? m.ctxw_label({}, o);
  const helpText = nameHelp ?? m.ctxw_label_help({}, o);
  return (
    <div className="space-y-4" data-context-labels>
      {rows.map((row, index) => {
        const issue = labelRowIssue(rows, row);
        const languageId = `${row.id}-language`;
        const textId = `${row.id}-text`;
        return (
          <fieldset
            key={row.id}
            id={row.id}
            disabled={disabled}
            className="min-w-0 space-y-3 rounded-lg border border-border p-3"
            data-context-label-row={row.id}
          >
            <legend className="px-1 text-sm font-semibold">{nameText}</legend>
            <Field data-invalid={issue === 'language' || issue === 'duplicate' || undefined}>
              <FieldLabel htmlFor={languageId}>{languageText}</FieldLabel>
              <NativeSelect
                id={languageId}
                className={languageControlClass}
                data-editorial-control={control}
                value={row.language}
                disabled={disabled}
                onChange={(event) => {
                  const language = event.target.value;
                  onChange(rows.map((entry) => (entry.id === row.id ? { ...entry, language } : entry)));
                }}
              >
                {locales.map((language) => (
                  <NativeSelectOption key={language} value={language}>
                    {names.of(language) ?? language}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {issue === 'duplicate' ? (
                <FieldError>{m.ctxw_label_duplicate({}, o)}</FieldError>
              ) : issue === 'language' ? (
                <FieldError>{m.ctxw_invalid({}, o)}</FieldError>
              ) : null}
            </Field>
            <Field data-invalid={invalidId === textId || issue === 'text' || undefined}>
              <FieldLabel htmlFor={textId}>{nameText}</FieldLabel>
              <Input
                id={textId}
                className={formControlClass}
                data-editorial-control={control}
                lang={row.language}
                value={row.text}
                required
                maxLength={250}
                disabled={disabled}
                aria-invalid={invalidId === textId || issue === 'text' || undefined}
                aria-describedby={`${textId}-help`}
                onChange={(event) =>
                  onChange(rows.map((entry) => (entry.id === row.id ? { ...entry, text: event.target.value } : entry)))
                }
              />
              <FieldDescription id={`${textId}-help`}>{helpText}</FieldDescription>
            </Field>
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="outline"
                className={actionClassName}
                data-editorial-control={control}
                disabled={disabled}
                onClick={() => {
                  const next = rows.filter((entry) => entry.id !== row.id);
                  onChange(next);
                  const focus = next[Math.min(index, next.length - 1)];
                  if (focus) document.getElementById(`${focus.id}-text`)?.focus();
                }}
              >
                {m.ctxw_remove_language({}, o)}
              </Button>
            ) : null}
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        className={actionClassName}
        data-editorial-control={control}
        disabled={disabled}
        onClick={() => {
          const used = new Set(rows.map((row) => row.language));
          const language = locales.find((entry) => !used.has(entry)) ?? locale;
          onChange([...rows, emptyLabelRow(language)]);
        }}
      >
        {m.ctxw_add_language({}, o)}
      </Button>
    </div>
  );
}

export function SettingsPicker({
  locale,
  inventory,
  selected,
  disabled,
  onSelect,
  onReload,
  control,
}: {
  locale: string;
  inventory: SettingsRead | null | undefined;
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onReload?: () => void;
  control?: string;
}) {
  const o = options(locale);
  const field = useId();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const snapshot = inventory?.kind === 'ready' ? inventory.snapshot : null;
  const listed = snapshot ? filterSettings(snapshot, query, locale) : [];
  const page = pageSettings(listed, offset);
  const selectedMissing = !!selected && snapshot && !settingsChoice(snapshot, selected);
  return (
    <section className="space-y-3" data-context-settings-picker>
      <h2 className="text-lg font-semibold">{m.ctxw_policy({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.ctxw_policy_help({}, o)}</p>
      {!inventory || inventory.kind === 'loading' ? (
        <p role="status">{m.ctxw_policy_loading({}, o)}</p>
      ) : inventory.kind === 'denied' ? (
        <p role="status">{m.ctxw_policy_denied({}, o)}</p>
      ) : inventory.kind === 'unavailable' ? (
        <div className="space-y-2" role="status">
          <p>{m.ctxw_policy_unavailable({}, o)}</p>
          {onReload ? (
            <Button type="button" variant="outline" className={actionClassName} disabled={disabled} onClick={onReload}>
              {m.ctxw_reread({}, o)}
            </Button>
          ) : null}
        </div>
      ) : snapshot && snapshot.ids.length === 0 ? (
        <p role="status">{m.ctxw_policy_empty({}, o)}</p>
      ) : snapshot ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${field}-filter`}>{m.ctxw_policy_filter({}, o)}</FieldLabel>
            <Input
              id={`${field}-filter`}
              className={formControlClass}
              data-editorial-control={control}
              type="search"
              value={query}
              disabled={disabled}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="text-sm font-medium">{m.ctxw_policy({}, o)}</legend>
            <label className="flex min-h-11 items-start gap-2 py-1">
              <input
                type="radio"
                className="mt-2 size-4"
                name={`${field}-policy`}
                checked={selected === null}
                disabled={disabled}
                onChange={() => onSelect(null)}
              />
              <span>{m.ctxw_policy_none({}, o)}</span>
            </label>
            {page.items.map((choice) => {
              const title = pickText(choice.labels, locale);
              return (
                <label key={choice.id} className="flex min-h-11 items-start gap-2 py-1">
                  <input
                    type="radio"
                    className="mt-2 size-4"
                    name={`${field}-policy`}
                    value={choice.id}
                    checked={selected === choice.id}
                    disabled={disabled}
                    onChange={() => onSelect(choice.id)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium" {...(title.lang ? { lang: title.lang } : {})}>
                      {title.text || choice.id}
                    </span>
                    <span className="block font-mono text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {choice.id}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {selectedMissing ? <p role="status">{m.ctxw_policy_unknown({}, o)}</p> : null}
          <div className="flex flex-wrap gap-2">
            {page.previous !== null ? (
              <Button
                type="button"
                variant="outline"
                className={actionClassName}
                disabled={disabled}
                onClick={() => setOffset(page.previous!)}
              >
                {m.ctxw_previous({}, o)}
              </Button>
            ) : null}
            {page.next !== null ? (
              <Button
                type="button"
                variant="outline"
                className={actionClassName}
                disabled={disabled}
                onClick={() => setOffset(page.next!)}
              >
                {m.ctxw_next({}, o)}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function SettingsDefaultsList({
  locale,
  snapshot,
  defaults,
}: {
  locale: string;
  snapshot: SettingsSnapshot | null;
  defaults: Readonly<Record<string, DefaultMode>>;
}) {
  const o = options(locale);
  const entries = Object.entries(defaults);
  if (!entries.length) return <p className="text-sm text-muted-foreground">{m.ctx_reader_no_defaults({}, o)}</p>;
  return (
    <dl className="space-y-3">
      {entries.map(([property, mode], index) => {
        const caption = propertyCaption(snapshot, property, locale);
        return (
          <div key={property} className="min-w-0 space-y-1 rounded-lg border border-border p-3">
            <dt className="font-medium">{caption.missing ? m.ctx_reader_rule({ number: index + 1 }, o) : caption.text}</dt>
            <dd className="space-y-1">
              <p>{mode === 'suppress' ? m.ctxw_suppress({}, o) : m.ctxw_inherit({}, o)}</p>
              {caption.missing ? <p className="text-sm text-muted-foreground">{m.ctxw_property_unlabelled({}, o)}</p> : null}
              <details className="min-w-0 text-sm">
                <summary className={summaryClassName}>{m.ctx_reader_rule_reference({ number: index + 1 }, o)}</summary>
                <dl className="space-y-1 pb-2">
                  <dt className="text-muted-foreground">{m.ctx_reader_property_key({}, o)}</dt>
                  <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                    {property}
                  </dd>
                </dl>
              </details>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function SettingsReview({
  locale,
  labels,
  preview,
  snapshot,
  changed,
}: {
  locale: string;
  labels: Readonly<Record<string, string>>;
  preview: SettingsPreview;
  snapshot: SettingsSnapshot | null;
  changed?: boolean;
}) {
  const o = options(locale);
  const choice = preview.settings && snapshot ? settingsChoice(snapshot, preview.settings) : undefined;
  const policyLabel = choice ? pickText(choice.labels, locale) : null;
  return (
    <section className="space-y-4 rounded-lg border border-border p-4" data-context-settings-review>
      <h2 className="text-lg font-semibold">{m.ctxw_review_creation({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.ctxw_review_help({}, o)}</p>
      {changed ? <p role="status">{m.ctxw_policy_changed({}, o)}</p> : null}
      <div className="space-y-2">
        <h3 className="font-semibold">{m.ctxw_review_labels({}, o)}</h3>
        <ul className="space-y-1">
          {Object.entries(labels).map(([language, text]) => (
            <li key={language} lang={language}>
              {text}
              <span className="text-sm text-muted-foreground"> · {language}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold">{m.ctxw_review_policy({}, o)}</h3>
        {preview.settings ? (
          <>
            <p {...(policyLabel?.lang ? { lang: policyLabel.lang } : {})}>{policyLabel?.text || preview.settings}</p>
            <p className="font-mono text-sm [overflow-wrap:anywhere]">{preview.settings}</p>
            <p className="text-sm text-muted-foreground">
              {m.ctxw_review_release({}, o)}:{' '}
              <span className="font-mono [overflow-wrap:anywhere]">{preview.release}</span>
            </p>
          </>
        ) : (
          <p>{m.ctxw_review_none({}, o)}</p>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold">{m.ctxw_review_defaults({}, o)}</h3>
        <SettingsDefaultsList locale={locale} snapshot={snapshot} defaults={preview.defaults} />
        <p className="text-sm text-muted-foreground">{m.ctxw_review_scope({}, o)}</p>
      </div>
    </section>
  );
}

export function CapturedSettings({
  locale,
  captured,
  snapshot,
  labels,
  preview,
  mismatch,
}: {
  locale: string;
  captured: CapturedPolicy;
  snapshot: SettingsSnapshot | null;
  labels?: Exclude<SettingsRead, { kind: 'ready' }>['kind'] | 'ready';
  preview?: SettingsPreview;
  mismatch?: boolean;
}) {
  const o = options(locale);
  const usable = snapshot && captured.settings && snapshot.digest === captured.settings.release ? snapshot : null;
  const choice = captured.settings && usable ? settingsChoice(usable, captured.settings.id) : undefined;
  const title = choice ? pickText(choice.labels, locale) : null;
  const labelsState = labels ?? (usable ? 'ready' : undefined);
  return (
    <section className="space-y-3" data-context-captured-settings>
      <h2 className="text-xl font-semibold">{m.ctxw_settings({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.ctxw_settings_help({}, o)}</p>
      {mismatch && preview ? <p role="status">{m.ctxw_captured_mismatch({}, o)}</p> : null}
      {captured.settings ? (
        <div className="space-y-2">
          <p className="font-medium">{m.ctx_reader_settings_selected({}, o)}</p>
          {title?.text ? <p {...(title.lang ? { lang: title.lang } : {})}>{title.text}</p> : null}
          {labelsState === 'loading' ? <p role="status">{m.ctxw_policy_loading({}, o)}</p> : null}
          {labelsState === 'denied' ? <p role="status">{m.ctxw_policy_denied({}, o)}</p> : null}
          {labelsState === 'unavailable' ? <p role="status">{m.ctxw_captured_unavailable({}, o)}</p> : null}
          <details className="min-w-0 rounded-lg border border-border px-3 text-sm">
            <summary className={summaryClassName}>{m.ctx_reader_settings_details({}, o)}</summary>
            <dl className="space-y-3 pb-3">
              <div>
                <dt className="text-muted-foreground">{m.ctxw_setting({}, o)}</dt>
                <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                  {captured.settings.id}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.ctxw_release({}, o)}</dt>
                <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                  {captured.settings.release}
                </dd>
              </div>
            </dl>
          </details>
        </div>
      ) : (
        <p>{m.ctxw_no_settings({}, o)}</p>
      )}
      {Object.keys(captured.defaults).length ? (
        <div className="space-y-3">
          <h3 className="font-semibold">{m.ctx_reader_defaults({}, o)}</h3>
          <SettingsDefaultsList locale={locale} snapshot={usable} defaults={captured.defaults} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{m.ctx_reader_no_defaults({}, o)}</p>
      )}
    </section>
  );
}
