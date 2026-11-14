import { fromMarkdown, serializeDocument } from '@rezics/document';
import type { HostedCatalogueApi, HostedOccurrence, HostedResolution, HostedRevision } from './native-api';
import { readHostedBook } from './native-mapper';
import type {
  BookChapterAddress,
  BookContentsAddress,
  BookReadResult,
  BookSourceObservation,
  HostedBookSource,
} from './source';

/** Illustrative native-format responses, never a production transport or native acceptance evidence. */
export const illustrativeBookIds = {
  catalogue: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  structure: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  release: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  part: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  nested: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  first: '0192f3a0-6c1e-7b2a-9d4e-000000000006',
  reused: '0192f3a0-6c1e-7b2a-9d4e-000000000007',
  post: '0192f3a0-6c1e-7b2a-9d4e-000000000008',
  revision: '0192f3a0-6c1e-7b2a-9d4e-000000000009',
  thread: '0192f3a0-6c1e-7b2a-9d4e-00000000000a',
  author: '0192f3a0-6c1e-7b2a-9d4e-00000000000b',
  currentRelease: '0192f3a0-6c1e-7b2a-9d4e-00000000000c',
  currentStructure: '0192f3a0-6c1e-7b2a-9d4e-00000000000d',
  secondPart: '0192f3a0-6c1e-7b2a-9d4e-00000000000e',
  harbor: '0192f3a0-6c1e-7b2a-9d4e-00000000000f',
  night: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  harborPost: '0192f3a0-6c1e-7b2a-9d4e-000000000011',
  harborRevision: '0192f3a0-6c1e-7b2a-9d4e-000000000012',
  nightPost: '0192f3a0-6c1e-7b2a-9d4e-000000000013',
  nightRevision: '0192f3a0-6c1e-7b2a-9d4e-000000000014',
} as const;
export type IllustrativeBookState = 'nested' | 'sparse' | 'failed-page' | 'moved' | 'unavailable-navigation';
export const illustrativeBookCursor = 'illustrative:opaque/+page=2';
export const illustrativePublication = {
  id: illustrativeBookIds.catalogue,
  structureRevisionId: illustrativeBookIds.structure,
  releaseRevisionId: illustrativeBookIds.release,
};

const dawn = [
  '## At the observatory / 観測所',
  'The keeper opened the eastern shutters. 星を読む。 The same exact text is placed twice in this publication.',
  'A concealed detail: >!the lamp was already burning!<. The existing document renderer owns this disclosure.',
  '## The path home',
  'Read the [field notes](https://example.org/field-notes), then return to the selected occurrence in Contents.',
];
const dawnReview = [
  'The narrow stair still held the cool air of the night. Above it, the dome turned by a finger’s width, and the first pale line of the coast appeared between the shutters. Every morning the keeper measured that line before looking at the clock.',
  'On the desk lay two notebooks. One recorded observations: wind, cloud, the angle of a bright planet above the water. The other recorded questions. She had learned to keep the books apart so that a good question would not become a fact by being copied often enough.',
  '### A page in the second notebook',
  '> If a light returns each morning, do we recognize the light, or the place where we have been waiting?',
  '夜明けの光は、昨日と同じ場所から差し込んだ。それでも、机の上に落ちる影は少し違っていた。彼女はその違いを測る前に、しばらく窓の外を見ていた。',
  'The harbor bell sounded twice. A boat that had spent the night beyond the headland entered the channel, its wake drawing a bright seam through the dark water. From the observatory it looked as though the sea were being opened with a needle.',
  '### Preparing the instruments',
  '- Open the eastern shutter before the western one.\n- Let the glass settle to the air temperature.\n- Write the time of the first clear observation.\n- Leave the second notebook open for anything that does not fit the first.',
  'She crossed out the previous day’s estimate, leaving the original legible. The correction mattered, but so did the route by which she had arrived at it. A notebook without corrections would have been a beautiful and useless thing.',
  '## Before leaving',
  'By the time the town began to wake, the measurements were finished. She left a clean cup beside the instruments for the afternoon keeper, closed only the lower shutters, and carried the book of questions down the stair.',
];
const harborReview = [
  '## The harbor at low water / 退潮後的港口',
  'By noon the mud below the quay had emerged in ridges. Ropes hung slack from the boats, and each hull rested at a slightly different angle. The keeper sat on the lowest dry step and opened the notebook she had brought from the observatory.',
  'The boatbuilder had promised to explain the marks on the sea wall. They were too regular to be accidental and too uneven to be a ruler. Some had dates beside them. Others carried only a small drawing of a door.',
  '### Reading the marks',
  '“That one was the winter the water reached the bakery,” he said. “And that one was the morning we moved the school uphill.” He traced the marks without touching them, as if they were lines in a borrowed book.',
  '港口的刻痕並不是整齊的年表。有些記錄潮水，有些記錄人們做出的決定。她在筆記本上留了一整頁，沒有急著替它們編號。',
  '| Mark | What the town remembered |\n| --- | --- |\n| A narrow line | The winter tide |\n| A small door | The bakery moved upstairs |\n| Two circles | The boats returned together |',
  '## A different kind of instrument',
  'At the observatory, a mark meant a measurement. Here, a mark might mean a warning, an absence, or a promise that someone had kept. Neither system was complete. She drew the wall in the notebook and left room beside every line.',
  'When the tide began to turn, the lowest mark disappeared first. The boatbuilder went back to his work. She stayed until the water reached the step below her feet, then walked home by the longer road.',
];
const nightReview = [
  '## Returning after dark / 夜の帰り道',
  'The path to the observatory was familiar in daylight. After dark, its distances changed. The bend beside the orchard seemed farther away, and the small bridge appeared before she expected it. She stopped there to let her eyes adjust.',
  'There was no moon. Above the orchard, the stars looked close together, as if the sky had folded along a seam too fine to see. She had spent years learning their names and still found it easier, on some nights, to look without naming them.',
  '### Notes carried between languages',
  '「同じ道を戻っているのに、同じ景色には戻れない。」そう書いてから、彼女は次の行を空けた。言葉を急いで置くと、まだ見えていないものまで決めてしまう気がした。',
  '바람이 잦아들자 나뭇잎 소리 사이로 항구의 종이 들렸다. 그녀는 시간을 적는 대신 잠시 걸음을 멈췄다. 오늘의 관측은 아직 끝나지 않았다.',
  '她在橋上回頭，看見港口最後一扇亮著的窗。光線沒有告訴她距離，卻讓她知道有人還醒著。這也是一種座標，只是不能填進早晨的表格。',
  'The notebook contained a short calculation from the morning. It was a reminder of how little a number could say on its own:',
  '```typescript\nconst observation = {\n  place: "eastern window",\n  light: "first clear line above the harbor",\n  uncertainty: "cloud at the horizon",\n};\n```',
  '## The window left open',
  'At the top of the stair, the afternoon keeper had left the eastern shutter open. A cup stood beside the instruments. Under it was a note: “The horizon was clear for eleven minutes. I thought you would want to know.”',
  'She put the note between the two notebooks. In the morning, she would decide where it belonged. For now she turned the lamp low, sat beside the open window, and watched the place where the sea met the sky.',
];

async function illustrativeBody(markdown: readonly string[], postId: string, revisionId: string) {
  const document = fromMarkdown(markdown.join('\n\n'), 'blocks');
  const bytes = new TextEncoder().encode(serializeDocument(document));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const exactDocument: NonNullable<HostedResolution['document']> = {
    encoding: 'base64',
    canonicalBytes: btoa(String.fromCharCode(...bytes)),
    sha256,
    authorId: illustrativeBookIds.author,
    licence: 'CC-BY-4.0',
  };
  return { exact: { postId, revisionId, sha256 }, exactDocument };
}

/** Review content is opt-in so existing regression operands and small fixtures stay unchanged. */
export function createIllustrativeHostedBook(state: IllustrativeBookState = 'nested', review = false) {
  const ids = illustrativeBookIds;
  const body = illustrativeBody(review ? [...dawn, ...dawnReview] : dawn, ids.post, ids.revision);
  const release: HostedRevision = {
    catalogueId: ids.catalogue,
    revisionId: ids.release,
    kind: 'publication',
    sourceRevisionId: ids.structure,
  };
  const current: HostedRevision =
    state === 'moved'
      ? { ...release, revisionId: ids.currentRelease, sourceRevisionId: ids.currentStructure }
      : release;
  let observation: BookSourceObservation = { state: 'current' };
  const listeners = new Set<() => void>();
  let failed = false;
  const part: HostedOccurrence = {
    occurrenceId: ids.part,
    parentId: null,
    position: 0,
    kind: 'part',
    availability: 'available',
    title: 'Part I · The journey',
    target: null,
  };
  const nested: HostedOccurrence = {
    occurrenceId: ids.nested,
    parentId: ids.part,
    position: 0,
    kind: 'part',
    availability: 'available',
    title: 'The observatory',
    target: null,
  };
  const secondPart: HostedOccurrence = {
    ...part,
    occurrenceId: ids.secondPart,
    position: 1,
    title: 'Part II · The coast, the town, and the long way home / 海岸、町、そして帰り道',
  };
  const ready = body.then(async ({ exact, exactDocument }) => {
    const first: HostedOccurrence = {
      occurrenceId: ids.first,
      parentId: ids.nested,
      position: 0,
      kind: 'chapter',
      availability: 'available',
      title: 'Dawn / 黎明',
      target: { ...exact, threadId: ids.thread },
    };
    const reused: HostedOccurrence = { ...first, occurrenceId: ids.reused, position: 1, title: 'Dawn, an echo / 再読' };
    const [harborBody, nightBody] = review
      ? await Promise.all([
          illustrativeBody(harborReview, ids.harborPost, ids.harborRevision),
          illustrativeBody(nightReview, ids.nightPost, ids.nightRevision),
        ])
      : [null, null];
    const harbor: HostedOccurrence = {
      ...first,
      occurrenceId: ids.harbor,
      parentId: ids.secondPart,
      title: 'The harbor at low water / 退潮後的港口',
      target: { ...(harborBody?.exact ?? exact), threadId: ids.thread },
    };
    const night: HostedOccurrence = {
      ...harbor,
      occurrenceId: ids.night,
      position: 1,
      title:
        'The long way home, beneath a sky without a moon: notes carried between languages / 月のない空の下、いくつもの言葉を携えて帰る道 / 여러 언어로 남긴 밤의 기록',
      target: { ...(nightBody?.exact ?? exact), threadId: ids.thread },
    };
    const chapters = review ? [first, reused, harbor, night] : [first, reused];
    const occurrences = review ? [part, nested, secondPart, ...chapters] : [part, nested, ...chapters];
    const previous = new Map(chapters.slice(1).map((row, index) => [row.occurrenceId, chapters[index]!]));
    const next = new Map(chapters.slice(0, -1).map((row, index) => [row.occurrenceId, chapters[index + 1]!]));
    const documents = new Map<string, NonNullable<HostedResolution['document']>>([
      [ids.first, exactDocument],
      [ids.reused, exactDocument],
      [ids.harbor, harborBody?.exactDocument ?? exactDocument],
      [ids.night, nightBody?.exactDocument ?? exactDocument],
    ]);
    const api: HostedCatalogueApi = {
      async catalogue(_id, query) {
        return { state: 'ready', value: query.revisionId === ids.release ? release : current };
      },
      async children(_id, query) {
        if (query.cursor === illustrativeBookCursor && state === 'failed-page' && !failed) {
          failed = true;
          return { state: 'unavailable' };
        }
        const items =
          query.cursor === illustrativeBookCursor
            ? [reused]
            : query.parentId === ids.nested
              ? state === 'sparse' || state === 'failed-page'
                ? []
                : [first, reused]
              : query.parentId === ids.part
                ? [nested]
                : query.parentId === ids.secondPart && review
                  ? [harbor, night]
                  : review
                    ? [part, secondPart]
                    : [part];
        const nextCursor =
          query.parentId === ids.nested && !query.cursor && (state === 'sparse' || state === 'failed-page')
            ? illustrativeBookCursor
            : null;
        return { state: 'ready', value: { ...release, items, nextCursor } };
      },
      async metadata(_id, occurrenceId, query) {
        const row = occurrences.find((item) => item.occurrenceId === occurrenceId);
        if (!row) return { state: 'not-found' };
        const revision = query.revisionId === ids.release ? release : current;
        const occurrence =
          state === 'moved' && revision === current && occurrenceId === ids.first
            ? { ...first, parentId: ids.part, position: 1 }
            : row;
        return { state: 'ready', value: { ...revision, occurrence } };
      },
      async resolve(id, occurrenceId, query) {
        const metadata = await api.metadata(id, occurrenceId, query);
        if (metadata.state !== 'ready') return metadata;
        const row = metadata.value.occurrence;
        return {
          state: 'ready',
          value: {
            ...metadata.value,
            document: row.availability === 'available' && row.kind === 'chapter' ? documents.get(occurrenceId)! : null,
          },
        };
      },
      async navigate(_id, occurrenceId, query) {
        if (state === 'unavailable-navigation' && query.direction === 'next') return { state: 'unavailable' };
        const neighbour = (query.direction === 'next' ? next : previous).get(occurrenceId);
        return { state: 'ready', value: { ...release, items: neighbour ? [neighbour] : [], nextCursor: null } };
      },
    };
    return { api, first, reused, exactDocument, exact, night, nightExact: nightBody?.exact ?? exact };
  });
  const source: HostedBookSource = {
    getSnapshot: () => observation,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async read(request, signal): Promise<BookReadResult> {
      const ownObservation = observation;
      const { api } = await ready;
      return readHostedBook(
        api,
        request,
        'The keeper of the eastern sky',
        signal,
        () => observation === ownObservation && observation.state === 'current',
      );
    },
  };
  const contents = (parentOccurrenceId: string | null = null, cursor: string | null = null): BookContentsAddress => ({
    kind: 'contents',
    publication: illustrativePublication,
    parentOccurrenceId,
    cursor,
    selection: null,
  });
  return {
    source,
    ready,
    contents,
    async chapter(reused = false): Promise<BookChapterAddress> {
      return {
        kind: 'chapter',
        publication: illustrativePublication,
        selection: { occurrenceId: reused ? ids.reused : ids.first, body: (await body).exact },
      };
    },
    async nightChapter(): Promise<BookChapterAddress> {
      const { nightExact } = await ready;
      return {
        kind: 'chapter',
        publication: illustrativePublication,
        selection: { occurrenceId: ids.night, body: nightExact },
      };
    },
    replace(state: BookSourceObservation['state'] = 'current') {
      observation = { state };
      for (const listener of [...listeners]) listener();
    },
  };
}
