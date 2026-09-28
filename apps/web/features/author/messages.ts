import { insert, plural } from 'native-i18n';

// Strings for `/authors/open-library/{id}`. English defines the contract; each
// locale's file under `messages/` overrides what it translates.
export const messages = {
  author: 'Author',
  unnamedAuthor: insert('Open Library author {{id}}', { id: String }),
  lifespan: insert('{{birth}}–{{death}}', { birth: String, death: String }),
  bornIn: insert('Born {{year}}', { year: String }),
  diedIn: insert('Died {{year}}', { year: String }),
  circa: insert('c. {{year}}', { year: String }),
  details: 'Details',
  born: 'Born',
  died: 'Died',
  fullName: 'Full name',

  totals: 'On REZICS',
  worksLabel: plural({ one: 'work', other: 'works' }),
  averageLabel: 'average rating',
  ratingsLabel: plural({ one: 'rating', other: 'ratings' }),
  readersLabel: plural({ one: 'reader', other: 'readers' }),
  noRatings: 'No ratings yet',

  worksHeading: insert('Works by {{name}}', { name: String }),
  coAuthors: 'With',
  serialOngoing: 'Ongoing serial',
  serialHiatus: 'Serial on hiatus',
  allWorks: 'All works',
  noWorks: 'No works on REZICS credit this author yet.',
  worksUnavailable: 'Couldn’t load works',

  readFree: 'Read and listen free',
  records: 'Catalogues and identifiers',
  project_gutenberg: 'Project Gutenberg',
  project_gutenbergNote: 'Free ebooks',
  librivox: 'LibriVox',
  librivoxNote: 'Free audiobooks',
  openLibrary: 'Open Library',
  wikidata: 'Wikidata',
  lc_naf: 'Library of Congress',
  viaf: 'VIAF',
  isni: 'ISNI',
  sourceNote: insert('Name and facts from Open Library’s catalogue, retrieved {{date}}.', { date: String }),
  sourceNoteUndated: 'Name and facts from Open Library’s catalogue.',
  viewRecord: 'View the record',

  unavailableTitle: 'Couldn’t load this author',
  unavailableBody: 'REZICS couldn’t reach this author page just now. Try again in a moment.',
  retry: 'Retry',
  movedTitle: 'This list changed while you were paging',
  movedBody: 'Start again from the first page to see it as it is now.',
  firstPage: 'First page',
  nextPage: 'Next page',
  backTo: insert('Back to {{name}}', { name: String }),

  description: insert('Works by {{name}} on REZICS: ratings, readers and where to start.', { name: String }),
  descriptionLifespan: insert('{{name}} ({{lifespan}}). Works on REZICS, with ratings and readers.',
    { name: String, lifespan: String }),
};

export type AuthorMessages = typeof messages;
