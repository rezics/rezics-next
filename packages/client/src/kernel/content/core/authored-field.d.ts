import { type ContentAuthoredFieldInput } from '../contract/index.ts';
export declare function admitAuthoredLanguage(language: unknown): language is string;
export declare function admitAuthoredRevision(revision: unknown): revision is number;
export declare function authoredFieldContainsMedia(document: unknown): boolean;
export declare function admitAuthoredFieldInput(input: ContentAuthoredFieldInput): string | null;
