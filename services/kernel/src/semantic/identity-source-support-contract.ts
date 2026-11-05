import type { IdentityJobRef } from './identity-epoch-contract.ts';
import type { PublicFilterSourceDefinition } from './public-filter-source-binding.ts';
import type {
  PublicFilterCost,
  PublicFilterProjectionPage,
  PublicFilterReadContext,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';

/** Internal Source support, never an anonymous allow or a Search writer-drain receipt. */
export type IdentitySourceSupportRequest = Readonly<{
  job: IdentityJobRef;
  definition: PublicFilterSourceDefinition;
  frontier: string | null;
  /** Examined native inputs, including rejects and replay. Lower native limits prevail. */
  inputLimit: number;
  context: PublicFilterReadContext;
}>;

export type IdentitySourceSupportRecord = Readonly<{
  original: string;
  terminal: string;
  /** Null means current native guards actually withheld this original. Unknown is not null. */
  projection: PublicFilterProjectionPage | null;
}>;

export type IdentitySourceSupportPage =
  | Readonly<{
      status: 'progress';
      records: readonly IdentitySourceSupportRecord[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      records: readonly IdentitySourceSupportRecord[];
      frontier: null;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'changed' | 'unready' | 'unavailable';
      cost: PublicFilterCost;
    }>;

export type IdentitySourceSupportReader = Readonly<{
  readPage(request: IdentitySourceSupportRequest): Promise<IdentitySourceSupportPage>;
}>;
export type IdentitySourceSupportReaderFactory = (
  config: Parameters<PublicFilterSourceFactory>[0],
) => IdentitySourceSupportReader;
