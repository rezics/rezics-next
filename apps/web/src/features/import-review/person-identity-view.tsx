import { useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { ProviderStatement, providerOutcomeText } from './provider-review-actions-view';
import { useProviderVisit } from './provider-visit';
import type {
  PersonComparison,
  PersonPublication,
  PersonReviewCommand,
  PersonReviewResult,
  PersonReviewTransport,
  PersonReviewPair,
} from './person-identity';

/** A deliberate identity action has separate consent and never accepts or adopts catalogue statements. */
export function ProviderPersonReview({
  transport,
  current,
  canWrite,
  locale,
}: {
  transport: PersonReviewTransport;
  current: () => boolean;
  canWrite: boolean;
  locale: string;
}) {
  const id = useId();
  const visit = useProviderVisit(current, transport);
  const [comparison, setComparison] = useState<PersonComparison>();
  const [consent, setConsent] = useState(false);
  const [citation, setCitation] = useState('');
  const [intent, setIntent] = useState<PersonReviewCommand>();
  const [result, setResult] = useState<PersonReviewResult>();
  const [publication, setPublication] = useState<PersonPublication>();
  const [busy, setBusy] = useState(false);
  const held = useRef(false);
  const generation = useRef(0);
  const o = { locale: locale as never };
  // Uncertain delivery retains the original body, endpoints, key and transport until exact replay resolves it.
  const uncertain = !!intent && (!result || (!result.ok && result.reason === 'unavailable'));
  const locked = busy || uncertain || result?.ok === true;
  function changed() {
    generation.current++;
    setPublication(undefined);
    setComparison(undefined);
    setConsent(false);
    setResult(undefined);
    setIntent(undefined);
  }
  async function merge(command: PersonReviewCommand) {
    if (!visit.live() || held.current) return;
    held.current = true;
    setBusy(true);
    try {
      const next = await transport.merge(structuredClone(command));
      if (visit.live()) {
        setResult(next);
        if (!next.ok && next.reason !== 'unavailable') {
          setConsent(false);
          setComparison((previous) => (previous?.ok ? { ...previous, merge: null } : previous));
        }
      }
    } finally {
      held.current = false;
      if (visit.live()) setBusy(false);
    }
  }
  return (
    <section className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {m.person_review_title({}, o)}
      </h2>
      <p>{m.person_review_help({}, o)}</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!visit.live() || held.current || locked) return;
          const values = new FormData(event.currentTarget);
          const pair: PersonReviewPair = [
            {
              subject: String(values.get('bangumi-subject')),
              source: String(values.get('bangumi-source')) as PersonReviewPair[0]['source'],
              externalId: String(values.get('bangumi-key')),
            },
            {
              subject: String(values.get('vndb-subject')),
              source: String(values.get('vndb-source')) as PersonReviewPair[1]['source'],
              externalId: String(values.get('vndb-key')),
            },
          ];
          const version = ++generation.current;
          held.current = true;
          setBusy(true);
          setConsent(false);
          setResult(undefined);
          setIntent(undefined);
          try {
            const next = await transport.compare(pair);
            if (visit.live() && version === generation.current) setComparison(next);
          } finally {
            held.current = false;
            if (visit.live()) setBusy(false);
          }
        }}
      >
        <fieldset disabled={locked} className="space-y-4" onChange={changed}>
          <div className="grid gap-4 md:grid-cols-2">
            {(['bangumi', 'vndb'] as const).map((source) => (
              <fieldset key={source} className="min-w-0 space-y-2 rounded border p-4">
                <legend>{source === 'bangumi' ? 'Bangumi · wdt:P6298' : 'VNDB · wdt:P3180'}</legend>
                <label htmlFor={`${id}-${source}-source`}>{m.person_review_claim_source({}, o)}</label>
                <select
                  id={`${id}-${source}-source`}
                  name={`${source}-source`}
                  defaultValue={`${source}_cross_media`}
                  className="min-h-11 w-full rounded border bg-background px-3"
                >
                  <option value={`${source}_cross_media`}>{source}_cross_media</option>
                  <option value={source}>{source}</option>
                </select>
                <label htmlFor={`${id}-${source}-subject`}>{m.person_review_original({}, o)}</label>
                <Input id={`${id}-${source}-subject`} name={`${source}-subject`} required pattern="[0-9a-fA-F-]{36}" />
                <label htmlFor={`${id}-${source}-key`}>{m.person_review_source_key({}, o)}</label>
                <Input
                  id={`${id}-${source}-key`}
                  name={`${source}-key`}
                  required
                  maxLength={255}
                  pattern={source === 'bangumi' ? 'person:[1-9][0-9]*' : 's[1-9][0-9]*'}
                  placeholder={source === 'bangumi' ? 'person:1916' : 's224'}
                />
              </fieldset>
            ))}
          </div>
          <Button type="submit" className="min-h-11">
            {m.person_review_compare({}, o)}
          </Button>
        </fieldset>
      </form>
      {comparison &&
        (!comparison.ok ? (
          <p role="status">{providerOutcomeText(comparison, locale)}</p>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {comparison.reads.map((read, index) => {
                const original = comparison.originals[index]!;
                const label = pickText(read.subject.labels, locale);
                return (
                  <article
                    key={original.subject}
                    className="min-w-0 space-y-3 rounded border p-4 [overflow-wrap:anywhere]"
                  >
                    <h3>
                      <a
                        className="inline-flex min-h-11 items-center underline"
                        href={subjectHref({ id: read.subject.id, label: label.text }, locale).href}
                      >
                        {label.text || read.subject.id}
                      </a>
                    </h3>
                    <p>{read.subject.type}</p>
                    <p>
                      {original.source} · {original.externalId}
                    </p>
                    <p className="text-xs">{original.subject}</p>
                    {['schema:name', original.source.startsWith('bangumi') ? 'wdt:P6298' : 'wdt:P3180'].flatMap(
                      (property) =>
                        (read.subject.statements[property] ?? []).map((statement) => (
                          <ProviderStatement
                            key={statement.id}
                            statement={statement}
                            row={{ subject: read.subject.id, related: read.related }}
                            locale={locale}
                          />
                        )),
                    )}
                  </article>
                );
              })}
            </div>
            {!comparison.merge && <p role="status">{m.person_review_unavailable({}, o)}</p>}
            <label className="block space-y-2" htmlFor={`${id}-citation`}>
              <span>{m.person_review_citation({}, o)}</span>
              <Input
                id={`${id}-citation`}
                type="url"
                value={citation}
                disabled={locked}
                onChange={(event) => {
                  if (visit.live()) {
                    setCitation(event.target.value);
                    setConsent(false);
                  }
                }}
              />
            </label>
            {/^https?:\/\//.test(citation) && (
              <a
                className="inline-flex min-h-11 items-center underline"
                href={citation}
                target="_blank"
                rel="noreferrer"
              >
                {m.person_review_open_evidence({}, o)}
              </a>
            )}
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={consent}
                disabled={locked || !comparison.merge || !canWrite || !/^https?:\/\//.test(citation)}
                onChange={(event) => {
                  if (visit.live()) setConsent(event.target.checked);
                }}
              />
              <span>{m.person_review_consent({}, o)}</span>
            </label>
            <Button
              type="button"
              className="min-h-11"
              disabled={locked || !comparison.merge || !canWrite || !consent}
              onClick={() => {
                if (!visit.live() || !comparison.merge || !consent || locked) return;
                const command = { body: structuredClone(comparison.merge), key: crypto.randomUUID() };
                setIntent(command);
                void merge(command);
              }}
            >
              {m.person_review_confirm({}, o)}
            </Button>
          </>
        ))}
      {busy && <p role="status">{m.candidate_loading({}, o)}</p>}
      {result && (
        <p role="status">{result.ok ? m.person_review_admitted({}, o) : providerOutcomeText(result, locale)}</p>
      )}
      {result?.ok && intent && (
        <div className="space-y-3">
          <Button
            type="button"
            className="min-h-11"
            disabled={busy}
            onClick={async () => {
              if (!visit.live() || held.current) return;
              held.current = true;
              setBusy(true);
              try {
                const next = await transport.publication({ command: intent, operation: result.admission.operation.id });
                if (visit.live()) setPublication(next);
              } finally {
                held.current = false;
                if (visit.live()) setBusy(false);
              }
            }}
          >
            {m.person_review_check_publication({}, o)}
          </Button>
          {publication &&
            (!publication.ok ? (
              <p role="status">{providerOutcomeText(publication, locale)}</p>
            ) : publication.state === 'published' ? (
              <p role="status">
                {m.person_review_published({}, o)}{' '}
                <a
                  className="inline-flex min-h-11 items-center underline"
                  href={
                    subjectHref(
                      {
                        id: publication.read.subject.id,
                        label: pickText(publication.read.subject.labels, locale).text,
                      },
                      locale,
                    ).href
                  }
                >
                  {pickText(publication.read.subject.labels, locale).text || publication.read.subject.id}
                </a>
              </p>
            ) : (
              <p role="status">
                {publication.state === 'pending'
                  ? m.person_review_publication_pending({}, o)
                  : m.person_review_unconfirmed({}, o)}
              </p>
            ))}
        </div>
      )}
      {uncertain && !busy && (
        <>
          <p role="status">{m.person_review_uncertain({}, o)}</p>
          <Button
            type="button"
            className="min-h-11"
            onClick={() => {
              if (intent) void merge(intent);
            }}
          >
            {m.prq_retry({}, o)}
          </Button>
        </>
      )}
    </section>
  );
}
