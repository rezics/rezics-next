import { pickText } from '@rezics/composition';
import { useLayoutEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';
import { defaultReader } from '../../../subject/reader';
import { characterGroups } from '../../catalogue/character-profile';
import { CharacterProfileEntry } from '../../catalogue/character-profile-entry';
import { CharacterRelationshipsEntry } from '../../catalogue/character-relationships/entry';
import {
  ProfileDefinitions,
  ProfileFields,
  type PersonDefinitionsLoader,
  type ProfileReading,
} from '../../catalogue/person-reader/reader';
import { profileFields, type PersonDefinitions } from '../../catalogue/person-reader/model';
import { useSubjectCommunityReading } from '../subject-community-lifetime';
import { PlainLink } from '../shared';
import { SuppliedNames } from './names';

/** Public composition of supplied character facts. Appearances remain in the producer's bounded reader. */
export function CharacterReader(reading: ProfileReading) {
  const { public: read, release, locale } = reading;
  if (read.subject.type !== 'wd:Q95074') return null;
  const o = { locale: locale as never };
  const label = pickText(read.subject.labels, locale);
  const groups = characterGroups(release);
  const titles = {
    identity: m.character_identity({}, o),
    traits: m.character_traits({}, o),
    measurements: m.character_measurements({}, o),
    identifiers: m.character_identifiers({}, o),
  };
  // Other admitted authored fields keep their native document selection and hydration.
  groups.identity = [
    ...new Set([
      ...groups.identity,
      ...(release.types[read.subject.type]?.properties ?? []).filter(
        (id) => release.properties[id]?.datatype === 'document',
      ),
    ]),
  ];
  const Link = reading.link ?? PlainLink;
  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]" data-slot="character-reader-facts">
      <SuppliedNames reading={reading} />
      <div className="flex min-w-0 flex-wrap gap-3" data-slot="character-reader-destinations">
        <CharacterRelationshipsEntry id={read.subject.id} label={label.text} locale={locale} link={Link} />
        <a className="inline-flex min-h-11 items-center underline" href="#connections">
          {m.character_work_title({}, o)}
        </a>
      </div>
      {(Object.keys(groups) as (keyof typeof groups)[]).map((kind) => {
        const fields = profileFields(release, read, groups[kind], locale).filter((field) => field.facts.length > 0);
        return (
          <section key={kind} className="min-w-0 space-y-4" data-slot={`character-reader-${kind}`}>
            <h3 className="text-xl font-semibold">{titles[kind]}</h3>
            {fields.length ? (
              <ProfileFields fields={fields} reading={reading} />
            ) : (
              <p className="text-muted-foreground" role="status">
                {groups[kind].length ? m.people_biography_absent({}, o) : m.people_biography_unsupported({}, o)}
              </p>
            )}
          </section>
        );
      })}
      <CharacterProfileEntry id={read.subject.id} label={label.text} locale={locale} link={Link} />
    </div>
  );
}

export function CharacterOverview({
  source,
  viewer,
  load,
  release,
  ...reading
}: Omit<ProfileReading, 'release'> & {
  source: object;
  viewer: string | null;
  release?: PersonDefinitions | undefined;
  load?: PersonDefinitionsLoader;
}) {
  const lifetime = useSubjectCommunityReading({
    source,
    reader: viewer,
    descriptor: JSON.stringify([
      reading.public.subject.id,
      reading.public.subject.type,
      reading.public.subject.context,
      reading.locale,
      reading.reader ?? defaultReader,
    ]),
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [lifetime.key, lifetime.available]);
  return (
    <section
      className="min-w-0 space-y-4"
      data-slot="character-reader"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <h2 id="character-profile" ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        {m.showcase_people_character({}, { locale: reading.locale as never })}
      </h2>
      {lifetime.available ? (
        <ProfileDefinitions key={lifetime.key} locale={reading.locale} load={load} release={release}>
          {(definitions) => <CharacterReader {...reading} release={definitions} />}
        </ProfileDefinitions>
      ) : (
        <p role="status">{m.candidate_value_unavailable({}, { locale: reading.locale as never })}</p>
      )}
    </section>
  );
}
