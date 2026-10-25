export const SUBJECT_TYPE = 'schema:Book' as const;

export type DataType = 'wikibase-item' | 'external-id' | 'quantity' | 'url' | 'document' | 'media';

export type PropertyDefinition = {
  id: string;
  dataType: DataType;
  labels: { en: string; ja: string };
};

export const BOOK_PROPERTIES: PropertyDefinition[] = [
  { id: 'schema:abstract', dataType: 'document', labels: { en: 'abstract', ja: 'アブストラクト' } },
  { id: 'schema:image', dataType: 'media', labels: { en: 'image', ja: '画像' } },
  { id: 'schema:author', dataType: 'wikibase-item', labels: { en: 'author', ja: '著者' } },
  { id: 'schema:genre', dataType: 'wikibase-item', labels: { en: 'genre', ja: 'ジャンル' } },
  { id: 'schema:isbn', dataType: 'external-id', labels: { en: 'ISBN', ja: 'ISBN' } },
  { id: 'schema:numberOfPages', dataType: 'quantity', labels: { en: 'number of pages', ja: 'ページ数' } },
  { id: 'schema:url', dataType: 'url', labels: { en: 'URL', ja: 'URL' } },
];

export function propertyOf(id: string): PropertyDefinition | undefined {
  return BOOK_PROPERTIES.find((property) => property.id === id);
}
