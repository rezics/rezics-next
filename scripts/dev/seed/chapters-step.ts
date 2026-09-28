import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import type { SeedApi } from './api.ts';
import { arrangeBook, readBookOutline } from './book-outline.ts';
import { prepareHomeV2Chapters, publishChapter, type SeedGrant } from './home-v2.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { seedChapterProgress } from './progress.ts';
import type { SeedState } from './state.ts';

const short = (id: string) => id.slice(-36);
const LANGUAGE = 'zh-Hans';

/** 雨夜书店's extra (番外): a side story after the volumes, unnumbered. */
const extra = { title: '番外 书店的猫', body: '书店里有一只橘猫，只在下雨的晚上出现。林梅给它留了一只旧茶碗，碗底写着一个日期。' };

/**
 * 雨夜书店 as its author keeps it: two volumes (第一卷 雨夜 with the first two
 * chapters, 第二卷 末班车 with the third) and its extras (番外) with one
 * published side story. Every step replays: groups by title, chapters by Work,
 * and the side story by the identity Studio's chapter command derives.
 */
export async function arrangeSerial(api: SeedApi, author: { token: string; actingSubject: string },
  serial: { work: string; structure: string; occurrences: readonly string[] }, grant: SeedGrant) {
  const outline = await readBookOutline(api, serial.work, LANGUAGE, author);
  const works = serial.occurrences.map(occurrence => outline.items.find(item => item.occurrence === occurrence)?.target);
  if (works.some(work => !work)) throw new Error('Serial chapters are not all readable to their author');
  const key = seedKey('home-chapter-create', 'serial:extra:cat');
  const side = derivedId(`${serial.work}\0${author.actingSubject}\0${key}\0chapter\0work`);
  const groups = (extras: string[]) => [
    { title: '第一卷 雨夜', division: 'volume' as const, chapters: [works[0]!, works[1]!] },
    { title: '第二卷 末班车', division: 'volume' as const, chapters: [works[2]!] },
    { title: '番外', division: 'extras' as const, chapters: extras }];
  await arrangeBook(api, { work: serial.work, structure: serial.structure, language: LANGUAGE, reader: author,
    groups: groups([]), key: 'serial' });
  const arranged = await readBookOutline(api, serial.work, LANGUAGE, author);
  if (!arranged.items.some(item => item.target === side)) {
    const extras = arranged.items.find(item => item.role === 'group' && item.label?.value === '番外')!;
    const made = await api.post<{ work: string }>(`/v1/works/${short(serial.work)}/chapters`, {
      profile: 'book-chapter-create-v1', title: extra.title, language: LANGUAGE, direction: 'ltr',
      parent: extras.occurrence, position: 'last', expectedCompositionHead: arranged.head,
      actingSubject: author.actingSubject }, author.token, key);
    if (made.work !== side) throw new Error('The serial’s side story has another identity');
  }
  const seed = `${serial.work}\0${author.actingSubject}\0${key}\0chapter`;
  await publishChapter(api, { id: 'serial', ...author }, 'serial:extra:cat', side,
    `urn:rezics:variant:${derivedId(`${seed}\0variant`).slice(-36)}`, `${extra.title}\n${extra.body}`, grant);
  return arrangeBook(api, { work: serial.work, structure: serial.structure, language: LANGUAGE, reader: author,
    groups: groups([side]), key: 'serial' });
}

export async function seedChapters(state: SeedState) {
  const operator = state.operatorInput;
  if (!operator) return;
  const owner = state.sessions[0]!;
  const grant: SeedGrant = grants => grantHomeSeedAuthority(operator, grants);
  const serial = await state.optional('Home chapter Content', () => prepareHomeV2Chapters(state.api, owner,
    state.created, grant));
  if (!serial) return;
  const work = state.created.get('serial')!.work;
  await state.optional('Serial volumes and extras', () => arrangeSerial(state.api, owner,
    { work, ...serial }, grant));
  // Readers keep their places in the three story chapters; the side story is theirs to find.
  await state.optional('Chapter reading progress', () => seedChapterProgress(state.api, state.sessions, serial));
}
