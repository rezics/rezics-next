export declare const SUBJECT_TYPE: 'schema:Book';
export type DataType = 'wikibase-item' | 'external-id' | 'quantity' | 'url';
export type PropertyDefinition = {
    id: string;
    dataType: DataType;
    labels: {
        en: string;
        ja: string;
    };
};
export declare const BOOK_PROPERTIES: PropertyDefinition[];
export declare function propertyOf(id: string): PropertyDefinition | undefined;
