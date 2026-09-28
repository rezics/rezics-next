import { fictionWorks } from './official-plan.ts';
import { works } from './plan.ts';

// Scheme order is append order: a broader Concept appears before its children.
export const genreConcepts = {
  fiction: { en: 'Fiction', zh: '小说', broader: null },
  classics: { en: 'Classics', zh: '经典', broader: null },
  fantasy: { en: 'Fantasy', zh: '玄幻', broader: 'fiction' },
  xianxia: { en: 'Xianxia', zh: '仙侠', broader: 'fantasy' },
  urban: { en: 'Urban', zh: '都市', broader: 'fiction' },
  mystery: { en: 'Mystery', zh: '悬疑', broader: 'fiction' },
  romance: { en: 'Romance', zh: '言情', broader: 'fiction' },
  scienceFiction: { en: 'Science fiction', zh: '科幻', broader: 'fiction' },
  horror: { en: 'Horror', zh: '恐怖', broader: 'fiction' },
  gothic: { en: 'Gothic', zh: '哥特', broader: 'classics' },
  satire: { en: 'Satire', zh: '讽刺', broader: 'classics' },
  comingOfAge: { en: 'Coming of age', zh: '成长', broader: 'fiction' },
  historical: { en: 'Historical fiction', zh: '历史小说', broader: 'fiction' },
  adventure: { en: 'Adventure', zh: '冒险', broader: 'fiction' },
} as const;

export const freeConcepts = {
  bookshops: { en: 'Bookshops', zh: '书店' },
  letters: { en: 'Letters', zh: '书信' },
  family: { en: 'Family', zh: '家人' },
  friendship: { en: 'Friendship', zh: '友情' },
  folklore: { en: 'Folklore', zh: '民间传说' },
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
  ...works.filter((work) => work.type === 'book').map((work) => work.id),
  ...fictionWorks.map((work) => work.id),
];
