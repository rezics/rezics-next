type ConditionFilterRange =
  | { readonly type?: never; readonly gte?: number; readonly lte?: number; readonly unit?: string }
  | { readonly type: 'time'; readonly gte?: string; readonly lte?: string };
type ConditionFilterQualifier =
  | { readonly property: string; readonly in: readonly string[] }
  | { readonly property: string; readonly range: Exclude<ConditionFilterRange, { readonly type: 'time' }> };
type ConditionFilterStatement =
  | {
      readonly property: string;
      readonly in: readonly string[];
      readonly concept?: { readonly scheme: string; readonly includeChildren?: boolean };
      readonly inverse?: true;
      readonly qualifiers?: readonly ConditionFilterQualifier[];
    }
  | {
      readonly property: string;
      readonly range: ConditionFilterRange;
      readonly qualifiers?: readonly ConditionFilterQualifier[];
    };
type ConditionOwnerLeaf = {
  readonly owner:
    | { readonly presence: true }
    | {
        readonly state: {
          readonly profileId: string;
          readonly stateSetId: string;
          readonly in: readonly string[];
        };
      }
    | { readonly label: { readonly id: string } }
    | {
        readonly session: {
          readonly profileId: string;
          readonly lifecycle: 'active' | 'completed' | 'abandoned';
        };
      }
    | { readonly holding: { readonly profileId: string; readonly kind?: string; readonly status?: string } };
};

/** Structural released grammar shape; the Filter parser remains the runtime grammar authority. */
export type ConditionMetadataFilter =
  | { readonly and: readonly ConditionMetadataFilter[] }
  | { readonly or: readonly ConditionMetadataFilter[] }
  | { readonly not: ConditionMetadataFilter }
  | { readonly type: { readonly in: readonly string[] } }
  | { readonly statement: ConditionFilterStatement }
  | { readonly saved: string }
  | ConditionOwnerLeaf;

export type ConditionMetadata = {
  digest?: string;
  types: Record<string, { labels?: Record<string, string>; bases?: readonly string[]; facets?: readonly string[] }>;
  properties: Record<
    string,
    {
      labels?: Record<string, string>;
      datatype: string;
      targets?: readonly string[];
      relation?: { group: string };
      qualifiers?: readonly string[];
      units?: readonly string[];
      value?: { pattern?: string; minLength?: number; maxLength?: number };
    }
  >;
  filters?: Record<string, { filter: ConditionMetadataFilter; labels?: Record<string, string> }>;
};
