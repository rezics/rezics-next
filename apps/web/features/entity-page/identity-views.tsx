import type { UiLocale } from '../../i18n/define.ts';
import { LocalizedText } from '@rezics/ui/localized-text';
import Link from '../shell/localized-link.tsx';
import { figuresOfRating } from '../scoped-rating/score.ts';
import { SummaryLink } from '../work-levels/names.tsx';
import type { AvailableSummary } from '../work-levels/types.ts';
import { Distribution, Mean } from '../work-page/ratings.tsx';
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
  cursor: string | null,
): string {
  const url = new URL(href, 'https://rezics.invalid');
  if (cursor === null) url.searchParams.delete(section);
  else url.searchParams.set(section, cursor);
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
  if (!member.ratings) return null;
  if (!member.ratings.ok)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t.identityRatingsUnavailable}
      </p>
    );
  const figures = figuresOfRating(member.ratings.data.summary);
  if (!figures) return <p className="text-muted-foreground text-sm">{t.noRatingQuestion}</p>;
  if (!figures.count)
    return (
      <p data-identity-ratings className="text-muted-foreground text-sm">
        {t.noRatings}
      </p>
    );
  return (
    <div className="grid gap-1.5" data-identity-ratings>
      <Mean figures={figures} size="sm" locale={locale} messages={messages} />
      <Distribution compact figures={figures} locale={locale} messages={messages} />
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
  return (
    <li
      data-identity-member={member.summary.reference}
      className="flex min-w-0 items-start gap-3 border-border/60 border-b py-3 last:border-b-0 md:rounded-xl md:border md:p-4 md:last:border-b"
    >
      <EntityAvatar
        summary={member.summary}
        avatarQuery={avatarQuery}
        className="size-12! text-xl!"
      />
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="grid gap-0.5">
          <SummaryLink
            summary={member.summary}
            unavailable={t.unavailable}
            unnamed={t.unnamed}
            hrefFor={href}
          />
          {member.hub ? (
            <p className="text-muted-foreground text-xs">{t.identityHub}</p>
          ) : member.entry?.rendering?.viewingRole === 'hub' ? (
            <p data-variant-kind className="text-muted-foreground text-sm">
              {member.kindKey === 'persona'
                ? t.alternateSelf
                : member.kindKey === 'counterpart'
                  ? t.otherWorldCounterpart
                  : t.unknownVariantKind}
            </p>
          ) : null}
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
      </div>
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
  const destination =
    props.currentHref ??
    (next ? summaryHref(hrefFor)(section.kind === 'family' ? self : next.resource) : null);
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
      {section.legend && section.members.length ? (
        <p
          data-identity-question
          className="flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground text-xs"
        >
          <span>
            {section.legend.scope === 'global' ? (
              t.identityGlobal
            ) : section.legend.realm ? (
              <LocalizedText text={section.legend.realm} />
            ) : (
              t.identityRealm
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span
            lang={section.legend.context.displayQuestion.language}
            dir={section.legend.context.displayQuestion.direction}
          >
            {section.legend.context.displayQuestion.value}
          </span>
        </p>
      ) : null}
      {section.members.length ? (
        <ul className="grid min-w-0 md:auto-rows-fr md:grid-cols-2 md:gap-3">
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
          restartHref={identityContinuation(
            props.hrefFor({ kind: 'continue', section: 'relations', cursor: null }),
            'family',
            null,
          )}
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
