import { useContext, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { creatorPreviewGuard, useCreatorCurrentOrigin, useCreatorIntent } from './creator-current-origin';
import { parseCreatorPrice } from './creator-price';
import { formatMinorAmount } from './money';
import type { ConfiguredSaleCurrencyRule } from './money-schema';
import {
  manageCreatorOffer,
  type CreatorEditorPageData,
  type CreatorFailure,
  type CreatorOfferGuard,
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

export function CreatorOfferEditor({
  data,
  locale,
  guard,
}: {
  data: CreatorEditorPageData;
  locale: string;
  guard?: CreatorOfferGuard;
}) {
  if (guard) return <CreatorOfferForm data={data} locale={locale} createKey={data.createKey} guard={guard} />;
  return <StandaloneCreatorOfferEditor data={data} locale={locale} />;
}

function StandaloneCreatorOfferEditor({ data, locale }: { data: CreatorEditorPageData; locale: string }) {
  const client = useContext(QueryClientContext);
  return client ? (
    <ObservedCreatorOfferEditor data={data} locale={locale} />
  ) : (
    <CreatorOfferForm data={data} locale={locale} createKey={data.createKey} guard={creatorPreviewGuard} />
  );
}

function ObservedCreatorOfferEditor({ data, locale }: { data: CreatorEditorPageData; locale: string }) {
  const edition = data.editor.kind === 'ready' ? data.editor.edition : undefined;
  const current = useCreatorCurrentOrigin(
    'offer.list',
    JSON.stringify([locale, edition?.editionId ?? data.editor.kind]),
    edition?.creatorAccountId,
  );
  return (
    <CreatorOfferForm
      key={current.origin.id}
      data={data}
      locale={locale}
      createKey={current.seed ? data.createKey : current.origin.id}
      guard={current.origin}
    />
  );
}

type CreateIntent = {
  editor: CreatorEditorPageData['editor'];
  rules: readonly ConfiguredSaleCurrencyRule[];
  intent: CreatorPriceIntent;
  title: string;
  taxCode: string;
  pending: CreatorOfferMutation | null;
  key: string;
  result: CreatorOfferResult | null;
};

function CreatorOfferForm({
  data,
  locale,
  createKey,
  guard,
}: {
  data: CreatorEditorPageData;
  locale: string;
  createKey: string;
  guard: CreatorOfferGuard;
}) {
  const memory = useCreatorIntent<CreateIntent>(guard, 'create');
  const sender = useCreatorIntent<(data: CreatorOfferMutation) => Promise<CreatorOfferResult>>(guard, 'create-sender');
  const [resume] = useState(memory.value);
  const [intent, setIntent] = useState<CreatorPriceIntent>(resume?.intent ?? { currency: '', text: '' });
  const { currency, text } = intent;
  const [title, setTitle] = useState(resume?.title ?? '');
  const [taxCode, setTaxCode] = useState(resume?.taxCode ?? '');
  const [result, setResult] = useState<CreatorOfferResult | null>(resume?.result ?? null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<CreatorOfferMutation | null>(resume?.pending ?? null);
  const submittedRules = useRef<readonly ConfiguredSaleCurrencyRule[] | null>(resume?.rules ?? null);
  const locked = useRef(resume?.result?.kind === 'saved');
  const key = useRef(resume?.key ?? createKey);
  const lifetime = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: true };
    lifetime.current = current;
    return () => {
      // The write can still commit; its completion belongs only to this form lifetime.
      current.active = false;
    };
  }, []);
  const fieldId = useId();
  // The selected edition and its price facts are the observed create operand, including on retry.
  const [draftEditor, setDraftEditor] = useState(resume?.editor);
  const editor = draftEditor ?? data.editor;
  if (!draftEditor) key.current = createKey;
  const rules = submittedRules.current ?? (editor.kind === 'ready' ? editor.schema.configuredSaleCurrencies : []);
  const rule = rules.find((row) => row.currency === currency);
  const amount = parsedPrice(text, rule);
  const uncertain = result?.kind === 'retry';
  const frozen = busy || uncertain || result?.kind === 'saved';
  const canSubmit = data.selling && guard.isCurrent() && !!guard.csrfToken();

  function keepDraft(changes: Partial<Pick<CreateIntent, 'intent' | 'title' | 'taxCode'>> = {}) {
    setDraftEditor(editor);
    memory.value = {
      editor,
      rules,
      intent,
      title,
      taxCode,
      pending: pending.current,
      key: key.current,
      result,
      ...changes,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = lifetime.current;
    const csrfToken = guard.csrfToken();
    if (
      !current.active ||
      locked.current ||
      !guard.isCurrent() ||
      !data.selling ||
      !csrfToken ||
      editor.kind !== 'ready' ||
      result?.kind === 'saved'
    )
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
      submittedRules.current = rules;
      const execute = manageCreatorOffer;
      sender.value = (data) => execute({ data, headers: { 'X-CSRF-Token': csrfToken } });
    }
    setDraftEditor(editor);
    memory.value = {
      editor,
      rules,
      intent,
      title,
      taxCode,
      pending: pending.current,
      key: key.current,
      result: { kind: 'retry' },
    };
    locked.current = true;
    setBusy(true);
    let saved = false;
    try {
      const next = await sender.value!(pending.current);
      if (!current.active || !guard.isCurrent()) return;
      saved = next.kind === 'saved';
      setResult(next);
      if (next.kind !== 'saved' && next.kind !== 'retry') {
        pending.current = null;
        submittedRules.current = null;
        key.current = crypto.randomUUID();
      }
      memory.value = {
        editor,
        rules,
        intent,
        title,
        taxCode,
        pending: pending.current,
        key: key.current,
        result: next,
      };
    } catch {
      if (current.active && guard.isCurrent()) setResult({ kind: 'retry' });
    } finally {
      if (current.active && guard.isCurrent()) {
        locked.current = saved;
        setBusy(false);
      }
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
            className="min-w-0 space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
            aria-labelledby={`${fieldId}-version`}
          >
            <h2 id={`${fieldId}-version`} className="text-lg font-semibold">
              {m.creator_edition()}
            </h2>
            <p className="text-sm leading-relaxed">{m.creator_fixed_version()}</p>
            <dl className="min-w-0 text-sm">
              <dt className="text-muted-foreground">{m.creator_licence()}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">{editor.edition.licence}</dd>
            </dl>
            <p className="text-sm leading-relaxed">{m.creator_current_rights()}</p>
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
                onChange={(event) => {
                  if (guard.isCurrent() && !frozen) {
                    keepDraft({ title: event.target.value });
                    setTitle(event.target.value);
                  }
                }}
                className="min-h-11"
              />
            </Field>
            <CreatorPriceFields
              rules={rules}
              intent={intent}
              onChange={(next) => {
                if (guard.isCurrent() && !frozen) {
                  keepDraft({ intent: next });
                  setIntent(next);
                }
              }}
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
                onChange={(event) => {
                  if (guard.isCurrent() && !frozen) {
                    keepDraft({ taxCode: event.target.value });
                    setTaxCode(event.target.value);
                  }
                }}
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
                disabled={busy || !canSubmit || (!uncertain && (amount === null || !title.trim() || !taxCode.trim()))}
              >
                {busy ? m.creator_saving() : uncertain ? m.creator_retry() : m.creator_create()}
              </Button>
            )}
          </form>
          <details className="min-w-0 rounded-xl border bg-card p-5 text-card-foreground">
            <summary className="min-h-11 cursor-pointer content-center rounded-sm text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.creator_edition_details_summary()}
            </summary>
            <dl className="mt-3 min-w-0 space-y-3 text-sm">
              {[
                [m.creator_edition_details_edition_id(), editor.edition.editionId],
                [m.creator_edition_details_revision_id(), editor.edition.revisionId],
                [m.creator_edition_details_digest(), editor.edition.sha256],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 select-text break-all font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </article>
  );
}
