import { pickText } from '@rezics/composition';
import { useContext, useLayoutEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';
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
import { PeopleFacts } from '../../catalogue/people-facts/visit';
import { SuppliedNames } from './names';
import { CharacterPublicReading, type CharacterAssociations } from '../../catalogue/character-public-reading/view';
import { CharacterReadingBinding } from '../character-reading-binding';
import { OverviewContext } from '../overview-context';
import { ProfileDetails } from '../shared';

/** Supplied facts and the existing bounded associations share one native fact visit. */
export function CharacterReader(input: ProfileReading & { associations?: CharacterAssociations }) {
  const reading = { ...input, documents: input.documents ?? input.public.documents };
  const groups = characterGroups(reading.release);
  const documents = (reading.release.types[reading.public.subject.type]?.properties ?? []).filter(
    (id) => reading.release.properties[id]?.datatype === 'document',
  );
  const fields = [...new Set([...Object.values(groups).flat(), ...documents])];
  const label = pickText(reading.public.subject.labels, reading.locale);
  const Link = reading.link ?? PlainLink;
  const o = { locale: reading.locale as never };
  return (
    <CharacterReadingBinding>
      <PeopleFacts reading={reading} fields={fields}>
        <div className="min-w-0 space-y-8 [overflow-wrap:anywhere]" data-slot="character-reader-facts">
          <CharacterFacts reading={reading} kind="identity" fields={[...new Set([...documents, ...groups.identity])]} />
          <CharacterFacts reading={reading} kind="traits" fields={groups.traits} />
          <nav className="flex min-w-0 flex-wrap gap-x-5 gap-y-2" data-slot="character-reader-destinations">
            <CharacterRelationshipsEntry
              id={reading.public.subject.id}
              label={label.text}
              locale={reading.locale}
              link={Link}
            />
            <a className="inline-flex min-h-11 items-center underline" href="#connections">
              {m.character_identity_visit_open({}, o)}
            </a>
          </nav>
          {input.associations && <CharacterPublicReading {...input.associations} />}
          <ProfileDetails locale={reading.locale}>
            <CharacterFacts reading={reading} kind="measurements" fields={groups.measurements} />
            <CharacterFacts reading={reading} kind="identifiers" fields={groups.identifiers} />
            <SuppliedNames reading={reading} />
            <CharacterProfileEntry
              id={reading.public.subject.id}
              label={label.text}
              locale={reading.locale}
              link={Link}
            />
          </ProfileDetails>
        </div>
      </PeopleFacts>
    </CharacterReadingBinding>
  );
}

function CharacterFacts({
  reading,
  kind,
  fields,
}: {
  reading: ProfileReading;
  kind: keyof ReturnType<typeof characterGroups>;
  fields: string[];
}) {
  if (reading.public.subject.type !== 'wd:Q95074') return null;
  const o = { locale: reading.locale as never };
  const titles = {
    identity: m.character_identity({}, o),
    traits: m.character_traits({}, o),
    measurements: m.character_measurements({}, o),
    identifiers: m.character_identifiers({}, o),
  };
  const selected = profileFields(reading.release, reading.public, fields, reading.locale);
  // Sparse profiles keep one useful identity state; optional empty groups stay in their native editors.
  if (kind !== 'identity' && !selected.some((field) => field.facts.length)) return null;
  return (
    <section className="min-w-0 space-y-4" data-slot={`character-reader-${kind}`}>
      <h3 className="text-xl font-semibold tracking-tight">{titles[kind]}</h3>
      {selected.length ? (
        <ProfileFields fields={selected} reading={reading} />
      ) : (
        <p className="text-muted-foreground" role="status">
          {fields.length ? m.people_biography_absent({}, o) : m.people_biography_unsupported({}, o)}
        </p>
      )}
    </section>
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
  const overview = useContext(OverviewContext);
  const lifetime = useSubjectCommunityReading({
    source,
    reader: viewer,
    spoiler: reading.reader?.spoilerLevel,
    suitability: reading.reader?.suitability,
    descriptor: JSON.stringify([
      reading.public.subject.id,
      reading.public.subject.type,
      reading.public.subject.context,
      reading.locale,
      overview?.realm,
      overview?.context,
      overview?.releaseDigest,
      release,
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
          {(definitions) => <CharacterReader {...reading} release={definitions} associations={{ source, viewer }} />}
        </ProfileDefinitions>
      ) : (
        <p role="status">{m.candidate_value_unavailable({}, { locale: reading.locale as never })}</p>
      )}
    </section>
  );
}
