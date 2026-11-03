import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';

/** Consumers acknowledge an admitted row with its stable target and live admission. */
type Addition = { targetId: string; current: () => boolean };
type Handoff = {
  source: HTMLButtonElement;
  release: Release;
  locale: string;
  result?: Addition;
  cancel: () => void;
};

/** Reconcile only the pending choice; authored rows and commands belong to the form. */
export function InitialFieldChoice({
  id,
  groups,
  release,
  occupied,
  locale,
  disabled,
  addLabel,
  atLimit = false,
  fieldClassName,
  labelClassName,
  selectClassName,
  buttonClassName,
  add,
}: {
  id?: string;
  groups: { label?: string; properties: string[] }[];
  release: Release;
  occupied: string[];
  locale: string;
  disabled: boolean;
  addLabel?: string | undefined;
  atLimit?: boolean;
  fieldClassName: string;
  labelClassName: string;
  selectClassName: string;
  buttonClassName: string;
  add: (property: string) => void | false | Addition;
}) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const o = { locale: locale as never };
  const [choice, setChoice] = useState({ property: '', withdrawn: false });
  const handoff = useRef<Handoff | null>(null);
  useLayoutEffect(() => () => handoff.current?.cancel(), []);
  useLayoutEffect(() => {
    const intent = handoff.current;
    if (!intent?.result) return;
    if (disabled || intent.release !== release || intent.locale !== locale || !intent.result.current()) {
      intent.cancel();
      return;
    }
    const document = intent.source.ownerDocument;
    const target = document.getElementById(intent.result.targetId);
    if (!target) return;
    intent.cancel();
    if (document.activeElement !== intent.source && document.activeElement !== document.body) return;
    const control = target.querySelector<HTMLElement>(
      'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)',
    );
    (control ?? target).focus();
  });
  const offeredGroups = groups.map((group) => ({
    ...group,
    properties: group.properties.filter(
      (property) => release.properties[property]?.multivalued || !occupied.includes(property),
    ),
  }));
  const offered = new Set(offeredGroups.flatMap((group) => group.properties));
  const withdrawn = !!choice.property && !offered.has(choice.property);
  // Clear during reconciliation so a later refresh cannot silently revive the old choice.
  if (withdrawn) setChoice({ property: '', withdrawn: true });
  const property = withdrawn ? '' : choice.property;
  const explanation = withdrawn || choice.withdrawn;
  const options = (properties: string[]) =>
    properties.map((id) => {
      const label = pickText(release.properties[id]!.labels, locale);
      return (
        <NativeSelectOption key={id} value={id} lang={label.lang ?? undefined}>
          {label.text}
        </NativeSelectOption>
      );
    });
  return (
    <>
      <Field className={fieldClassName}>
        <FieldLabel className={labelClassName} htmlFor={selectId}>
          {addLabel ?? m.character_add_fact({}, o)}
        </FieldLabel>
        <NativeSelect
          id={selectId}
          className={selectClassName}
          disabled={disabled}
          aria-describedby={explanation ? `${selectId}-withdrawn` : undefined}
          value={property}
          onChange={(event) => {
            handoff.current?.cancel();
            setChoice({ property: event.target.value, withdrawn: false });
          }}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {offeredGroups.map(
            (group, index) =>
              group.properties.length > 0 &&
              (group.label ? (
                <optgroup key={index} label={group.label}>
                  {options(group.properties)}
                </optgroup>
              ) : (
                options(group.properties)
              )),
          )}
        </NativeSelect>
        {explanation && (
          <p id={`${selectId}-withdrawn`} role="status" className="text-sm text-muted-foreground">
            {m.initial_field_choice_withdrawn({}, o)}
          </p>
        )}
      </Field>
      <Button
        type="button"
        variant="outline"
        className={buttonClassName}
        disabled={disabled || atLimit || !offered.has(property)}
        onClick={(event) => {
          handoff.current?.cancel();
          if (disabled || atLimit || !offered.has(property)) return;
          const source = event.currentTarget;
          const document = source.ownerDocument;
          let intent: Handoff | undefined;
          // Match the catalogue's explicit keyboard recovery intent: movement retires it.
          if (event.detail === 0 && document.activeElement === source) {
            const cancel = () => {
              document.removeEventListener('focusin', moved, true);
              document.removeEventListener('pointerdown', cancel, true);
              document.removeEventListener('keydown', tabbed, true);
              if (handoff.current === intent) handoff.current = null;
            };
            const moved = (event: FocusEvent) => {
              if (event.target !== source) cancel();
            };
            const tabbed = (event: KeyboardEvent) => {
              if (event.key === 'Tab') cancel();
            };
            intent = { source, release, locale, cancel };
            handoff.current = intent;
            document.addEventListener('focusin', moved, true);
            document.addEventListener('pointerdown', cancel, true);
            document.addEventListener('keydown', tabbed, true);
          }
          let result: ReturnType<typeof add>;
          try {
            result = add(property);
          } catch (error) {
            intent?.cancel();
            throw error;
          }
          if (intent && result) intent.result = result;
          else intent?.cancel();
          if (result === false) return;
          setChoice({ property: '', withdrawn: false });
        }}
      >
        {m.correction_add({}, o)}
      </Button>
    </>
  );
}
