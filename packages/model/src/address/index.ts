export * from './sid.ts';
export * from './aliases.ts';
export * from './suffix.ts';
export interface CanonicalAddress {
  prefix:
    | '/@'
    | '/a/'
    | '/r/'
    | '/z/'
    | '/w/'
    | '/concepts/'
    | '/e/'
    | `/z/${string}/${string}/`
    | `/w/${string}/`
    | `/w/${string}/read/`;
  key: string;
  suffixSource: string;
}
