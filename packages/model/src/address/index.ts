export * from './sid.ts';
export * from './names.ts';
export * from './slug.ts';
export interface CanonicalAddress {
  prefix: '/@' | '/a/' | '/r/' | '/z/' | '/w/' | '/concepts/' | '/e/' | `/z/${string}/${string}/`;
  key: string;
  slugSource: string;
}
