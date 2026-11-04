import { useContext, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { CreatorOfferDraftNavigation, CreatorOfferDraftState } from './creator-offer-draft-navigation';
import { creatorPreviewGuard, useCreatorCurrentOrigin, useCreatorIntent } from './creator-current-origin';
import { validateCreatorPrice, type CreatorPriceIssue } from './creator-price';
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

export function creatorNotice(
  kind: CreatorFailure['kind'] | 'price-unavailable' | 'retry' | 'saved' | 'conflict',
): string {
  switch (kind) {
    case 'conflict':
      return m.container_lifecycle_conflict();
    case 'denied':
      return m.creator_denied();
    case 'closed':
      return m.creator_closed();
    case 'unavailable':
      return m.creator_unavailable();
    case 'price-unavailable':
      return m.creator_price_unavailable();
    case 'rejected':
      return m.creator_rejected();
    case 'retry':
      return m.creator_uncertain();
    case 'saved':
      return m.creator_saved();
  }
}

export function parsedPrice(text: string, rule?: ConfiguredSaleCurrencyRule): number | null {
  const result = rule ? validateCreatorPrice(text, rule) : null;
  return result?.kind === 'valid' ? result.amountMinor : null;
}

function priceIssueText(issue: CreatorPriceIssue, locale: string, rule?: ConfiguredSaleCurrencyRule): string {
  const format = (minor: number) =>
    rule ? formatMinorAmount(locale, rule.currency, minor, rule.unit) ?? String(minor) : String(minor);
  switch (issue) {
    case 'malformed-decimal':
      return m.creator_price_malformed_decimal();
    case 'unsupported-currency':
      return m.creator_price_unsupported_currency();
    case 'policy-unavailable':
      return m.creator_price_unavailable();
    case 'minimum':
      return m.creator_price_minimum({ min: format(rule?.minAmountMinor ?? 0) });
    case 'maximum':
      return m.creator_price_maximum({ max: format(rule?.maxAmountMinor ?? 0) });
    case 'increment':
      return m.creator_price_increment({ increment: format(rule?.chargeMultiple ?? 1) });
    case 'unsafe-integer':
      return m.creator_price_unsafe_integer();
  }
}

/** Native text input keeps the adopted dot convention in every locale; only the preview is localized. */
export function CreatorPriceField({
  rule,
  text,
  onChange,
  locale,
  disabled = false,
  policyUnavailable = false,
}: {
  rule?: ConfiguredSaleCurrencyRule | undefined;
  text: string;
  onChange(text: string): void;
  locale: string;
  disabled?: boolean;
  policyUnavailable?: boolean;
}) {
  const id = useId();
  const validation = rule ? validateCreatorPrice(text, rule) : null;
  const raw = validation?.kind === 'valid' ? validation.amountMinor : null;
  const preview = rule && raw !== null ? formatMinorAmount(locale, rule.currency, raw, rule.unit) : null;
  const issue = policyUnavailable
    ? 'policy-unavailable'
    : text
      ? (validation?.kind === 'invalid' ? validation.issue : rule ? null : 'unsupported-currency')
      : null;
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
        disabled={disabled || policyUnavailable || !rule}
        required
        aria-invalid={!!issue}
        aria-describedby={`${id}-help ${id}-preview`}
        className="min-h-11 tabular-nums"
      />
      <p id={`${id}-help`} className="text-sm leading-relaxed text-muted-foreground">
        {m.creator_price_convention()}
      </p>
      {rule && (
        <>
          <p className="text-sm text-muted-foreground">
            {m.creator_price_range({
              min: formatMinorAmount(locale, rule.currency, rule.minAmountMinor, rule.unit) ?? '',
              max: formatMinorAmount(locale, rule.currency, rule.maxAmountMinor, rule.unit) ?? '',
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {m.creator_price_meaning({
              currency: rule.currency.toUpperCase(),
              exponent: String(rule.unit.exponent),
              tax: m.commerce_before_tax(),
            })}
          </p>
        </>
      )}
      <p id={`${id}-preview`} className="min-h-6 break-words font-medium tabular-nums" aria-live="polite">
        {issue
          ? priceIssueText(issue, locale, rule)
          : preview && rule
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
        <NativeSelect
          id={id}
          name="currency"
          required
          value={intent.currency}
          disabled={disabled}
          onChange={(event) => onChange({ currency: event.target.value, text: '' })}
          aria-describedby={`${id}-help`}
          className="w-full [&_select]:min-h-11"
        >
          <NativeSelectOption value="">{m.creator_select_currency()}</NativeSelectOption>
          {rules.map((row) => (
            <NativeSelectOption key={row.currency} value={row.currency}>
              {row.currency.toUpperCase()}
            </NativeSelectOption>
          ))}
        </NativeSelect>
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
  return (
    <CreatorOfferDraftNavigation>
      {guard ? (
        <CreatorOfferForm data={data} locale={locale} createKey={data.createKey} guard={guard} />
      ) : (
        <StandaloneCreatorOfferEditor data={data} locale={locale} />
      )}
    </CreatorOfferDraftNavigation>
  );
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
  if (!draftEditor && !pending.current && !result) key.current = createKey;
  const currentEditor = useRef(data.editor);
  currentEditor.current = data.editor;
  const currentRules = useRef<readonly ConfiguredSaleCurrencyRule[]>(
    data.editor.kind === 'ready' ? data.editor.schema.configuredSaleCurrencies : [],
  );
  currentRules.current = data.editor.kind === 'ready' ? data.editor.schema.configuredSaleCurrencies : [];
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
      const definitive = next.kind !== 'saved' && next.kind !== 'retry';
      if (definitive) {
        pending.current = null;
        submittedRules.current = null;
        key.current = crypto.randomUUID();
        setDraftEditor(undefined);
      }
      const currentEditorForCorrection = definitive ? currentEditor.current : editor;
      const currentRulesForCorrection = definitive ? currentRules.current : rules;
      memory.value = {
        editor: currentEditorForCorrection,
        rules: currentRulesForCorrection,
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
      {editor.kind === 'price-unavailable' ? (
        <section className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground" role="status">
          <p>{m.creator_price_unavailable()}</p>
          {currency && <p className="text-sm text-muted-foreground">{currency.toUpperCase()}</p>}
          <CreatorPriceField
            text={text}
            onChange={() => {}}
            locale={locale}
            disabled
            policyUnavailable
          />
          {result && <p role="alert">{creatorNotice(result.kind)}</p>}
        </section>
      ) : editor.kind !== 'ready' ? (
        <div className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground" role="status">
          <p>{editor.kind === 'choose-edition' ? m.creator_choose_edition() : creatorNotice(editor.kind)}</p>
          {editor.kind !== 'price-unavailable' && (
            <a
              href={`/${locale}/editions/new`}
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            >
              {m.creator_publish_edition()}
            </a>
          )}
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
            <CreatorOfferDraftState
              guard={guard}
              dirty={result?.kind !== 'saved' && !!(title || taxCode || currency || text)}
              mayCommit={busy || uncertain}
              discard={() => {
                delete memory.value;
                setTitle('');
                setTaxCode('');
                setIntent({ currency: '', text: '' });
                setDraftEditor(undefined);
                setResult(null);
              }}
            />
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
            {rules.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {m.creator_price_unavailable()}
              </p>
            )}
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
