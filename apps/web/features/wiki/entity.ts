import type { ZoneChapter, ZoneEntity, ZoneEvidence, ZoneFact, ZoneNeighbour, ZoneRelationship, ZoneText }
  from '@rezics/zone-sdk';
import { entryLabel } from '../catalogue/types.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { readPredicateLabels } from '../entity-page/predicate-labels.ts';
import { readEntityProjection, readRelations, readStatements, sectionOf } from '../entity-page/read.ts';
import type { EntityProjection, StatementItem } from '../entity-page/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { offContinuity, pageFrame } from './continuity.ts';
import { zoneText } from '../realm/adapt.ts';
import { creditedNameOf, relationRows } from '../work-levels/relation-rows.ts';
import { namesOf } from '../work-levels/read.ts';
import { idOf } from '../work-page/route.ts';
import { memberHref, zoneLink, type ZoneSite } from './links.ts';
import { readEvidence, type ChooserItem } from './read.ts';
import { firstSeen, revealedAt } from './reveal.ts';
import { itemLabel, occurrenceName, type PositionState } from './state.ts';

// A wiki page's data for a package's `entity` slot: the page projection, the statements and relations Main returned
// for the reader's position, and the evidence those cite. Everything shown was in an answer; a read that failed
// leaves its part out and the page says where the full record continues.

/** At most this many passages are read for one page, and this many facts listed: the rest continue on the full page. */
export const EVIDENCE_LIMIT = 6;
export const FACT_LIMIT = 24;

const NAME = 'https://schema.org/name';
const ALTERNATE = 'https://schema.org/alternateName';
/** The last word of a predicate's IRI: what Main recorded, when no name was served for it. */
const localName = (iri: string) => iri.split(/[#/]/).filter(Boolean).at(-1) ?? iri;
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

function literalText(item: StatementItem): ZoneText | null {
  if (item.kind === 'component-property') {
    const { lexical, language } = item.value as { lexical?: unknown; language?: unknown };
    return typeof lexical === 'string' ? zoneContentText(lexical, typeof language === 'string' ? language : '') : null;
  }
  return item.value.kind === 'literal' ? zoneContentText(item.value.lexical, item.value.language ?? '') : null;
}

/** A relationship participant as the Zone SDK types it, plus where a withheld credited name can be read. */
export type ZoneRelationshipOther = ZoneRelationship['others'][number] & { withheldCredit?: string };

/** A claim in words: `Family: Bennet family`, or the value alone when no label was served for the property. */
const claimText = (label: string | null, value: string) => label ? `${label}: ${value}` : value;
const evidenceIds = (sources: readonly string[]) => sources.flatMap(source => idOf(source) ?? []);

async function evidenceFor(claims: readonly { ids: string[]; supports: string }[], main: string | undefined):
  Promise<ZoneEvidence[]> {
  const wanted = claims.flatMap(claim => claim.ids.map(id => ({ id, supports: claim.supports }))).slice(0, EVIDENCE_LIMIT);
  const read = await Promise.all(wanted.map(async ({ id, supports }) => ({ supports, read: await readEvidence(id, main) })));
  return read.flatMap(({ supports, read: answer }): ZoneEvidence[] => {
    if (!answer.ok) return [];
    const { quote, quoteWithheld, modality, rightsBasis, locator, method, id } = answer.data;
    const source = (locator as { source?: { mediaType?: unknown } } | null)?.source;
    const agent = (method as { agent?: unknown } | null)?.agent;
    return [{ id, text: quote === null ? null : zoneContentText(quote), withheld: quoteWithheld || quote === null,
      supports, modality, rights: rightsBasis,
      mediaType: typeof source?.mediaType === 'string' ? source.mediaType : null,
      agent: typeof agent === 'string' ? agent : null }];
  });
}

/**
 * The page of a resource that is not a Work, as the Zone's package sets it out. `main` is the position every read
 * sends; the Zone's `site` names where each linked resource's page is.
 */
export async function buildEntity({ id, locale, projection, site, fullPage, state, mount, lists }: {
  id: string; locale: UiLocale; projection: EntityProjection; site: ZoneSite;
  /** Where the record continues in full (the standalone page, at the same position). */
  fullPage: string;
  /** The reader's position, when the Zone reads at one. */
  state: PositionState | null;
  /** The mounted list this page was opened under. */
  mount: string | null;
  /** The mounted lists a chapter's reveals are read from. */
  lists: readonly { segment: string; name: ZoneText }[];
}): Promise<ZoneEntity | null> {
  const { summary } = projection;
  if (summary.status !== 'available') return null;
  const main = site.main;
  // The continuity the reader chose, which Main applies as the frame of the facts and relations it returns.
  const frame = pageFrame(site.continuity?.choice ?? offContinuity, projection.target.base === 'projection');
  const statementsSection = sectionOf(projection, 'statements');
  const relationsSection = sectionOf(projection, 'relations');
  const [statements, relations] = await Promise.all([
    statementsSection ? readStatements(statementsSection, undefined, main, frame) : null,
    relationsSection ? readRelations(relationsSection, undefined, main, frame) : null]);

  // A chapter's summary is named after its Work; the name the story gives it is the label its composition wrote.
  const own = (state && projection.target.base === 'occurrence' ? occurrenceName(state, projection.target.resource, locale) : null) ?? zoneText(summary.name);
  const aliases: ZoneText[] = [];
  const facts: ZoneFact[] = [];
  const claims: { ids: string[]; supports: string }[] = [];
  let more = statements?.ok ? statements.data.nextCursor !== null : statementsSection !== undefined;
  if (statements?.ok) {
    const groups = statements.data.groups;
    const predicates = groups.map(group => group.predicate).filter(predicate => predicate !== NAME && predicate !== ALTERNATE);
    const valueIris = groups.flatMap(group => group.items.flatMap(item =>
      item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : []));
    const names = await namesOf(predicates, main);
    // A relation definition is named by its reviewed label, as the generic page reads it; its summary name is only a placeholder.
    const lexicon = await readPredicateLabels(statements.data, locale);
    // Their own call: a batch with a vocabulary predicate in it is refused whole, and would leave the Works unnamed.
    const continuityNames = await namesOf(groups.flatMap(group => group.items.flatMap(item => item.qualifiers.applicability)), main);
    const named = new Map(await Promise.all([...new Set(valueIris)].map(async iri => {
      const valueId = idOf(iri);
      const page = valueId ? await readEntityProjection(valueId, main) : null;
      return [iri, page?.ok && page.data.summary.status === 'available' ? page.data.summary : null] as const;
    })));
    for (const group of groups) {
      const label = (() => {
        const labelled = lexicon.get(group.predicate);
        if (labelled) return labelled.value;
        const summaryOfPredicate = names.get(group.predicate);
        if (summaryOfPredicate?.status === 'available') return summaryOfPredicate.name.value;
        const word = localName(group.predicate);
        return uuidLike.test(word) ? null : word;
      })();
      const values: ZoneFact['values'] = [];
      const applies: string[] = [];
      for (const item of group.items) {
        const text = literalText(item);
        if (group.predicate === NAME) {
          if (text && text.value !== own.value) aliases.push(text);
          continue;
        }
        if (group.predicate === ALTERNATE) {
          if (text) aliases.push(text);
          continue;
        }
        if (item.kind === 'statement' && item.value.kind === 'resource') {
          const target = named.get(item.value.iri);
          if (!target) continue;
          values.push({ text: zoneText(target.name), href: await zoneLink(site, item.value.iri, target.type) });
        } else if (text) values.push({ text, href: null });
        else continue;
        const continuity: NonNullable<ZoneFact['values'][number]['continuity']> = [];
        for (const iri of item.qualifiers.applicability) {
          const where = continuityNames.get(iri);
          if (where?.status === 'available') continuity.push({ name: zoneText(where.name), href: await zoneLink(site, iri, where.type) });
        }
        if (continuity.length) values.at(-1)!.continuity = continuity;
        applies.push([...item.qualifiers.applicability].sort().join(' '));
        const sources = item.kind === 'statement' ? evidenceIds(item.sources) : [];
        if (sources.length) claims.push({ ids: sources, supports: claimText(label, values.at(-1)!.text.value) });
      }
      if (group.predicate !== NAME && group.predicate !== ALTERNATE && values.length) {
        // Claims that differ by continuity say which each belongs to, by the Work's name; a property all of one
        // continuity needs no such note.
        if (new Set(applies).size < 2) for (const value of values) delete value.continuity;
        facts.push({ label: label ?? '', values });
      }
    }
    if (facts.length > FACT_LIMIT) { facts.length = FACT_LIMIT; more = true; }
  }

  const relationships: ZoneRelationship[] = [];
  if (relations?.ok) {
    more ||= relations.data.next !== null;
    for (const row of relationRows(relations.data.items)) {
      const others: ZoneRelationshipOther[] = [];
      for (const item of row.items) {
        if (item.target.kind === 'resource' && item.target.summary?.status === 'available') {
          const summaryOf = item.target.summary;
          others.push({ name: zoneText(summaryOf.name), href: await zoneLink(site, summaryOf.reference, summaryOf.type) });
        } else if (item.target.kind === 'external') others.push({ name: zoneContentText(item.target.label), href: null });
        else continue;
        const last = others.at(-1)!;
        const credit = creditedNameOf(item.creditedName);
        if (credit && 'status' in credit) {
          const same = item.target.kind === 'resource' && item.target.reference === credit.reference;
          last.withheldCredit = same && last.href ? last.href : await zoneLink(site, credit.reference, null);
        } else if (credit && credit.lexical !== last.name.value) {
          last.creditedName = zoneContentText(credit.lexical, credit.language);
        }
        const cited = item.evidence ? idOf(item.evidence) : null;
        if (cited) claims.push({ ids: [cited], supports: claimText(row.label.text?.value ?? null, others.at(-1)!.name.value) });
      }
      if (others.length) relationships.push({ label: row.label.text?.value ?? '', others });
    }
  }

  const evidence = await evidenceFor(claims, main);
  const asChapter = state && mount && projection.target.base === 'occurrence';
  const [chapter, seen] = await Promise.all([
    asChapter ? chapterOf({ id, site, state, mount, locale, lists }) : null,
    state && !asChapter ? firstSeen(id, state) : null]);
  const firstSeenAt = seen && state ? await positionLink(site, state, seen, locale) : null;
  return { id, kind: projection.registry.default ? null : entryLabel(projection.registry, locale), name: own, aliases, facts, relationships, evidence,
    firstSeen: firstSeenAt, more: more || claims.reduce((count, claim) => count + claim.ids.length, 0) > EVIDENCE_LIMIT,
    fullPage, chapter };
}

/** A position in the story as a link: its name and, when the Zone lists chapters, its page. */
async function positionLink(site: ZoneSite, state: PositionState, occurrence: string, locale: string):
  Promise<{ name: ZoneText; href: string | null } | null> {
  const item = state.chooser.items.find(candidate => candidate.occurrence === occurrence);
  const name = item ? itemLabel(state, item, locale) : null;
  return name ? { name, href: await zoneLink(site, occurrence, 'occurrence') } : null;
}

async function chapterOf({ id, site, state, mount, locale, lists }: {
  id: string; site: ZoneSite; state: PositionState; mount: string; locale: UiLocale;
  lists: readonly { segment: string; name: ZoneText }[];
}): Promise<ZoneChapter | null> {
  const ordered = state.chooser.items.filter(item => item.role === 'chapter');
  const index = ordered.findIndex(item => idOf(item.occurrence) === id);
  if (index < 0) return null;
  const reachedIndex = state.mode === 'all' ? ordered.length - 1
    : state.at ? ordered.findIndex(item => item.occurrence === state.at) : -1;
  const reached = index <= reachedIndex;
  const neighbour = (item: ChooserItem | undefined): ZoneNeighbour | null => {
    const name = item ? itemLabel(state, item, locale) : null;
    return item && name ? { name, href: memberHref(site, mount, item.occurrence) } : null;
  };
  const reveals = reached ? (await Promise.all(lists.filter(list => list.segment !== mount).map(async list => ({
    list, ...await revealedAt(site, state, id, list.segment, locale) })))).flatMap(({ list, members, complete }) =>
    members.length ? [{ segment: list.segment, name: list.name, members, complete }] : []) : [];
  return { reached, reveals, previous: neighbour(ordered[index - 1]), next: neighbour(ordered[index + 1]) };
}
