import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { RatingInline } from '../catalogue/rating.tsx';
import { RelationRows } from '../work-levels/connections.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { SummaryLink } from '../work-levels/names.tsx';
import { relationRows } from '../work-levels/relation-rows.ts';
import type { AvailableSummary } from '../work-levels/types.ts';
import { Distribution } from '../work-page/ratings.tsx';
import { Region, RegionFailure } from '../work-page/region.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import type { Loaded } from '../work-page/types.ts';
import { EntityAvatar } from './header.tsx';
import type {
  IdentityData,
  IdentityMember,
  IdentitySectionData,
  IdentitySectionKind,
} from './identity-relations.ts';
import type { Copy } from './messages.ts';
import type { HrefFor } from './types.ts';
import { summaryHref } from './views.tsx';

export function identityContinuation(
  href: string,
  section: 'family' | 'relations',
  cursor: string,
): string {
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set(section, cursor);
  url.hash = section === 'family' ? 'identity-family' : 'relations';
  return url.pathname + url.search + url.hash;
}

function Figures({
  member,
  locale,
  t,
  messages,
}: {
  member: IdentityMember;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
}) {
  if (!member.ratings.ok)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t.identityRatingsUnavailable}
      </p>
    );
  const { summary, context } = member.ratings.data;
  if (summary.status !== 'available' || !summary.scale)
    return <p className="text-muted-foreground text-sm">{t.noRatingQuestion}</p>;
  const shown =
    summary.mean !== null && (!('meanDisplay' in summary) || summary.meanDisplay === 'shown');
  return (
    <div className="grid gap-3" data-identity-ratings>
      {context ? (
        <p lang={context.language} dir="auto" className="text-muted-foreground text-xs">
          {context.question}
        </p>
      ) : null}
      <RatingInline
        rating={
          shown
            ? { mean: summary.mean!, count: summary.count, max: summary.scale.max }
            : {
                mean: null,
                count: summary.count,
                max: summary.scale.max,
                displayThreshold: 'displayThreshold' in summary ? summary.displayThreshold : null,
              }
        }
        locale={locale}
      />
      <Distribution summary={summary} locale={locale} messages={messages} />
    </div>
  );
}

function Member({
  member,
  locale,
  t,
  messages,
  hrefFor,
  avatarQuery,
}: {
  member: IdentityMember;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
  hrefFor: HrefFor;
  avatarQuery?: string;
}) {
  const href = summaryHref(hrefFor);
  const rows = member.entry
    ? relationRows([member.entry]).filter((row) =>
        row.items.some(
          (item) =>
            item.target.kind === 'resource' && item.target.reference === member.summary.reference,
        ),
      )
    : [];
  return (
    <li
      data-identity-member={member.summary.reference}
      className="grid min-w-0 content-start gap-4 rounded-xl border border-border/70 p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <EntityAvatar
          summary={member.summary}
          avatarQuery={avatarQuery}
          className="size-12! text-xl!"
        />
        <div className="grid min-w-0 gap-1">
          {rows.length ? (
            <RelationRows rows={rows} locale={locale} t={levelsCopy(locale)} hrefFor={href} />
          ) : (
            <SummaryLink
              summary={member.summary}
              unavailable={t.unavailable}
              unnamed={t.unnamed}
              hrefFor={href}
            />
          )}
          {member.hub ? (
            <p className="text-muted-foreground text-xs">{t.identityHub}</p>
          ) : member.entry?.rendering?.viewingRole === 'hub' ? (
            <p data-variant-kind className="text-muted-foreground text-sm">
              {member.kind ? (
                <SummaryLink
                  summary={member.kind}
                  unavailable={t.unavailable}
                  unnamed={t.unnamed}
                  hrefFor={href}
                />
              ) : (
                t.unknownVariantKind
              )}
            </p>
          ) : null}
        </div>
      </div>
      {member.applicability === null ? (
        <p className="text-muted-foreground text-xs">{t.titleContextUnavailable}</p>
      ) : member.applicability.length ? (
        <ul data-title-context className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {member.applicability.map((where) => (
            <li key={where.reference}>
              <SummaryLink
                summary={where}
                unavailable={t.unavailable}
                unnamed={t.unnamed}
                hrefFor={href}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <Figures member={member} locale={locale} t={t} messages={messages} />
    </li>
  );
}

function IdentitySection({
  section,
  self,
  ...props
}: {
  section: IdentitySectionData;
  self: AvailableSummary;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
  hrefFor: HrefFor;
  avatarQuery?: string;
  currentHref?: string;
}) {
  const { t, hrefFor } = props;
  const titles: Record<IdentitySectionKind, string> = {
    family: t.variantFamily,
    units: t.units,
    represents: t.represents,
    titles: t.titlesHeld,
    holders: t.titleHolders,
  };
  const empty: Record<IdentitySectionKind, string> = {
    family: t.noVariants,
    units: t.noUnits,
    represents: t.noRepresented,
    titles: t.noTitles,
    holders: t.noHolders,
  };
  const ownHub =
    section.kind === 'family' && section.hub && section.hub.reference !== self.reference;
  const next = section.next;
  const destination = props.currentHref ?? (next
    ? summaryHref(hrefFor)(section.kind === 'family' ? self : next.resource)
    : null);
  const cursorKey = section.kind === 'family' && ownHub ? 'family' : 'relations';
  return (
    <Region id={`identity-${section.kind}`} title={titles[section.kind]}>
      {ownHub ? (
        <p data-identity-hub className="flex flex-wrap gap-x-2 text-sm">
          <span className="text-muted-foreground">{t.variantOf}</span>
          <SummaryLink
            summary={section.hub}
            unavailable={t.unavailable}
            unnamed={t.unnamed}
            hrefFor={summaryHref(hrefFor)}
          />
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{t.visibleRelationsOnly}</p>
      {section.members.length ? (
        <ul className="grid min-w-0 gap-4 md:grid-cols-2">
          {section.members.map((member, index) => (
            <Member
              key={`${member.summary.reference}-${member.entry?.relation ?? index}`}
              member={member}
              {...props}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl bg-muted/60 p-4 text-muted-foreground text-sm">
          {empty[section.kind]}
        </p>
      )}
      {next && destination ? (
        <Link
          href={identityContinuation(destination, cursorKey, next.cursor)}
          className="w-fit rounded-sm text-primary text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t.moreIdentityRelations}
        </Link>
      ) : null}
    </Region>
  );
}

export function IdentitySectionsView({
  data,
  self,
  ...props
}: {
  data: Loaded<IdentityData>;
  self: AvailableSummary;
  locale: UiLocale;
  t: Copy;
  messages: WorkPageMessages;
  hrefFor: HrefFor;
  avatarQuery?: string;
  currentHref?: string;
}) {
  if (!data.ok)
    return (
      <Region id="identity-relations" title={props.t.relations}>
        <RegionFailure
          title={props.t.relationsUnavailable}
          failure={data.failure}
          messages={props.messages}
          restartHref={props.hrefFor({ kind: 'continue', section: 'relations', cursor: null })}
        />
      </Region>
    );
  return (
    <>
      {data.data.sections.map((section) => (
        <IdentitySection key={section.kind} section={section} self={self} {...props} />
      ))}
    </>
  );
}
