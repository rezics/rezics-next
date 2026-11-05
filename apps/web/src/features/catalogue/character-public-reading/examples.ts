import type { ConnectionRead } from '../../pages/subject-connections-window';
import type { ConnectionStream, ConnectionVisit } from '../../pages/subject-connections';
import { connectionStreams } from '../../pages/subject-connections';
import type { OverviewValue } from '../../pages/overview';
import { PlainLink } from '../../pages/shared';
import { defaultReader } from '../../../subject/reader';
import { peopleFactsExample } from '../people-facts/examples';
import type { GuideRelease } from '../definition-guide';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snak = (property: string, content: unknown, data_type = 'wikibase-item') => ({
  property: { id: property, data_type },
  value: { type: 'value', content },
});
const summary = (key: string, label: string, type = 'schema:Person') => ({
  id: key,
  type,
  types: [type],
  label: { value: label, language: 'ja' },
  creativeWork: type === 'schema:TVSeries',
  cover: null,
});

/** Illustrative native-shaped inputs; the seeded database remains independent publication evidence. */
export function characterPublicExample(
  locale = 'en',
  state: 'current' | 'spoiler' | 'stale' | 'unavailable' = 'current',
) {
  const profile = peopleFactsExample(true);
  profile.read.subject.statements = {};
  profile.read.subject.labels = { ja: '牧瀬紅莉栖', 'zh-Hant': '牧瀨紅莉栖', en: 'Kurisu Makise' };
  const character = profile.read.subject.id;
  const streams = connectionStreams(profile.release as GuideRelease, 'wd:Q95074', character, locale).filter(
    (stream) => stream.property === 'schema:character' || stream.qualifier === 'wdt:P453',
  );
  const row = (stream: ConnectionStream, second: boolean) => ({
    subject: id(2),
    statement: id(second ? 11 : stream.group === 'characters' ? 10 : 20),
    property: stream.property,
    summary: summary(id(2), second ? 'STEINS;GATE 0' : 'STEINS;GATE', 'schema:TVSeries'),
    assertion: {
      ...snak(stream.property, stream.group === 'characters' ? character : id(4)),
      id: id(second ? 11 : stream.group === 'characters' ? 10 : 20),
      rank: 'normal',
      qualifiers: [
        ...(stream.group === 'credits' ? [snak('wdt:P453', character)] : []),
        snak('wdt:P3831', id(3)),
        snak('wdt:P1932', '牧瀬紅莉栖', 'string'),
        ...(state === 'spoiler' ? [snak('rezics:spoilerLevel', { amount: '1', unit: '1' }, 'quantity')] : []),
      ],
      references: [{ parts: [snak('schema:url', 'https://bgm.tv/subject/10380', 'url')] }],
      rezics: { release: profile.read.subject.release, revision: 1 },
    },
    related: {
      [character]: summary(character, '牧瀬紅莉栖', 'wd:Q95074'),
      [id(3)]: summary(id(3), 'Main role', 'skos:Concept'),
      [id(4)]: summary(id(4), '今井麻美'),
    },
  });
  const visit = (second = false): Extract<ConnectionVisit, { ok: true }> => ({
    ok: true,
    id: character,
    release: profile.read.subject.release,
    streams,
    sections: Object.fromEntries(
      streams.map((stream) => [
        stream.group,
        {
          stream,
          reading: (second ? 'b' : 'a').repeat(64),
          section:
            state === 'unavailable'
              ? { ok: false, status: 403 }
              : {
                  ok: true,
                  read: { kind: 'links', id: character, property: stream.property, limit: 12 },
                  body: {
                    links: [row(stream, second)],
                    next: second ? null : 'native-next',
                    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: state !== 'stale' },
                    partial: state === 'stale',
                  },
                },
        },
      ]),
    ),
  });
  const read: ConnectionRead = async (address) => {
    const cursorOf = (group: string) => address.selection?.[group as 'characters' | 'credits']?.cursor;
    const result = visit(
      Boolean(address.only ? cursorOf(address.only) : cursorOf('characters') || cursorOf('credits')),
    );
    const apply = (group: 'characters' | 'credits') => {
      const section = result.sections[group];
      const cursor = cursorOf(group);
      if (section?.section.ok)
        section.section.read = {
          kind: 'links',
          id: character,
          property: section.stream.property,
          limit: 12,
          ...(cursor ? { cursor } : {}),
        };
    };
    if (address.only === 'characters' || address.only === 'credits') {
      apply(address.only);
      result.sections = { [address.only]: result.sections[address.only]! };
    } else {
      apply('characters');
      apply('credits');
    }
    return result;
  };
  const value = {
    subject: character,
    subjectLabel: 'Kurisu Makise',
    locale,
    link: PlainLink,
    reader: defaultReader,
    labels: { spoilerHide: 'Hide' },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    relations: {},
    sections: new Map(),
    relationNodes: [],
    releaseDigest: profile.read.subject.release,
  } as unknown as OverviewValue;
  return { profile, value, read, visit, streams };
}
