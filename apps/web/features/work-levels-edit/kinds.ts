// The relation kinds an editor may record from a Work's edit page, by the stable key Main's
// lexicon seeds them under (G-832). Only the keys are chosen here. Everything a person reads
// about a kind (its label, in their language and from the side they are on) is Main's rendering.
//
// Main keeps the subject of every two-role kind in its second role (the Work that rewrites,
// reboots, continues or corresponds), and Access admits a change to whoever edits that Work, so
// the Work being edited is always the subject and the person names the other Work.

/** `derivation` kinds pin the source's Main Version (`POST /v1/resources/{id}/derivations`); the rest are relation occurrences. */
export const relationKinds = [
  { key: 'rewrite', via: 'derivation' }, { key: 'reboot', via: 'derivation' }, { key: 'adaptation', via: 'derivation' },
  { key: 'sequel', via: 'relation' }, { key: 'spin-off', via: 'relation' },
  { key: 'correspondence-equivalent', via: 'relation' }, { key: 'correspondence-partial', via: 'relation' },
  { key: 'correspondence-revised', via: 'relation' },
] as const;
export type RelationKindKey = (typeof relationKinds)[number]['key'];
export const isRelationKind = (key: string): key is RelationKindKey => relationKinds.some(kind => kind.key === key);
export const viaOf = (key: RelationKindKey) => relationKinds.find(kind => kind.key === key)!.via;

/** A kind as the form offers it: Main's definition and the label Main renders for the editing Work's side. */
export interface KindOption { key: RelationKindKey; label: string; language: string }
