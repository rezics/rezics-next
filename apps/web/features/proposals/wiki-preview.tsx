import { Badge } from '@rezics/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@rezics/ui/collapsible';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { T } from './parts.tsx';
import type { WikiClaim, WikiCorrection, WikiEntity, WikiEvidence, WikiLocator, WikiName, WikiObject, WikiView }
  from './wiki.ts';

const languageName = (tag: string, locale: UiLocale) => {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
};

/** A group of the preview a reviewer can fold away: its heading names what it holds and how many. */
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <Collapsible defaultOpen unmountOnExit={false} lazyMount={false} className="grid gap-3">
    <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-start">
      <span className="flex min-w-0 items-center gap-2 font-medium">{title}
        <Badge variant="secondary" size="md">{count}</Badge></span>
      <CollapsibleIndicator className="shrink-0" />
    </CollapsibleTrigger>
    <CollapsibleContent className="grid gap-3">{children}</CollapsibleContent>
  </Collapsible>;
}

const wrap = '[overflow-wrap:anywhere]';
const card = 'grid min-w-0 gap-2 rounded-xl bg-muted/40 px-3 py-2.5 text-sm';

function locatorText(locator: WikiLocator, t: T): string {
  switch (locator.kind) {
    case 'block': return t.wikiLocatorBlock({ block: locator.block });
    case 'script': return t.wikiLocatorScript({ label: locator.label, line: String(locator.line) });
    case 'epub': return t.wikiLocatorEpub;
    case 'bytes': return t.wikiLocatorBytes({ start: String(locator.start), end: String(locator.end) });
  }
}

function Evidence({ evidence, t }: { evidence: readonly WikiEvidence[]; t: T }) {
  return <ul className="grid gap-1.5">
    {evidence.map((item, index) => <li key={index} className="grid min-w-0 gap-0.5 border-border border-s-2 ps-3">
      {item.quote ? <q dir="auto" {...item.language ? { lang: item.language } : {}}
        className={`text-pretty ${wrap}`}>{item.quote}</q>
        : <span className="text-muted-foreground">{t.wikiQuoteWithheld}</span>}
      {item.locator ? <span className="text-muted-foreground text-xs">{locatorText(item.locator, t)}</span> : null}
    </li>)}
  </ul>;
}

function NameRow({ name, t, locale }: { name: WikiName; t: T; locale: UiLocale }) {
  const kind = { primary: t.wikiNamePrimary, alias: t.wikiNameAlias, title: t.wikiNameTitle }[name.kind];
  return <li className="grid min-w-0 gap-0.5">
    <span dir="auto" lang={name.language} className={`font-medium ${wrap}`}>{name.value}</span>
    <span className="text-muted-foreground text-xs">{[kind, languageName(name.language, locale),
      name.position ? t.wikiRevealedIn({ unit: name.position }) : null].filter(Boolean).join(' · ')}</span>
  </li>;
}

function EntityCard({ entity, t, locale }: { entity: WikiEntity; t: T; locale: UiLocale }) {
  return <li className={card}>
    <div className="flex flex-wrap items-center gap-2">
      <span dir="auto" className={`font-medium ${wrap}`}>{entity.name}</span>
      {entity.type ? <span className="text-muted-foreground text-xs">{entity.type}</span> : null}
      <Badge variant={entity.existing ? 'secondary' : 'info'} size="md" className="ms-auto">
        {entity.existing ? t.wikiEntityExisting : t.wikiNew}</Badge>
    </div>
    <ul className="grid gap-1.5">{entity.names.map((name, index) => <NameRow key={index} name={name} t={t} locale={locale} />)}</ul>
  </li>;
}

const modality = (claim: WikiClaim, t: T) => ({ narrated: t.wikiNarrated, said: t.wikiSaid, rumoured: t.wikiRumoured,
  hypothetical: t.wikiHypothetical })[claim.modality];

function Sentence({ claim, t }: { claim: WikiClaim; t: T }) {
  const subject = claim.subject ?? t.wikiSomeEntity;
  const object: WikiObject = claim.object;
  return object.kind === 'entity'
    ? <p dir="auto" className={`font-medium ${wrap}`}>{t.wikiRelation({ subject, object: object.name ?? t.wikiSomeEntity })}</p>
    : <p dir="auto" className={`font-medium ${wrap}`}>{t.wikiProperty({ subject })}{' '}
      <span {...object.language ? { lang: object.language } : {}} className="font-normal">“{object.value}”</span></p>;
}

function ClaimBody({ claim, t }: { claim: WikiClaim; t: T }) {
  return <>
    <Sentence claim={claim} t={t} />
    <p className="text-muted-foreground text-xs">{[modality(claim, t),
      claim.position ? t.wikiRevealedIn({ unit: claim.position }) : null].filter(Boolean).join(' · ')}</p>
    {claim.evidence.length ? <Evidence evidence={claim.evidence} t={t} /> : null}
  </>;
}

const ClaimCard = ({ claim, t }: { claim: WikiClaim; t: T }) => <li className={card}>
  <div><Badge variant="info" size="md">{t.wikiNew}</Badge></div>
  <ClaimBody claim={claim} t={t} />
</li>;

function CorrectionCard({ correction, t }: { correction: WikiCorrection; t: T }) {
  return <li className={card}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={correction.operation === 'retract' ? 'destructive' : 'warning'} size="md">
        {correction.operation === 'retract' ? t.wikiRetract : t.wikiAmend}</Badge></div>
    {correction.reason ? <p dir="auto" className={`text-pretty ${wrap}`}>{t.wikiReason({ reason: correction.reason })}</p> : null}
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="grid min-w-0 content-start gap-1.5 rounded-xl bg-muted/60 px-3 py-2.5">
        <span className="font-medium text-muted-foreground text-xs">{t.wikiPublished}</span>
        {correction.published ? <ClaimBody claim={correction.published} t={t} />
          : <span className="text-muted-foreground">{t.wikiPublishedGone}</span>}
      </div>
      <div className="grid min-w-0 content-start gap-1.5 rounded-xl bg-primary/10 px-3 py-2.5">
        <span className="font-medium text-muted-foreground text-xs">{correction.operation === 'retract'
          ? t.wikiCitation : t.wikiReplacement}</span>
        {correction.replacement ? <ClaimBody claim={correction.replacement} t={t} />
          : correction.citation.length ? <Evidence evidence={correction.citation} t={t} />
            : <span className="text-muted-foreground">{t.unset}</span>}
      </div>
    </div>
  </li>;
}

/**
 * A wiki bundle or delta as a reviewer reads it: each entity with its names, each claim with its value, citations and
 * the point in the work where it is revealed, and each correction against the claim it changes. What is new against
 * the wiki as it stands is marked; groups fold so a long proposal can be read one part at a time.
 */
export function WikiPreview({ view, locale, t }: { view: WikiView; locale: UiLocale; t: T }) {
  if (view.kind === 'undo') return <div className="grid gap-2 text-sm">
    <p>{view.of === 'bundle' ? t.wikiUndoBundle : t.wikiUndoDelta}</p>
    <LocalizedLink href={`/proposals/${view.proposal}`} className="w-fit font-medium text-primary hover:underline">
      {t.wikiUndoLink}</LocalizedLink>
  </div>;
  const { entities, claims, corrections } = view;
  if (!entities.length && !claims.length && !corrections.length) return <p className="text-muted-foreground text-sm">
    {t.changesEmpty}</p>;
  return <div className="grid min-w-0 gap-5">
    {view.extractedBy ? <p className="text-muted-foreground text-sm">{t.wikiPreparedBy({ agent: view.extractedBy })}</p> : null}
    {corrections.length ? <Group title={t.wikiCorrections} count={corrections.length}>
      <ul className="grid gap-3">{corrections.map((correction, index) =>
        <CorrectionCard key={index} correction={correction} t={t} />)}</ul></Group> : null}
    {entities.length ? <Group title={t.wikiEntities} count={entities.length}>
      <ul className="grid gap-3">{entities.map((entity, index) =>
        <EntityCard key={index} entity={entity} t={t} locale={locale} />)}</ul></Group> : null}
    {claims.length ? <Group title={t.wikiClaims} count={claims.length}>
      <ul className="grid gap-3">{claims.map((claim, index) => <ClaimCard key={index} claim={claim} t={t} />)}</ul></Group> : null}
  </div>;
}
