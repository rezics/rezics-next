export type EditionSubjectIdentity =
  | { id: string; kind: 'available'; label: { value: string; language: string } }
  | { id: string; kind: 'missing' | 'withheld'; label: null };

export type EditionSourceRecognition = {
  postId: string;
  revisionId: string;
  sha256: string;
  revisionCreatedAt: string | null;
  subjects: EditionSubjectIdentity[];
};

export type EditionMetadata = {
  editionId: string;
  editionRevision: string;
  identity?: { subject: EditionSubjectIdentity; revisionCreatedAt: string | null };
  state: 'draft' | 'published' | 'withdrawn';
  targetSubjectId: string;
  creatorAccountId: string;
  revisionId: string;
  sha256: string;
  licence: string;
};

export type EditionRevision = {
  editionId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  body: EditionDocumentSnapshot;
};

type EditionJsonValue = null | boolean | number | string | EditionJsonValue[] | { [key: string]: EditionJsonValue };
type EditionDocumentMark = { type: string; attrs?: Record<string, EditionJsonValue> };
type EditionDocumentNode = {
  type: string;
  attrs?: Record<string, EditionJsonValue>;
  content?: EditionDocumentNode[];
  text?: string;
  marks?: EditionDocumentMark[];
};
export type EditionDocumentSnapshot = {
  version: 'rezics-document-v1';
  profile: 'text' | 'blocks';
  doc: EditionDocumentNode;
};

export type EditionRead<T> =
  | { state: 'available'; value: T }
  | { state: 'refused'; status: 401 | 403 }
  | { state: 'version-mismatch'; status: 502 }
  | { state: 'unavailable'; status: number; reason: 'native-pending' | 'source' | 'dependency' };

export interface EditionApi {
  /** GET /v1/contentEditions/{id}, with the actual delivery actor's credential. */
  readMetadata(id: string, authorization: string): Promise<EditionRead<EditionMetadata>>;
  /** GET /v1/contentEditions/{id}/revision; native owns final current disclosure. */
  readRevision(id: string, authorization: string): Promise<EditionRead<EditionRevision>>;
}
