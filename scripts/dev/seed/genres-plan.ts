import { fictionWorks } from './official-plan.ts';
import { works } from './plan.ts';

// A modest vocabulary for the actual books in the demo. Each value is a
// Concept; the legacy proposition API currently gives each its own scheme.
export const genreConcepts = {
  classics: 'Classics', fantasy: 'Fantasy · 玄幻', xianxia: 'Xianxia · 仙侠',
  urban: 'Urban · 都市', mystery: 'Mystery · 悬疑', romance: 'Romance · 言情',
  scienceFiction: 'Science fiction · 科幻', horror: 'Horror · 恐怖',
  gothic: 'Gothic', satire: 'Satire', comingOfAge: 'Coming of age',
  historical: 'Historical fiction', adventure: 'Adventure',
} as const;

export const freeConcepts = {
  bookshops: 'Bookshops · 书店', letters: 'Letters · 书信',
  family: 'Family · 家人', friendship: 'Friendship · 友情',
  folklore: 'Folklore · 民间传说',
} as const;

export type BookConcept = keyof typeof genreConcepts | keyof typeof freeConcepts;

/** Every demo Book, including the serials the Fiction Zone creates later. */
export const bookConcepts: Readonly<Record<string, readonly BookConcept[]>> = {
  pride: ['classics', 'romance', 'satire'],
  alice: ['classics', 'fantasy', 'comingOfAge'],
  sherlock: ['classics', 'mystery', 'adventure'],
  'jane-eyre': ['classics', 'gothic', 'romance'],
  frankenstein: ['classics', 'gothic', 'scienceFiction', 'horror'],
  'little-women': ['classics', 'comingOfAge', 'family'],
  'secret-garden': ['classics', 'comingOfAge', 'friendship'],
  'journey-west': ['classics', 'fantasy', 'adventure'],
  'red-chamber': ['classics', 'romance', 'family'],
  'strange-tales': ['classics', 'horror', 'folklore'],
  'three-kingdoms': ['classics', 'historical', 'adventure'],
  'water-margin': ['classics', 'historical', 'friendship'],
  serial: ['urban', 'mystery', 'bookshops', 'letters'],
  'moonlight-story': ['urban', 'mystery', 'bookshops'],
  inn: ['scienceFiction', 'mystery', 'urban'],
  'sword-tea': ['historical', 'adventure', 'friendship'],
  cat: ['urban', 'mystery', 'fantasy'],
  moon: ['xianxia', 'fantasy', 'comingOfAge'],
  shop: ['fantasy', 'bookshops', 'adventure'],
  light: ['mystery', 'romance', 'family'],
  crane: ['romance', 'fantasy', 'letters'],
  chef: ['urban', 'fantasy', 'family'],
  taoist: ['xianxia', 'mystery', 'folklore'],
  metro: ['urban', 'horror', 'mystery'],
  heron: ['family', 'comingOfAge', 'historical'],
  candy: ['mystery', 'urban', 'friendship'],
  bell: ['scienceFiction', 'mystery', 'horror'],
  tides: ['fantasy', 'mystery', 'adventure'],
  salt: ['romance', 'letters', 'urban'],
  ferry: ['fantasy', 'mystery', 'bookshops'],
};

export const seededBookIds = [
  ...works.filter(work => work.type === 'book').map(work => work.id),
  ...fictionWorks.map(work => work.id),
];
