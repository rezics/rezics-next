// SPDX-License-Identifier: Apache-2.0
export const documentVersion = 'rezics-document-v1' as const;
export type DocumentProfile = 'text' | 'blocks';
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** ProseMirror's JSON shape. Node and mark names are fixed by the profile. */
export interface DocumentMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

export interface DocumentNode {
  type: string;
  attrs?: Record<string, JsonValue>;
  content?: DocumentNode[];
  text?: string;
  marks?: DocumentMark[];
}

export interface DocumentSnapshot {
  version: typeof documentVersion;
  profile: DocumentProfile;
  doc: DocumentNode;
}

export interface DocumentParagraph {
  id: string;
  text: string;
}
