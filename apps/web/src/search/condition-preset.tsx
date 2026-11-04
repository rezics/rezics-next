import { useId, useMemo, useState } from 'react';
import { useWorkspaceAdmission, useReaderAddress } from '../session/reader';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PredicateDescription } from './search-context/predicate';
import { presetText, type ConditionPresetCatalogue } from './condition-preset-model';

const operations = [] as const;

export function ConditionPresetName({ id, catalogue }: { id: string; catalogue: ConditionPresetCatalogue }) {
  const name = catalogue.name(id);
  return (
    <>
      <span lang={name.lang}>{presetText(name.text)}</span>
      {name.text !== id && <> ({id})</>}
    </>
  );
}

/** A synchronous, optional explanation. No entity lookups, result reads or execution permission. */
export function ConditionPresetInspection({
  id,
  catalogue,
  locale,
}: {
  id: string;
  catalogue: ConditionPresetCatalogue;
  locale: string;
}) {
  const { value: reader } = useWorkspaceAdmission(operations);
  const address = useReaderAddress(null, undefined, locale);
  const owner = JSON.stringify([id, locale, address.key, reader.subject, reader.viewer, reader.observation?.id]);
  let [session, setSession] = useState({ owner, catalogue, open: false });
  if (session.owner !== owner || session.catalogue !== catalogue) {
    session = { owner, catalogue, open: false };
    setSession(session);
  }
  const open = session.open;
  const region = useId();
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const preview = useMemo(() => (open ? catalogue.preview(id) : undefined), [catalogue, id, open]);
  return (
    <div className="min-w-0 space-y-2 break-words">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setSession({ ...session, open: !open })}
      >
        {open ? m.condition_preset_close({}, options) : m.condition_preset_inspect({}, options)}
      </Button>
      {open && (
        <div
          id={region}
          role="region"
          aria-label={m.condition_preset_inspect({}, options)}
          className="rounded border p-2"
        >
          <p>{m.condition_preset_preview({}, options)}</p>
          {preview ? (
            <PredicateDescription
              value={preview.value}
              locale={locale}
              previewNodes={preview.nodes}
              label={(key) => {
                const label = catalogue.label(key);
                return <span lang={label.lang}>{presetText(label.text || key)}</span>;
              }}
            />
          ) : (
            <p role="status">{m.condition_saved_filter_unavailable_reference({ id }, options)}</p>
          )}
        </div>
      )}
    </div>
  );
}
