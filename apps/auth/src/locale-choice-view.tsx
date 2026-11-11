import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { Languages } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { AuthButton } from './button';
import { localeNames } from './locale-choice';
import { applyDocumentLocale, useInterfaceLocale } from './locale-observation';
import { m } from './paraglide/messages.js';
import { isLocale, locales, type Locale } from './paraglide/runtime.js';

export function LocaleChoice() {
  const locale = useInterfaceLocale();
  const [draft, setDraft] = useState<Locale | undefined>();
  const [feedback, setFeedback] = useState<'saved' | 'temporary' | 'unsupported'>();
  const select = useRef<HTMLButtonElement>(null);
  const id = useId();
  const pending = draft !== undefined && draft !== locale;

  // No selection completion survives page departure or a restored document's newer choice.
  useEffect(() => {
    const clear = () => {
      setDraft(undefined);
      setFeedback(undefined);
    };
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', clear);
    };
  }, []);

  function cancel() {
    setDraft(undefined);
    setFeedback(undefined);
    select.current?.focus();
  }

  return (
    <Field className="auth-locale-choice">
      <FieldLabel htmlFor={id} className="auth-locale-label">
        <Languages aria-hidden="true" size={18} />
        <span>{m.auth_locale_label()}</span>
      </FieldLabel>
      <Select
        items={locales.map((value) => ({ value, label: localeNames[value] }))}
        value={draft ?? locale}
        onValueChange={(value) => {
          if (!isLocale(value)) {
            setFeedback('unsupported');
            return;
          }
          setDraft(value);
          setFeedback(undefined);
        }}
      >
        <SelectTrigger
          id={id}
          ref={select}
          lang={draft ?? locale}
          aria-describedby={`${id}-status`}
          className="w-full min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {locales.map((value) => (
              <SelectItem key={value} value={value} lang={value}>
                {localeNames[value]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {pending ? (
        <div className="auth-locale-actions">
          <AuthButton
            onClick={() => {
              setFeedback(applyDocumentLocale(draft!));
              setDraft(undefined);
              select.current?.focus();
            }}
          >
            {m.auth_locale_apply()}
          </AuthButton>
          <AuthButton variant="outline" onClick={cancel}>
            {m.auth_locale_cancel()}
          </AuthButton>
        </div>
      ) : null}
      <p id={`${id}-status`} role={feedback === 'unsupported' ? 'alert' : 'status'} className="auth-locale-status">
        {pending
          ? m.auth_locale_pending({ language: localeNames[locale] })
          : feedback === 'temporary'
            ? m.auth_locale_temporary()
            : feedback === 'saved'
              ? m.auth_locale_saved()
              : feedback === 'unsupported'
                ? m.auth_locale_unsupported()
                : null}
      </p>
    </Field>
  );
}
