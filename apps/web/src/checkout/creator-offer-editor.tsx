import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { parseCreatorPrice } from './creator-price';
import { formatMinorAmount } from './money';
import type { ConfiguredSaleCurrencyRule } from './money-schema';
import {
  manageCreatorOffer,
  type CreatorEditorPageData,
  type CreatorFailure,
  type CreatorOfferMutation,
  type CreatorOfferResult,
} from './creator-offers';

export function creatorNotice(kind: CreatorFailure['kind'] | 'retry' | 'saved'): string {
  switch (kind) {
    case 'denied':
      return m.creator_denied();
    case 'closed':
      return m.creator_closed();
    case 'unavailable':
      return m.creator_unavailable();
    case 'rejected':
      return m.creator_rejected();
    case 'retry':
      return m.creator_uncertain();
    case 'saved':
      return m.creator_saved();
  }
}

export function parsedPrice(text: string, rule?: ConfiguredSaleCurrencyRule): number | null {
  try {
    return rule ? parseCreatorPrice(text, rule) : null;
  } catch {
    return null;
  }
}

/** Native text input keeps the adopted dot convention in every locale; only the preview is localized. */
export function CreatorPriceField({
  rule,
  text,
  onChange,
  locale,
  disabled = false,
}: {
  rule?: ConfiguredSaleCurrencyRule | undefined;
  text: string;
  onChange(text: string): void;
  locale: string;
  disabled?: boolean;
}) {
  const id = useId();
  const raw = parsedPrice(text, rule);
  const preview = rule && raw !== null ? formatMinorAmount(locale, rule.currency, raw, rule.unit) : null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{m.creator_amount()}</FieldLabel>
      <Input
        id={id}
        name="price"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        maxLength={32}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || !rule}
        required
        aria-invalid={!!text && raw === null}
        aria-describedby={`${id}-help ${id}-preview`}
        className="min-h-11 tabular-nums"
      />
      <p id={`${id}-help`} className="text-sm leading-relaxed text-muted-foreground">
        {m.creator_price_convention()}
      </p>
      {rule && (
        <p className="text-sm text-muted-foreground">
          {m.creator_price_range({
            min: formatMinorAmount(locale, rule.currency, rule.minAmountMinor, rule.unit) ?? '',
            max: formatMinorAmount(locale, rule.currency, rule.maxAmountMinor, rule.unit) ?? '',
          })}
        </p>
      )}
      <p id={`${id}-preview`} className="min-h-6 break-words font-medium tabular-nums" aria-live="polite">
        {preview && rule
          ? `${preview} · ${rule.currency.toUpperCase()} · ${m.commerce_before_tax()}`
          : text
            ? m.creator_invalid_price()
            : m.creator_price_preview()}
      </p>
    </Field>
  );
}

export type CreatorPriceIntent = { currency: string; text: string };
export function CreatorPriceFields({
  rules,
  intent,
  onChange,
  locale,
  disabled = false,
}: {
  rules: readonly ConfiguredSaleCurrencyRule[];
  intent: CreatorPriceIntent;
  onChange(intent: CreatorPriceIntent): void;
  locale: string;
  disabled?: boolean;
}) {
  const id = useId();
  const rule = rules.find((row) => row.currency === intent.currency);
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>{m.creator_currency()}</FieldLabel>
        <select
          id={id}
          name="currency"
          required
          value={intent.currency}
          disabled={disabled}
          onChange={(event) => onChange({ currency: event.target.value, text: '' })}
          aria-describedby={`${id}-help`}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="">{m.creator_select_currency()}</option>
          {rules.map((row) => (
            <option key={row.currency} value={row.currency}>
              {row.currency.toUpperCase()}
            </option>
          ))}
        </select>
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {m.creator_currency_change()}
        </p>
      </Field>
      <CreatorPriceField
        rule={rule}
        text={intent.text}
        onChange={(text) => onChange({ ...intent, text })}
        locale={locale}
        disabled={disabled}
      />
    </>
  );
}

export function CreatorOfferEditor({ data, locale }: { data: CreatorEditorPageData; locale: string }) {
  const [intent, setIntent] = useState<CreatorPriceIntent>({ currency: '', text: '' });
  const { currency, text } = intent;
  const [title, setTitle] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [result, setResult] = useState<CreatorOfferResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<CreatorOfferMutation | null>(null);
  const locked = useRef(false);
  const key = useRef(data.createKey);
  const fieldId = useId();
  const editor = data.editor;
  const rule =
    editor.kind === 'ready'
      ? editor.schema.configuredSaleCurrencies.find((row) => row.currency === currency)
      : undefined;
  const amount = parsedPrice(text, rule);
  const uncertain = result?.kind === 'retry';
  const frozen = busy || uncertain || result?.kind === 'saved';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !data.selling || !data.csrfToken || editor.kind !== 'ready' || result?.kind === 'saved')
      return;
    if (!pending.current) {
      if (amount === null || !rule || !title.trim() || !taxCode.trim()) return;
      pending.current = {
        operation: 'create',
        idempotencyKey: key.current,
        contentEditionId: editor.edition.editionId,
        title,
        currency: rule.currency,
        unitAmountMinor: amount,
        taxCode,
      };
    }
    locked.current = true;
    setBusy(true);
    try {
      const next = await manageCreatorOffer({ data: pending.current, headers: { 'X-CSRF-Token': data.csrfToken } });
      setResult(next);
      if (next.kind !== 'saved' && next.kind !== 'retry') {
        pending.current = null;
        key.current = crypto.randomUUID();
      }
    } catch {
      setResult({ kind: 'retry' });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="max-w-3xl min-w-0 space-y-6 text-foreground">
      <PageHeading>{m.creator_new_offer()}</PageHeading>
      <a
        href={`/${locale}/creator/offers`}
        className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
      >
        {m.creator_offers_heading()}
      </a>
      {editor.kind !== 'ready' ? (
        <div className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground" role="status">
          <p>{editor.kind === 'choose-edition' ? m.creator_choose_edition() : creatorNotice(editor.kind)}</p>
          <a
            href={`/${locale}/editions/new`}
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          >
            {m.creator_publish_edition()}
          </a>
        </div>
      ) : (
        <>
          <section
            className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
            aria-labelledby={`${fieldId}-version`}
          >
            <h2 id={`${fieldId}-version`} className="text-lg font-semibold">
              {m.creator_edition()}
            </h2>
            <p className="text-sm leading-relaxed">{m.creator_fixed_version()}</p>
            <dl className="space-y-3 text-sm">
              {[
                [m.creator_edition(), editor.edition.editionId],
                [m.creator_revision(), editor.edition.revisionId],
                [m.creator_digest(), editor.edition.sha256],
                [m.creator_licence(), editor.edition.licence],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-muted-foreground">{m.creator_current_rights()}</p>
          </section>
          <form onSubmit={submit} className="space-y-6 rounded-xl border bg-card p-5 text-card-foreground sm:p-6">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-title`}>{m.creator_title()}</FieldLabel>
              <Input
                id={`${fieldId}-title`}
                name="title"
                required
                maxLength={1024}
                value={title}
                disabled={frozen}
                onChange={(event) => setTitle(event.target.value)}
                className="min-h-11"
              />
            </Field>
            <CreatorPriceFields
              rules={editor.schema.configuredSaleCurrencies}
              intent={intent}
              onChange={setIntent}
              locale={locale}
              disabled={frozen}
            />
            <Field>
              <FieldLabel htmlFor={`${fieldId}-tax`}>{m.creator_tax_code()}</FieldLabel>
              <Input
                id={`${fieldId}-tax`}
                name="taxCode"
                required
                maxLength={256}
                value={taxCode}
                disabled={frozen}
                onChange={(event) => setTaxCode(event.target.value)}
                className="min-h-11"
              />
              <p className="text-sm text-muted-foreground">{m.creator_tax_code_hint()}</p>
            </Field>
            {result && <p role={result.kind === 'saved' ? 'status' : 'alert'}>{creatorNotice(result.kind)}</p>}
            {result?.kind === 'saved' ? (
              <a
                href={`/${locale}/offers/${result.id}`}
                className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
              >
                {m.creator_view_offer()}
              </a>
            ) : (
              <Button
                type="submit"
                className="min-h-11"
                disabled={
                  busy ||
                  !data.selling ||
                  !data.csrfToken ||
                  (!uncertain && (amount === null || !title.trim() || !taxCode.trim()))
                }
              >
                {busy ? m.creator_saving() : uncertain ? m.creator_retry() : m.creator_create()}
              </Button>
            )}
          </form>
        </>
      )}
    </article>
  );
}
