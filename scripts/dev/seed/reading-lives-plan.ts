// What the demo people read, in public: their shelves with the dates they
// started and finished, and the five-star ratings they gave. The overlap is
// deliberate: "Readers also enjoyed" needs at least four public readers of a
// Work before it names co-readers, and it has them for Pride and Prejudice,
// 雨夜书店 and Lumen Lanterns. Main keeps each write's own time, so these
// reading dates are the seed's only time depth.

export type ShelfStatus = 'want-to-read' | 'reading' | 'read';
export interface ShelfEntry { work: string; status: ShelfStatus; startedOn: string | null; finishedOn: string | null }
/** A person's public library. A `null` rating withdraws one the base plan gave. */
export interface ReadingLife { person: string; shelf: readonly ShelfEntry[];
  ratings: Readonly<Record<string, number | null>> }

const read = (work: string, startedOn: string, finishedOn: string): ShelfEntry =>
  ({ work, status: 'read', startedOn, finishedOn });
const reading = (work: string, startedOn: string): ShelfEntry =>
  ({ work, status: 'reading', startedOn, finishedOn: null });
const want = (work: string): ShelfEntry => ({ work, status: 'want-to-read', startedOn: null, finishedOn: null });

/** Lin Mei writes 雨夜书店 and keeps her own shelves private; everyone here reads in public. */
export const readingLives: readonly ReadingLife[] = [
  { person: 'daniel', shelf: [reading('serial', '2026-09-05'), read('pride', '2026-06-02', '2026-06-20'),
    read('journey-west', '2026-04-10', '2026-05-28'), read('bun', '2026-08-01', '2026-08-03'),
    read('prompt', '2026-09-12', '2026-09-12'), read('lumen-fabric', '2026-09-14', '2026-09-20'),
    read('shop', '2026-08-10', '2026-08-30'), reading('jane-eyre', '2026-09-21'),
    want('red-chamber'), want('typescript')],
  ratings: { 'journey-west': 5, bun: 4, prompt: 4, shop: 4, 'red-chamber': null, alice: null } },
  { person: 'an', shelf: [reading('serial', '2026-08-20'), reading('taoist', '2026-09-01'),
    read('journey-west', '2026-03-01', '2026-04-15'), read('red-chamber', '2026-01-05', '2026-03-30'),
    read('light', '2026-07-10', '2026-07-25'), read('pride', '2026-05-02', '2026-05-16'),
    read('frankenstein', '2026-09-10', '2026-09-18'), read('mod-guide', '2026-09-19', '2026-09-19'),
    want('three-kingdoms')],
  ratings: { serial: 5, 'journey-west': 4, pride: 4, taoist: 4, frankenstein: 4, 'mod-guide': 5,
    alice: null, bun: null } },
  { person: 'sophie', shelf: [reading('serial', '2026-09-08'), reading('pride', '2026-09-25'),
    read('lumen-fabric', '2026-08-15', '2026-08-16'), read('tidy-fabric', '2026-08-16', '2026-08-16'),
    read('little-women', '2026-07-01', '2026-07-20'), read('red-chamber', '2025-12-01', '2026-02-10'),
    read('alice', '2026-03-10', '2026-03-14'), want('jane-eyre')],
  ratings: { serial: 4, pride: null, alice: 5, 'red-chamber': 4, 'tidy-fabric': 5, 'journey-west': null } },
  { person: 'jun', shelf: [reading('journey-west', '2026-09-20'), read('pride', '2026-02-01', '2026-02-20'),
    read('alice', '2025-11-02', '2025-11-06'), read('typescript', '2026-05-01', '2026-06-01'),
    read('club-prompt-v1', '2026-09-02', '2026-09-02'), read('reading-skill-v1', '2026-09-03', '2026-09-03'),
    read('prompt', '2026-09-04', '2026-09-04'), want('serial')],
  ratings: { pride: 5, alice: 4, serial: null, 'journey-west': null, 'club-prompt-v1': 4, 'reading-skill-v1': 4 } },
  { person: 'aria', shelf: [read('pride', '2026-03-03', '2026-03-20'), read('little-women', '2026-04-01', '2026-04-20'),
    read('jane-eyre', '2026-05-05', '2026-05-30'), read('frankenstein', '2026-06-10', '2026-06-18'),
    read('alice', '2026-01-04', '2026-01-08'), reading('secret-garden', '2026-09-15'), want('red-chamber')],
  ratings: { alice: 3, frankenstein: 4, serial: null, 'journey-west': null, 'red-chamber': null } },
  { person: 'leo', shelf: [reading('serial', '2026-09-02'), read('pride', '2026-08-01', '2026-08-25'),
    read('frankenstein', '2025-10-20', '2025-10-31'), read('lumen-fabric', '2026-09-01', '2026-09-01'),
    read('quiet-forge', '2026-09-10', '2026-09-11'), read('journey-west', '2026-02-02', '2026-04-01'),
    reading('red-chamber', '2026-09-18'), want('jane-eyre')],
  ratings: { pride: 4, 'journey-west': 4, 'red-chamber': null, 'lumen-fabric': 4, alice: null, bun: null } },
  { person: 'wei', shelf: [reading('serial', '2026-08-28'), reading('taoist', '2026-08-01'),
    reading('moonlight-story', '2026-09-10'), read('shop', '2026-07-01', '2026-08-15'),
    read('journey-west', '2025-11-01', '2026-01-20'), read('red-chamber', '2025-06-01', '2025-09-30'),
    read('light', '2026-06-05', '2026-06-20'), want('three-kingdoms')],
  ratings: { 'red-chamber': 5, light: 4, taoist: 4 } },
  { person: 'priya', shelf: [read('pride', '2026-09-01', '2026-09-14'), read('jane-eyre', '2026-01-10', '2026-02-01'),
    read('frankenstein', '2025-10-01', '2025-10-15'), read('little-women', '2025-12-10', '2025-12-28'),
    read('alice', '2026-03-01', '2026-03-04'), read('club-prompt-v1', '2026-09-14', '2026-09-14'),
    reading('sherlock', '2026-09-20'), want('secret-garden')],
  ratings: { 'jane-eyre': 5, alice: 4 } },
  { person: 'max', shelf: [read('lumen-fabric', '2026-07-20', '2026-07-20'), read('tidy-fabric', '2026-07-21', '2026-07-21'),
    read('weaver-forge', '2026-08-05', '2026-08-06'), read('quiet-forge', '2026-09-09', '2026-09-09'),
    read('shader-guide', '2026-06-01', '2026-06-02'), read('mod-guide', '2026-05-12', '2026-05-12'),
    read('recipe-skill-v1', '2026-09-20', '2026-09-20'), read('typescript', '2026-04-01', '2026-04-30'),
    want('frankenstein')],
  ratings: { 'tidy-fabric': 4, 'quiet-forge': 4, 'shader-guide': 4, typescript: 4 } },
  { person: 'hana', shelf: [reading('serial', '2026-09-06'), reading('pride', '2026-09-15'),
    reading('lumen-fabric', '2026-09-22'), read('shop', '2026-08-01', '2026-08-22'),
    read('glossary-prompt-v1', '2026-09-10', '2026-09-10'), read('alice', '2026-02-01', '2026-02-14'),
    want('frankenstein')],
  ratings: { 'lumen-fabric': 4, alice: 4 } },
  { person: 'nora', shelf: [reading('jane-eyre', '2026-09-18'), read('pride', '2025-12-01', '2025-12-20'),
    read('reading-skill-v1', '2026-08-20', '2026-08-20'), read('club-prompt-v1', '2026-08-21', '2026-08-21'),
    read('prompt', '2026-08-22', '2026-08-22'), read('shader-guide', '2026-09-05', '2026-09-06'),
    read('lumen-fabric', '2026-09-06', '2026-09-06'), read('frankenstein', '2026-01-15', '2026-01-25')],
  ratings: { pride: 4, 'club-prompt-v1': 4, prompt: 5, 'lumen-fabric': 5 } },
];

/** The Works whose "Readers also enjoyed" must be built from co-readers. */
export const coReaderWorks = ['pride', 'serial', 'lumen-fabric'] as const;
