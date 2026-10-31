import { useQuery } from '@tanstack/react-query';
import type { PropertyDefinition } from '@rezics/definitions';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useState, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { unitSymbols } from './statement-editor';
import { DefinitionMeaning as Meaning } from './definition-meaning';
import {
  definitionGuideHref,
  definitionText,
  guideReturnTo,
  guideTypes,
  type GuideAddress,
  type GuideRead,
  type GuideRelease,
  type GuideTransport,
} from './definition-guide';

function Kind({ datatype, locale }: { datatype: string; locale: string }) {
  const o = { locale: locale as never };
  const labels: Record<string, () => string> = {
    string: () => m.guide_string({}, o),
    'external-id': () => m.guide_code({}, o),
    url: () => m.guide_url({}, o),
    monolingualtext: () => m.guide_language_text({}, o),
    quantity: () => m.guide_quantity({}, o),
    time: () => m.guide_date({}, o),
    'wikibase-item': () => m.guide_subject({}, o),
    document: () => m.guide_document({}, o),
    media: () => m.guide_media({}, o),
  };
  return labels[datatype]?.() ?? m.guide_missing({}, o);
}

function Constraint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Inert emitted constraints, including qualifier definitions; no schema execution or related-subject fetches. */
function Constraints({
  definition,
  release,
  locale,
  qualifiers = true,
}: {
  definition: PropertyDefinition;
  release: GuideRelease;
  locale: string;
  qualifiers?: boolean;
}) {
  const o = { locale: locale as never };
  const value = object(definition.value);
  const parts = object(value.properties);
  const amount = object(parts.amount);
  const text = definition.datatype === 'monolingualtext' ? object(parts.text) : value;
  const pattern = typeof text.pattern === 'string' ? text.pattern : undefined;
  const precision = object(parts.precision).enum;
  const calendar = object(parts.calendarmodel).const;
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Constraint label={m.guide_datatype({}, o)}>
          <Kind datatype={definition.datatype} locale={locale} />
        </Constraint>
        <Constraint label={m.guide_cardinality({}, o)}>
          {definition.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
        </Constraint>
        {definition.targets && (
          <Constraint label={m.guide_targets({}, o)}>
            <ul className="space-y-1">
              {definition.targets.map((target) => (
                <li key={target}>
                  <Meaning values={release.types[target]?.labels} locale={locale} />
                  {!definitionText(release.types[target]?.labels, locale).text && (
                    <details className="text-sm">
                      <summary>{m.guide_identifier({}, o)}</summary>
                      <code className="break-all">{target}</code>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Constraint>
        )}
        {definition.units && (
          <Constraint label={m.guide_units({}, o)}>
            <ul>
              {definition.units.map((unit) => (
                <li key={unit}>
                  {unit === '1'
                    ? m.correction_unitless({}, o)
                    : unit === '*'
                      ? m.guide_any_unit({}, o)
                      : (unitSymbols[unit] ?? m.guide_unknown_unit({}, o))}
                  {unit !== '1' && unit !== '*' && (
                    <details className="text-sm text-muted-foreground">
                      <summary>{m.guide_identifier({}, o)}</summary>
                      <code className="break-all">{unit}</code>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Constraint>
        )}
        {definition.minimum !== undefined && (
          <Constraint label={m.guide_minimum({}, o)}>{definition.minimum}</Constraint>
        )}
        {definition.maximum !== undefined && (
          <Constraint label={m.guide_maximum({}, o)}>{definition.maximum}</Constraint>
        )}
        {definition.datatype === 'quantity' && (
          <Constraint label={m.guide_format({}, o)}>
            <p>{amount.pattern === '^[+-](?:0|[1-9][0-9]*)$' ? m.guide_integer({}, o) : m.guide_decimal({}, o)}</p>
            <p>
              {parts.lowerBound === undefined && parts.upperBound === undefined
                ? m.guide_exact({}, o)
                : m.guide_bounds({}, o)}
            </p>
          </Constraint>
        )}
        {definition.datatype === 'time' && Array.isArray(precision) && (
          <Constraint label={m.correction_precision({}, o)}>
            {precision
              .map((p) =>
                p === 9
                  ? m.correction_year({}, o)
                  : p === 10
                    ? m.correction_month({}, o)
                    : p === 11
                      ? m.correction_day({}, o)
                      : m.guide_missing({}, o),
              )
              .join(' · ')}
            {calendar === 'http://www.wikidata.org/entity/Q1985727' && <p>{m.correction_calendar({}, o)}</p>}
          </Constraint>
        )}
        {pattern && (
          <Constraint label={m.guide_format({}, o)}>
            <code className="break-all text-sm">{pattern}</code>
          </Constraint>
        )}
      </dl>
      {qualifiers && (
        <section className="space-y-3">
          <h3 className="font-medium">{m.guide_qualifiers({}, o)}</h3>
          {definition.qualifiers.length === 0 ? (
            <p className="text-muted-foreground">{m.guide_no_qualifiers({}, o)}</p>
          ) : (
            definition.qualifiers.map((id) => {
              const qualifier = release.properties[id];
              return (
                <details key={id} className="rounded-lg border border-border p-3">
                  <summary className="cursor-pointer">
                    <Meaning values={qualifier?.labels} locale={locale} />
                  </summary>
                  {qualifier && (
                    <div className="mt-3 space-y-3">
                      <Meaning values={qualifier.descriptions} locale={locale} />
                      <Constraints definition={qualifier} release={release} locale={locale} qualifiers={false} />
                    </div>
                  )}
                </details>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}

/** A read-only companion to the native editors, sharing the ordinary shell and controls. */
export function DefinitionGuide({
  address,
  locale,
  transport,
  initial,
}: {
  address: GuideAddress;
  locale: string;
  transport: GuideTransport;
  initial?: GuideRead;
}) {
  const query = useQuery({
    queryKey: ['definition-guide', address, locale],
    queryFn: transport.read,
    initialData: initial,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: initial === undefined,
  });
  const read: GuideRead | undefined = query.isError ? { ok: false, reason: 'unavailable' } : query.data;
  return <DefinitionGuideContent address={address} locale={locale} read={read} retry={() => void query.refetch()} />;
}

export function DefinitionGuideContent({
  address,
  locale,
  read,
  retry,
}: {
  address: GuideAddress;
  locale: string;
  read?: GuideRead | undefined;
  retry: () => void;
}) {
  const o = { locale: locale as never };
  const [selected, setSelected] = useState(address.type ?? '');
  const back = guideReturnTo(address.returnTo, locale) ?? `/${locale}/catalogue/new`;
  const release = read?.ok ? read.release : undefined;
  const types = release ? guideTypes(release, locale) : [];
  const type = selected && release?.types[selected];
  const property = selected === address.type ? address.property : undefined;
  const field = property && release?.properties[property];
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.guide_title({}, o)}</PageHeading>
        <p className="text-muted-foreground">{m.guide_intro({}, o)}</p>
        <a className={buttonVariants({ variant: 'outline' })} href={back}>
          {m.guide_back({}, o)}
        </a>
      </header>
      {!read && <p role="status">{m.guide_loading({}, o)}</p>}
      {read && !read.ok && (
        <section className="space-y-4">
          <p role="alert">
            {read.reason === 'invalid'
              ? m.guide_invalid({}, o)
              : read.reason === 'denied'
                ? m.guide_denied({}, o)
                : read.reason === 'concealed'
                  ? m.guide_concealed({}, o)
                  : m.guide_unavailable({}, o)}
          </p>
          {(read.reason === 'unavailable' || read.reason === 'denied') && (
            <Button variant="outline" onClick={retry}>
              {m.guide_retry({}, o)}
            </Button>
          )}
        </section>
      )}
      {read?.ok && release && (
        <>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">
              {read.pin === 'active' ? m.guide_active({}, o) : m.guide_pinned({}, o)}
            </summary>
            <p className="mt-2 break-all">
              {m.guide_digest({}, o)}: <code>{release.digest}</code>
            </p>
          </details>
          {read.pin === 'pinned' && (
            <a
              className="inline-flex min-h-11 items-center text-sm underline"
              href={definitionGuideHref(locale, { ...address, release: undefined })}
            >
              {m.guide_active({}, o)}
            </a>
          )}
          {types.length === 0 ? (
            <p role="status">{m.guide_empty({}, o)}</p>
          ) : (
            <Field>
              <FieldLabel htmlFor="guide-type">{m.catalogue_create_type({}, o)}</FieldLabel>
              <NativeSelect id="guide-type" value={selected} onChange={(event) => setSelected(event.target.value)}>
                <NativeSelectOption value="">{m.catalogue_create_choose_type({}, o)}</NativeSelectOption>
                {types.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          {type && (
            <section className="space-y-5">
              <header className="space-y-2">
                <h2 className="text-xl font-semibold">
                  <Meaning values={type.labels} locale={locale} />
                </h2>
                <p>
                  <Meaning values={type.descriptions} locale={locale} />
                </p>
              </header>
              {field && property ? (
                <section className="space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6">
                  <header className="space-y-2">
                    <h3 className="text-lg font-semibold">
                      <Meaning values={field.labels} locale={locale} />
                    </h3>
                    <p>
                      <Meaning values={field.descriptions} locale={locale} />
                    </p>
                  </header>
                  <Constraints definition={field} release={release} locale={locale} />
                  <p className="text-sm">
                    {field.disclosure === 'sourceOrConsent' ? m.guide_consent({}, o) : m.guide_references({}, o)}
                  </p>
                  <details className="text-sm text-muted-foreground">
                    <summary>{m.guide_identifier({}, o)}</summary>
                    <code className="break-all">{property}</code>
                  </details>
                  <a
                    className="inline-flex min-h-11 items-center underline"
                    href={definitionGuideHref(locale, { ...address, type: selected, property: undefined })}
                  >
                    {m.guide_fields({}, o)}
                  </a>
                </section>
              ) : (
                <>
                  <h3 className="font-semibold">{m.guide_fields({}, o)}</h3>
                  {type.properties.length === 0 ? (
                    <p>{m.guide_no_fields({}, o)}</p>
                  ) : (
                    <ul className="space-y-3">
                      {type.properties.map((id) => (
                        <li key={id}>
                          {release.properties[id] ? (
                            <a
                              className="inline-flex min-h-11 items-center underline underline-offset-4"
                              href={definitionGuideHref(locale, { ...address, type: selected, property: id })}
                            >
                              <Meaning values={release.properties[id]?.labels} locale={locale} />
                            </a>
                          ) : (
                            <p>{m.guide_missing({}, o)}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <p className="text-sm text-muted-foreground">{m.guide_native({}, o)}</p>
            </section>
          )}
        </>
      )}
    </article>
  );
}

/** Opening guidance keeps the editor's draft and exact uncertain request in its original tab. */
export function DefinitionGuideLink({
  locale,
  address,
  field = false,
}: {
  locale: string;
  address: GuideAddress;
  field?: boolean;
}) {
  const o = { locale: locale as never };
  return (
    <a
      className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
      href={definitionGuideHref(locale, address)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {field ? m.guide_field_help({}, o) : m.guide_type_help({}, o)}
      <span className="sr-only"> · {m.guide_new_tab({}, o)}</span>
    </a>
  );
}
