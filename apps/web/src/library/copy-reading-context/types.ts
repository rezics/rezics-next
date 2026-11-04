import type { KernelClient } from '@rezics/client';
import type { Fact } from '../../search/results';

export type NativeCopyListRow = NonNullable<
  Awaited<ReturnType<KernelClient['copies']['get']>>['data']
>['copies'][number];

export type NativeCopyContextIdentity = { id: string; labels: Record<string, string> };
export type NativeCopyListContext =
  | { state: 'available'; work: NativeCopyContextIdentity[]; facts: Record<string, Fact[]> }
  | { state: 'unsupported'; facts: Record<string, Fact[]> }
  | { state: 'scope' | 'withheld' | 'missing' | 'unavailable' };

export type CopyReadingIdentity = {
  id: string;
  label: string;
  labelLanguage?: string;
};

export type CopyReadingFact = {
  property: string;
  label: string;
  text: string;
  language?: string;
  subject?: CopyReadingIdentity;
};

/** A bounded presentation of the native context attached to one physical copy row. */
export type CopyReadingContext =
  | { state: 'available'; work: CopyReadingIdentity[]; facts: CopyReadingFact[] }
  | { state: 'unsupported'; facts: CopyReadingFact[] }
  | { state: 'scope' | 'withheld' | 'missing' | 'unavailable' };
