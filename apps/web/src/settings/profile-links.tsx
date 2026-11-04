import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import type { ProfileLink } from './profile-data';
import type { profileFieldErrors } from './profile-write';

export function ProfileLinks({
  links,
  disabled,
  onChange,
  ids,
  errors,
  fieldError,
  maxItems,
  labelMaxLength,
  urlMaxLength,
}: {
  links: ProfileLink[];
  disabled: boolean;
  onChange: (links: ProfileLink[]) => void;
  ids: string;
  errors: ReturnType<typeof profileFieldErrors>;
  fieldError: (field: string) => ReactNode;
  maxItems: number;
  labelMaxLength: number;
  urlMaxLength: number;
}) {
  // Presentation keys never enter the profile. Only explicit row edits move existing keys.
  const [identity, setIdentity] = useState(() => ({ keys: links.map((_, index) => index), next: links.length }));
  if (identity.keys.length !== links.length) {
    let next = identity.next;
    setIdentity({ keys: links.map((_, index) => identity.keys[index] ?? next++), next });
  }
  const labels = useRef(new Map<number, HTMLInputElement>());
  const add = useRef<HTMLButtonElement>(null);
  const focus = useRef<number | 'add' | null>(null);
  const [removed, setRemoved] = useState<{ key: number; message: string } | null>(null);
  useLayoutEffect(() => {
    const target = focus.current;
    if (target === null) return;
    focus.current = null;
    if (target === 'add') add.current?.focus();
    else labels.current.get(target)?.focus();
  }, [identity, links]);

  return (
    <div className="min-w-0 space-y-3">
      {links.map((link, index) => {
        const key = identity.keys[index]!;
        const heading = `${ids}-link-row-${key}`;
        const name = link.label.trim()
          ? m.settings_profile_link_named_row({ number: index + 1, label: link.label })
          : m.settings_profile_link_row({ number: index + 1 });
        return (
          <FieldSet key={key} aria-labelledby={heading} className="min-w-0 gap-2">
            <FieldLegend id={heading} variant="label" className="mb-0 max-w-full [overflow-wrap:anywhere]">
              {name}
            </FieldLegend>
            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
              <Field className="min-w-0 gap-1" data-invalid={!!errors[`label-${index}`]}>
                <FieldLabel htmlFor={`${ids}-label-${index}`}>{m.settings_profile_link_label()}</FieldLabel>
                <Input
                  id={`${ids}-label-${index}`}
                  ref={(input) => {
                    if (input) labels.current.set(key, input);
                    else labels.current.delete(key);
                  }}
                  className="min-h-11 min-w-0"
                  value={link.label}
                  required
                  pattern={String.raw`.*\S.*`}
                  maxLength={labelMaxLength}
                  disabled={disabled}
                  aria-invalid={!!errors[`label-${index}`]}
                  aria-describedby={errors[`label-${index}`] ? `${ids}-label-${index}-error` : undefined}
                  onChange={(event) =>
                    onChange(links.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)))
                  }
                />
                {fieldError(`label-${index}`)}
              </Field>
              <Field className="min-w-0 gap-1" data-invalid={!!errors[`url-${index}`]}>
                <FieldLabel htmlFor={`${ids}-url-${index}`}>{m.settings_profile_link_url()}</FieldLabel>
                <Input
                  id={`${ids}-url-${index}`}
                  className="min-h-11 min-w-0"
                  type="url"
                  value={link.url}
                  required
                  maxLength={urlMaxLength}
                  disabled={disabled}
                  aria-invalid={!!errors[`url-${index}`]}
                  aria-describedby={errors[`url-${index}`] ? `${ids}-url-${index}-error` : undefined}
                  onChange={(event) =>
                    onChange(links.map((item, at) => (at === index ? { ...item, url: event.target.value } : item)))
                  }
                />
                {fieldError(`url-${index}`)}
              </Field>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                disabled={disabled}
                aria-labelledby={`${heading}-remove ${heading}`}
                onClick={() => {
                  if (disabled) return;
                  focus.current = identity.keys[index + 1] ?? identity.keys[index - 1] ?? 'add';
                  setIdentity({ ...identity, keys: identity.keys.filter((_, at) => at !== index) });
                  setRemoved({ key, message: m.settings_profile_link_removed({ link: name }) });
                  onChange(links.filter((_, at) => at !== index));
                }}
              >
                <span id={`${heading}-remove`}>{m.settings_profile_remove_link()}</span>
              </Button>
            </div>
          </FieldSet>
        );
      })}
      <Button
        ref={add}
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
        disabled={disabled || links.length >= maxItems}
        onClick={() => {
          if (disabled || links.length >= maxItems) return;
          focus.current = identity.next;
          setIdentity({ keys: [...identity.keys, identity.next], next: identity.next + 1 });
          onChange([...links, { label: '', url: '' }]);
        }}
      >
        {m.settings_profile_add_link()}
      </Button>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {removed ? <span key={removed.key}>{removed.message}</span> : null}
      </div>
    </div>
  );
}
