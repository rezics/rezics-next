import type { KindOption } from './kinds.ts';
import type { EditablePart } from './parts-editor.tsx';
import type { CoverableRealization } from './editions-editor.tsx';
import type { WorkChoice } from './work-picker.tsx';

// Records the edit stories and tests share: the Index subseries, whose "22 Reverse" volume is a
// separate part after "22".

const iri = (n: number) => `https://rezics.com/id/01944100-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const work = '01944100-0000-7000-8000-000000000001';
export const structure = iri(2);
export const head = iri(3);

export const parts: EditablePart[] = [
  { occurrence: iri(11), role: 'part', label: '1', name: 'New Testament 1', inclusion: 'required' },
  { occurrence: iri(12), role: 'part', label: '2', name: 'New Testament 2', inclusion: 'required' },
  { occurrence: iri(13), role: 'part', label: '22', name: 'New Testament 22', inclusion: 'required' },
  { occurrence: iri(14), role: 'part', label: 'SS1', name: 'New Testament SS', inclusion: 'extra' },
];

export const kinds: KindOption[] = [
  { key: 'rewrite', label: 'Rewrite of', language: 'en' }, { key: 'reboot', label: 'Reboot of', language: 'en' },
  { key: 'adaptation', label: 'Adapted from', language: 'en' }, { key: 'sequel', label: 'Sequel to', language: 'en' },
  { key: 'spin-off', label: 'Spin-off of', language: 'en' },
  { key: 'correspondence-partial', label: 'Partly corresponds to', language: 'en' },
];

export const realizations: CoverableRealization[] = [
  { id: iri(21), revision: iri(22), work: iri(1), language: 'ja' },
  { id: iri(23), revision: iri(24), work: iri(1), language: 'en' },
];

export const mainVersion = iri(5);
export const mainRevision = iri(6);

export const works: WorkChoice[] = [
  { id: '01944100-0000-7000-8000-000000000031', title: 'New Testament 22 Reverse', language: 'en' },
  { id: '01944100-0000-7000-8000-000000000032', title: 'New Testament 22', language: 'en' },
];
export const loadWorks = async () => works;
export const loadRealizations = async () => ({ title: 'New Testament 22 Reverse', items: realizations });
