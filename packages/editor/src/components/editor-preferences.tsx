'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Switch } from '@rezics/ui/shadcn/switch';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@rezics/ui/shadcn/field';
import {
  editorCommandIds,
  editorShortcutIssue,
  normalizeEditorShortcut,
  resolveEditorPreferences,
  validateEditorPreferences,
  type EditorPreferences,
  type EditorPreferenceCommand,
} from '../preferences.ts';

export const editorPreferencesLabels = {
  heading: 'Editor preferences',
  search: 'Search editor preferences',
  noMatches: 'No matching preferences',
  account: 'Account · synchronized',
  device: 'This device',
  session: 'This session',
  scope: 'Save preferences to',
  private: 'These choices change your writing workspace. Document formatting stays with the document.',
  accountDescription: 'Account defaults synchronize across your signed-in devices.',
  deviceDescription: 'Device overrides apply in this browser, above account defaults.',
  sessionDescription: 'Session overrides apply in this tab until the browsing session ends.',
  typography: 'Writing appearance',
  typeface: 'Typeface',
  sans: 'Sans serif',
  serif: 'Serif',
  mono: 'Monospace',
  custom: 'Custom',
  customFont: 'Installed font family',
  customFontDescription: 'Use a font installed on this device.',
  textSize: 'Text size (px)',
  lineSpacing: 'Line spacing',
  writingWidth: 'Writing width (characters)',
  layout: 'Workspace',
  toolbar: 'Toolbar',
  auto: 'Automatic',
  fixed: 'Fixed',
  floating: 'Floating',
  hidden: 'Hidden',
  outline: 'Show outline',
  input: 'Input',
  markdownShortcuts: 'Markdown shortcuts',
  markdownDescription: 'Turn typed Markdown patterns into formatting as you write.',
  spellcheck: 'Spellcheck',
  spellcheckDescription: 'Use the browser spelling checker and its configured languages.',
  pasteMode: 'Paste as',
  rich: 'Formatted text',
  plain: 'Plain text',
  pasteDescription: 'Formatted paste removes unsafe markup. Plain paste keeps text only.',
  autoLink: 'Convert typed URLs to links',
  commands: 'Commands and keyboard shortcuts',
  commandsDescription:
    'Pin, hide or reorder controls. Hidden controls keep their document content. Use Mod for Ctrl on Windows/Linux or Command on Mac.',
  pinned: 'Pinned',
  visible: 'Visible',
  shortcut: 'Shortcut',
  shortcutDescription: 'Use a chord such as Mod-Shift-b. An empty value disables the shortcut.',
  reset: 'Restore defaults',
  resetShortcut: 'Default shortcut',
  moveUp: 'Move up',
  moveDown: 'Move down',
  invalidShortcut: 'Use a modifier and a key, such as Mod-Shift-b.',
  reservedShortcut: 'This shortcut is reserved for native input, the browser, or saving.',
  conflictingShortcut: 'This shortcut is already assigned to',
  preview: 'Preview',
  previewText: 'A quiet place to write. Your words and their formatting stay intact while the workspace changes.',
  saving: 'Saving preferences…',
  saved: 'Preferences saved',
  error: 'Preferences could not be saved.',
  conflict: 'Preferences changed elsewhere. Reload the current account defaults before saving again.',
  retry: 'Retry save',
  reload: 'Reload account defaults',
  invalidNumber: 'Enter a number from {min} to {max}.',
  invalidInteger: 'Enter a whole number from {min} to {max}.',
};
export type EditorPreferencesLabels = { [K in keyof typeof editorPreferencesLabels]: string };
export type EditorPreferencesScope = 'account' | 'device' | 'session';
export type EditorPreferencesStatus = {
  state: 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
  message?: string;
};
export type EditorPreferenceControl = { id: EditorPreferenceCommand; label: string };
export interface EditorPreferencesPanelProps {
  value: EditorPreferences;
  onChange: (next: EditorPreferences) => void;
  scope?: EditorPreferencesScope;
  onScopeChange?: (scope: EditorPreferencesScope) => void;
  availableScopes?: readonly EditorPreferencesScope[];
  status?: EditorPreferencesStatus;
  onRetry?: () => void;
  onReload?: () => void;
  disabled?: boolean;
  commands?: readonly EditorPreferenceControl[];
  labels?: Partial<EditorPreferencesLabels>;
}

const defaultCommands: readonly EditorPreferenceControl[] = editorCommandIds.map((id) => ({
  id,
  label: id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase()),
}));
const allScopes: readonly EditorPreferencesScope[] = ['account', 'device', 'session'];

function ShortcutField({
  id,
  value,
  bindings,
  onChange,
  onReset,
  labels,
  disabled,
  commandLabel,
}: {
  id: EditorPreferenceCommand;
  value: string;
  bindings: EditorPreferences['keyboardBindings'];
  onChange: (chord: string) => void;
  onReset: () => void;
  labels: EditorPreferencesLabels;
  disabled: boolean;
  commandLabel: (id: EditorPreferenceCommand) => string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const issue = editorShortcutIssue(id, draft, bindings);
  const message =
    issue?.reason === 'conflict'
      ? `${labels.conflictingShortcut} ${commandLabel(issue.command!)}.`
      : issue?.reason === 'reserved'
        ? labels.reservedShortcut
        : issue
          ? labels.invalidShortcut
          : '';
  return (
    <Field data-invalid={!!issue} data-disabled={disabled}>
      <FieldLabel htmlFor={inputId}>{labels.shortcut}</FieldLabel>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input
          id={inputId}
          value={draft}
          maxLength={80}
          disabled={disabled}
          aria-invalid={!!issue}
          aria-describedby={message ? `${inputId}-error` : undefined}
          className="min-w-32 flex-1"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!issue && draft !== value) onChange(draft === '' ? '' : normalizeEditorShortcut(draft)!);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <Button type="button" variant="outline" disabled={disabled} onClick={onReset}>
          {labels.resetShortcut}
        </Button>
      </div>
      {message ? (
        <FieldDescription id={`${inputId}-error`} role="alert">
          {message}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/** Keep partial native number input locally; only admitted numbers affect the live workspace. */
function NumericPreferenceField({
  value,
  label,
  min,
  max,
  step,
  disabled,
  onChange,
  labels,
  resetVersion,
}: {
  value: number;
  label: string;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
  labels: EditorPreferencesLabels;
  resetVersion: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value, resetVersion]);
  const admitted = (input: string) =>
    input.trim() !== '' &&
    Number.isFinite(Number(input)) &&
    Number(input) >= min &&
    Number(input) <= max &&
    (step !== 1 || Number.isInteger(Number(input)));
  const error = (step === 1 ? labels.invalidInteger : labels.invalidNumber)
    .replace('{min}', String(min))
    .replace('{max}', String(max));
  return (
    <Field data-disabled={disabled} data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode={step === 1 ? 'numeric' : 'decimal'}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setInvalid(false);
          if (admitted(next)) onChange(Number(next));
        }}
        onBlur={() => {
          const valid = admitted(draft);
          setInvalid(!valid);
          if (valid) onChange(Number(draft));
        }}
      />
      {invalid ? (
        <FieldDescription id={`${id}-error`} role="alert">
          {error}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/** Reusable controlled settings; storage, identity and save commands belong to the host. */
export function EditorPreferencesPanel({
  value,
  onChange,
  scope = 'device',
  onScopeChange,
  availableScopes = allScopes,
  status,
  onRetry,
  onReload,
  disabled = false,
  commands = defaultCommands,
  labels,
}: EditorPreferencesPanelProps) {
  const text = { ...editorPreferencesLabels, ...labels };
  const id = useId();
  const [query, setQuery] = useState('');
  const [resetVersion, setResetVersion] = useState(0);
  const resolved = resolveEditorPreferences(value);
  const matches = (...words: string[]) =>
    !query.trim() || words.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const change = (patch: EditorPreferences) => {
    const next = { ...value, ...patch };
    if (validateEditorPreferences(next)) onChange(next);
  };
  const select = (key: 'typeface' | 'toolbar' | 'pasteMode', options: readonly string[]) => (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={`${id}-${key}`}>{text[key]}</FieldLabel>
      <NativeSelect
        id={`${id}-${key}`}
        value={resolved[key]}
        disabled={disabled}
        onChange={(event) => change({ [key]: event.target.value })}
      >
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {text[option as keyof EditorPreferencesLabels] ?? option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {key === 'pasteMode' ? <FieldDescription>{text.pasteDescription}</FieldDescription> : null}
    </Field>
  );
  const toggle = (key: 'outline' | 'markdownShortcuts' | 'spellcheck' | 'autoLink', description?: string) => (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <FieldLabel htmlFor={`${id}-${key}`}>{text[key]}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
      <Switch
        id={`${id}-${key}`}
        checked={resolved[key]}
        disabled={disabled}
        onCheckedChange={(checked) => change({ [key]: checked })}
      />
    </Field>
  );
  const typography = matches(
    text.typography,
    text.typeface,
    text.textSize,
    text.lineSpacing,
    text.writingWidth,
    text.customFont,
  );
  const workspace = matches(text.layout, text.toolbar, text.outline);
  const input = matches(text.input, text.markdownShortcuts, text.spellcheck, text.pasteMode, text.autoLink);
  const ordered = [...commands].sort((left, right) => {
    const order = resolved.commandOrder;
    const a = order.indexOf(left.id),
      b = order.indexOf(right.id);
    return (a < 0 ? order.length : a) - (b < 0 ? order.length : b);
  });
  const filtered = ordered.filter((entry) => matches(text.commands, entry.label, entry.id));
  const move = (command: EditorPreferenceCommand, delta: number) => {
    const order = ordered.map((entry) => entry.id);
    const at = order.indexOf(command),
      to = at + delta;
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    change({ commandOrder: order });
  };
  const toggleCommand = (key: 'pinnedCommands' | 'hiddenCommands', command: EditorPreferenceCommand) =>
    change({
      [key]: resolved[key].includes(command)
        ? resolved[key].filter((entry) => entry !== command)
        : [...resolved[key], command],
    });
  const fontFamily =
    resolved.typeface === 'custom'
      ? resolved.customFont || 'var(--font-sans)'
      : resolved.typeface === 'serif'
        ? 'var(--font-serif)'
        : resolved.typeface === 'mono'
          ? 'var(--font-mono)'
          : 'var(--font-sans)';
  return (
    <section aria-label={text.heading} className="flex min-w-0 flex-col gap-5" data-slot="editor-preferences">
      <p className="text-sm text-muted-foreground">{text.private}</p>
      <FieldGroup>
        {onScopeChange ? (
          <Field>
            <FieldLabel htmlFor={`${id}-scope`}>{text.scope}</FieldLabel>
            <NativeSelect
              id={`${id}-scope`}
              value={scope}
              onChange={(event) => onScopeChange(event.target.value as EditorPreferencesScope)}
            >
              {availableScopes.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {text[option]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{text[`${scope}Description`]}</FieldDescription>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">
            {text[scope]} · {text[`${scope}Description`]}
          </p>
        )}
        <Field>
          <FieldLabel htmlFor={`${id}-search`}>{text.search}</FieldLabel>
          <Input id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        {typography ? (
          <FieldSet>
            <FieldLegend>{text.typography}</FieldLegend>
            <FieldGroup>
              {select('typeface', ['sans', 'serif', 'mono', 'custom'])}
              {resolved.typeface === 'custom' ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-custom-font`}>{text.customFont}</FieldLabel>
                  <Input
                    id={`${id}-custom-font`}
                    value={resolved.customFont}
                    maxLength={128}
                    disabled={disabled}
                    onChange={(event) => change({ customFont: event.target.value })}
                  />
                  <FieldDescription>{text.customFontDescription}</FieldDescription>
                </Field>
              ) : null}
              {(['textSize', 'lineSpacing', 'writingWidth'] as const).map((key) => (
                <NumericPreferenceField
                  key={key}
                  label={text[key]}
                  value={resolved[key]}
                  disabled={disabled}
                  labels={text}
                  resetVersion={resetVersion}
                  min={key === 'textSize' ? 12 : key === 'lineSpacing' ? 1 : 40}
                  max={key === 'textSize' ? 32 : key === 'lineSpacing' ? 2.5 : 120}
                  step={key === 'lineSpacing' ? 0.1 : 1}
                  onChange={(number) => change({ [key]: number })}
                />
              ))}
            </FieldGroup>
          </FieldSet>
        ) : null}
        {workspace ? (
          <FieldSet>
            <FieldLegend>{text.layout}</FieldLegend>
            <FieldGroup>
              {select('toolbar', ['auto', 'fixed', 'floating', 'hidden'])}
              {toggle('outline')}
            </FieldGroup>
          </FieldSet>
        ) : null}
        {input ? (
          <FieldSet>
            <FieldLegend>{text.input}</FieldLegend>
            <FieldGroup>
              {toggle('markdownShortcuts', text.markdownDescription)}
              {toggle('spellcheck', text.spellcheckDescription)}
              {select('pasteMode', ['rich', 'plain'])}
              {toggle('autoLink')}
            </FieldGroup>
          </FieldSet>
        ) : null}
        {filtered.length ? (
          <FieldSet>
            <FieldLegend>{text.commands}</FieldLegend>
            <FieldDescription>
              {text.commandsDescription} {text.shortcutDescription}
            </FieldDescription>
            <details open={query.trim() ? true : undefined}>
              <summary className="cursor-pointer py-2 text-sm">
                {text.commands} ({filtered.length})
              </summary>
              <FieldGroup>
                {filtered.map((entry) => (
                  <FieldSet key={entry.id} className="rounded-xl border p-3">
                    <FieldLegend>{entry.label}</FieldLegend>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        aria-pressed={resolved.pinnedCommands.includes(entry.id)}
                        onClick={() => toggleCommand('pinnedCommands', entry.id)}
                      >
                        {text.pinned}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        aria-pressed={!resolved.hiddenCommands.includes(entry.id)}
                        onClick={() => toggleCommand('hiddenCommands', entry.id)}
                      >
                        {text.visible}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled || ordered[0]?.id === entry.id}
                        aria-label={`${text.moveUp}: ${entry.label}`}
                        onClick={() => move(entry.id, -1)}
                      >
                        {text.moveUp}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled || ordered.at(-1)?.id === entry.id}
                        aria-label={`${text.moveDown}: ${entry.label}`}
                        onClick={() => move(entry.id, 1)}
                      >
                        {text.moveDown}
                      </Button>
                    </div>
                    <ShortcutField
                      id={entry.id}
                      value={resolved.keyboardBindings[entry.id] ?? ''}
                      bindings={value.keyboardBindings}
                      commandLabel={(command) => commands.find((control) => control.id === command)?.label ?? command}
                      labels={text}
                      disabled={disabled}
                      onChange={(chord) =>
                        change({ keyboardBindings: { ...value.keyboardBindings, [entry.id]: chord } })
                      }
                      onReset={() => {
                        const bindings = { ...value.keyboardBindings };
                        delete bindings[entry.id];
                        change({ keyboardBindings: bindings });
                      }}
                    />
                  </FieldSet>
                ))}
              </FieldGroup>
            </details>
          </FieldSet>
        ) : null}
      </FieldGroup>
      {!typography && !workspace && !input && !filtered.length ? <p role="status">{text.noMatches}</p> : null}
      <div className="flex flex-col gap-2 rounded-xl border p-4" aria-label={text.preview}>
        <span className="text-xs text-muted-foreground">{text.preview}</span>
        <p
          style={{
            fontFamily,
            fontSize: `${resolved.textSize}px`,
            lineHeight: resolved.lineSpacing,
            maxWidth: `${resolved.writingWidth}ch`,
          }}
        >
          {text.previewText}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setResetVersion((version) => version + 1);
            onChange({});
          }}
        >
          {text.reset}
        </Button>
        {status?.state === 'error' && onRetry ? (
          <Button type="button" variant="outline" onClick={onRetry}>
            {text.retry}
          </Button>
        ) : null}
        {status?.state === 'conflict' && onReload ? (
          <Button type="button" variant="outline" onClick={onReload}>
            {text.reload}
          </Button>
        ) : null}
        {status && status.state !== 'idle' ? (
          <p
            role={status.state === 'error' || status.state === 'conflict' ? 'alert' : 'status'}
            aria-live="polite"
            className="text-sm text-muted-foreground"
          >
            {status.message ?? text[status.state]}
          </p>
        ) : null}
      </div>
    </section>
  );
}
