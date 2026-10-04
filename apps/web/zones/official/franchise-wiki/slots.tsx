import type { EntitySlotProps, HomeSlotProps, MemberIndexSlotProps, ZoneEntity, ZoneEvidence, ZoneMember,
  ZonePositionState, ZoneSlotProps, ZoneText } from '@rezics/zone-sdk';
import { ArrowLeftIcon, ArrowRightIcon, BookOpenTextIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { strings } from './strings.ts';

// Slots of the official franchise wiki Zone. They only lay out what the platform read for the reader's position:
// no slot fetches, filters, counts or hides a record, and a record Main did not return is a record that is not here.

type Link = ZoneSlotProps['Link'];
type Strings = ReturnType<typeof strings>;

function Text({ text }: { text: ZoneText }) {
  return <bdi lang={text.lang || undefined} dir={text.dir}>{text.value}</bdi>;
}

/** Where the reader is reading up to; the frame's position control is the way to change it. */
function PositionNote({ position, t }: { position: ZonePositionState; t: Strings }) {
  return <p data-wiki-position="" className="fw-position">
    {position.mode === 'all' ? t.atEverything : position.label ? t.atPosition(position.label.value) : t.atAnyPosition}
  </p>;
}

/** A page's name and what it is, as a link. */
function MemberLink({ member, Link }: { member: ZoneMember; Link: Link }) {
  return <Link href={member.href} className="fw-member">
    <span lang={member.name.lang || undefined} dir={member.name.dir} className="fw-member-name">{member.name.value}</span>
    {member.kind ? <span className="fw-member-kind">{member.kind}</span> : null}
  </Link>;
}

function Chips({ members, Link }: { members: readonly ZoneMember[]; Link: Link }) {
  return <ul className="fw-chips">{members.map(member => <li key={member.id}><MemberLink member={member} Link={Link} /></li>)}</ul>;
}

/** The chapter guide: chapters in the story's order, numbered by their place in it. */
function Guide({ members, Link }: { members: readonly ZoneMember[]; Link: Link }) {
  return <ol className="fw-guide">{members.map(member => <li key={member.id}>
    <Link href={member.href}><span lang={member.name.lang || undefined} dir={member.name.dir}>{member.name.value}</span></Link>
  </li>)}</ol>;
}

/** The timeline: events in the order Main returned them (the order the story reveals them), along a rail. */
function Timeline({ members, Link }: { members: readonly ZoneMember[]; Link: Link }) {
  return <ol className="fw-timeline">{members.map(member => <li key={member.id}>
    <Link href={member.href}><span lang={member.name.lang || undefined} dir={member.name.dir}>{member.name.value}</span></Link>
    {member.kind ? <span className="fw-member-kind">{member.kind}</span> : null}
  </li>)}</ol>;
}

/** A list of members laid out for what the mounted list is: a guide, a timeline or names. */
function Members({ segment, members, Link }: { segment: string; members: readonly ZoneMember[]; Link: Link }) {
  if (segment === 'chapters') return <Guide members={members} Link={Link} />;
  if (segment === 'events') return <Timeline members={members} Link={Link} />;
  return <Chips members={members} Link={Link} />;
}

function headingFor(segment: string, fallback: ZoneText, t: Strings): string {
  const known: Record<string, string> = { franchise: t.worksHeading, characters: t.characters, places: t.places,
    chapters: t.chapters, events: t.events };
  return known[segment] ?? fallback.value;
}

/** The Zone's home: the Works the wiki covers, then each mounted list's first pages, and what is missing. */
export function WikiHome({ zone, sections, position, card, Link }: HomeSlotProps) {
  const t = strings(zone.locale);
  const hasWorks = sections.some(section => section.works.length);
  const lists = sections.filter(section => !section.works.length);
  const hasPages = lists.some(section => section.members.length);
  return <div data-wiki-home="" className="fw-page">
    <PositionNote position={position} t={t} />
    {sections.map(section => {
      const id = `fw-${section.segment}`;
      const empty = !section.works.length && !section.members.length;
      return <section key={section.segment} aria-labelledby={id} data-wiki-section={section.segment} className="fw-section">
        <header className="fw-section-head">
          <h2 id={id} className="fw-title">{headingFor(section.segment, section.name, t)}
            {!empty ? <> <span data-wiki-count={section.works.length + section.members.length} className="fw-count">
              {new Intl.NumberFormat(zone.locale).format(section.works.length + section.members.length)}{section.more ? '+' : ''}
            </span></> : null}</h2>
          {!empty ? <Link href={section.href} className="fw-all">{t.seeAll}</Link> : null}
        </header>
        {section.works.length ? <ul className="fw-works">{section.works.map(work => <li key={work.id}>
          {card(work, { layout: 'cover' })}</li>)}</ul>
          : section.members.length ? <Members segment={section.segment} members={section.members} Link={Link} />
            : <p className="fw-quiet">{t.nothingHere}</p>}
        {section.more && !empty ? <p className="fw-quiet">{t.more}</p> : null}
      </section>;
    })}
    {!hasPages ? <aside aria-labelledby="fw-empty" className="fw-empty">
      <BookOpenTextIcon aria-hidden="true" />
      <h2 id="fw-empty" className="fw-title">{t.emptyTitle}</h2>
      <p>{hasWorks ? t.emptyWithWorks : t.emptyNoWorks}</p>
      <p>{t.buildIt}</p>
      <Link href={zone.links.about} className="fw-all">{t.howRun}</Link>
    </aside> : lists.some(section => !section.members.length) ? <aside aria-labelledby="fw-young" className="fw-empty">
      <h2 id="fw-young" className="fw-title">{t.youngTitle}</h2>
      <p>{t.youngBody}</p>
      <p>{t.buildIt}</p>
      <Link href={zone.links.about} className="fw-all">{t.howRun}</Link>
    </aside> : null}
  </div>;
}

/** The index page of a mounted list of pages: a guide, a timeline or names, under the position. */
export function WikiMemberIndex({ zone, members, mount, position, more, Link }: MemberIndexSlotProps) {
  const t = strings(zone.locale);
  return <div data-wiki-index={mount.segment} className="fw-page">
    <PositionNote position={position} t={t} />
    <Members segment={mount.segment} members={members} Link={Link} />
    {more ? <p className="fw-quiet">{t.more}</p> : null}
  </div>;
}

function Evidence({ item, t }: { item: ZoneEvidence; t: Strings }) {
  const source = [item.mediaType ? t.sourceEdition(item.mediaType) : null, item.agent ? t.sourceAgent(item.agent) : null,
    t.rights[item.rights] ?? item.rights].filter(Boolean).join(' · ');
  return <figure data-wiki-evidence="" className="fw-evidence">
    <figcaption className="fw-supports">{item.supports}</figcaption>
    {item.text && !item.withheld ? <blockquote lang={item.text.lang || undefined} dir={item.text.dir}>
      <p>{item.text.value}</p></blockquote> : <p className="fw-quiet">{t.withheld}</p>}
    <p className="fw-source"><span>{t.source}:</span> {source}
      {' · '}{t.modality[item.modality] ?? item.modality}</p>
  </figure>;
}

function Infobox({ entity, t, Link }: { entity: ZoneEntity; t: Strings; Link: Link }) {
  const rows: [string, ReactNode][] = [];
  // A chapter is a position in the story, not a kind of thing; its registry word ("List item") says nothing.
  if (entity.kind && !entity.chapter) rows.push([t.kind, entity.kind]);
  for (const fact of entity.facts) rows.push([fact.label, <ul key={fact.label} className="fw-values">
    {fact.values.map((value, index) => <li key={index}>{value.href
      ? <Link href={value.href}><Text text={value.text} /></Link> : <Text text={value.text} />}
      {value.continuity?.length ? <span data-wiki-continuity="" className="fw-quiet">{' ('}{value.continuity.map((where, at) =>
        <span key={at}>{at ? ', ' : ''}{where.href ? <Link href={where.href}><Text text={where.name} /></Link> : <Text text={where.name} />}</span>)}{')'}</span> : null}</li>)}</ul>]);
  if (entity.firstSeen) rows.push([t.firstAppears, entity.firstSeen.href
    ? <Link href={entity.firstSeen.href}><Text text={entity.firstSeen.name} /></Link> : <Text text={entity.firstSeen.name} />]);
  if (!rows.length) return null;
  return <aside aria-label={t.atAGlance} data-wiki-infobox="" className="fw-infobox">
    <h2 className="fw-title">{t.atAGlance}</h2>
    <dl>{rows.map(([label, value], index) => <div key={index}><dt>{label || t.relationship}</dt><dd>{value}</dd></div>)}</dl>
  </aside>;
}

function ChapterBody({ entity, position, t, Link }: { entity: ZoneEntity; position: ZonePositionState; t: Strings; Link: Link }) {
  const chapter = entity.chapter!;
  return <>
    {chapter.reached ? chapter.reveals.length ? <section aria-labelledby="fw-reveals" data-wiki-reveals="" className="fw-section">
      <h2 id="fw-reveals" className="fw-title">{t.revealedHere}</h2>
      {chapter.reveals.map(list => <div key={list.segment} className="fw-reveal">
        <h3>{headingFor(list.segment, list.name, t)}</h3>
        <Members segment={list.segment} members={list.members} Link={Link} />
        {!list.complete ? <p className="fw-quiet">{t.incomplete}</p> : null}
      </div>)}
    </section> : <p className="fw-quiet">{t.nothingNew}</p>
      : <p data-wiki-unreached="" className="fw-quiet">{t.notReached}{position.showAllHref
        ? <>{' '}<Link href={position.showAllHref}>{t.showEverything}</Link></> : null}</p>}
    {chapter.previous || chapter.next ? <nav aria-label={t.chapterNav} className="fw-neighbours">
      {chapter.previous ? <Link href={chapter.previous.href} rel="prev"><ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
        <span><span className="fw-member-kind">{t.previous}</span><Text text={chapter.previous.name} /></span></Link> : <span />}
      {chapter.next ? <Link href={chapter.next.href} rel="next"><span><span className="fw-member-kind">{t.next}</span>
        <Text text={chapter.next.name} /></span><ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></Link> : <span />}
    </nav> : null}
  </>;
}

/** A character, place, event or chapter: names by language, an infobox from recorded statements, relationships as rows and the passages behind them. */
export function WikiEntity({ zone, entity, position, mount, rest, Link }: EntitySlotProps) {
  const t = strings(zone.locale);
  return <article data-wiki-entity="" className="fw-page fw-entity">
    {mount ? <p className="fw-back"><Link href={mount.href}><ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
      {t.back(mount.name.value)}</Link></p> : null}
    <PositionNote position={position} t={t} />
    <header className="fw-entity-head">
      <h1 lang={entity.name.lang || undefined} dir={entity.name.dir} className="fw-entity-name">{entity.name.value}</h1>
      {entity.aliases.length ? <p data-wiki-aliases="" className="fw-aliases"><span>{t.alsoKnownAs}:</span>{' '}
        {entity.aliases.map((alias, index) => <span key={index}>{index ? ', ' : ''}<Text text={alias} /></span>)}</p> : null}
    </header>
    <div className="fw-entity-grid">
      <div className="fw-entity-main">
        {entity.chapter ? <ChapterBody entity={entity} position={position} t={t} Link={Link} /> : null}
        {entity.relationships.length ? <section aria-labelledby="fw-relationships" data-wiki-relationships="" className="fw-section">
          <h2 id="fw-relationships" className="fw-title">{t.relationships}</h2>
          <dl className="fw-rows">{entity.relationships.map((row, index) => <div key={index}>
            <dt>{row.label || t.relationship}</dt>
            <dd><ul className="fw-chips">{row.others.map((other, at) => <li key={at}>{other.href
              ? <Link href={other.href} className="fw-member"><Text text={other.name} /></Link>
              : <span className="fw-member"><Text text={other.name} /></span>}
              {other.creditedName ? <span data-credited-name className="fw-quiet">{' '}{t.creditedAs}{' '}<Text text={other.creditedName} /></span> : null}</li>)}</ul></dd>
          </div>)}</dl>
        </section> : null}
        {entity.evidence.length ? <section aria-labelledby="fw-passages" data-wiki-passages="" className="fw-section">
          <h2 id="fw-passages" className="fw-title">{t.passages}</h2>
          {entity.evidence.map(item => <Evidence key={item.id} item={item} t={t} />)}
        </section> : null}
        {entity.more ? <p className="fw-quiet">{t.moreOnFull}{' '}<Link href={entity.fullPage}>{t.openFull}</Link></p> : null}
        {rest}
      </div>
      <Infobox entity={entity} t={t} Link={Link} />
    </div>
  </article>;
}
