import type { TProperties } from 'typebox';
/** The common page body shared by public presentation reads and their extensions. */
export declare const PageResponseSchema: import("typebox").TObject<{
    subject: import("typebox").TOptional<import("typebox").TString>;
    account: import("typebox").TOptional<import("typebox").TString>;
    context: import("typebox").TOptional<import("typebox").TObject<{
        id: import("typebox").TString;
        population: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"global">;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"realm">;
            id: import("typebox").TString;
            title: import("typebox").TString;
        }>]>;
    }>>;
    continuation: import("typebox").TOptional<import("typebox").TObject<{
        node: import("typebox").TString;
        cursor: import("typebox").TString;
    }>>;
    streams: import("typebox").TOptional<import("typebox").TObject<{
        selected: import("typebox").TOptional<import("typebox").TString>;
        entries: import("typebox").TArray<import("typebox").TObject<{
            node: import("typebox").TString;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
        }>>;
    }>>;
    profile: import("typebox").TString;
    template: import("typebox").TObject<{
        scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
        key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    document: import("typebox").TAny;
    views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    catalogue: import("typebox").TOptional<import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
        type: import("typebox").TString;
        digest: import("typebox").TOptional<import("typebox").TString>;
        definitions: import("typebox").TOptional<import("typebox").TObject<{
            types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
            properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
        }>>;
        directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"admitted">;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
            inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sourceTypes: import("typebox").TArray<import("typebox").TString>;
            targetTypes: import("typebox").TArray<import("typebox").TString>;
            viaQualifier: import("typebox").TOptional<import("typebox").TString>;
            release: import("typebox").TString;
            qualifiers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                datatype: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
            release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
        }>]>>>;
    }>>;
    viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
        account: import("typebox").TOptional<import("typebox").TString>;
        context: import("typebox").TString;
        actions: import("typebox").TObject<{
            statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
        }>;
    }>, import("typebox").TObject<{
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
        account: import("typebox").TOptional<import("typebox").TString>;
    }>]>>;
    reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        status: import("typebox").TInteger;
        body: import("typebox").TAny;
        headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    }>>;
    meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        text: import("typebox").TString;
        lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>>;
    unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        admitted: import("typebox").TLiteral<false>;
    }>>>;
    actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
        action: import("typebox").TString;
        operationId: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
    }>>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"ready">;
        viewerActions: import("typebox").TArray<import("typebox").TObject<{
            action: import("typebox").TString;
            operations: import("typebox").TArray<import("typebox").TString>;
        }>>;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"unavailable">;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"denied">;
    }>]>>;
}>;
/** Builds a closed top-level extension of the common page response without mutating its schema. */
export declare function extendPageResponseSchema<Extension extends TProperties>(extension: Extension): import("typebox").TObject<{
    subject: import("typebox").TOptional<import("typebox").TString>;
    account: import("typebox").TOptional<import("typebox").TString>;
    context: import("typebox").TOptional<import("typebox").TObject<{
        id: import("typebox").TString;
        population: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"global">;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"realm">;
            id: import("typebox").TString;
            title: import("typebox").TString;
        }>]>;
    }>>;
    continuation: import("typebox").TOptional<import("typebox").TObject<{
        node: import("typebox").TString;
        cursor: import("typebox").TString;
    }>>;
    streams: import("typebox").TOptional<import("typebox").TObject<{
        selected: import("typebox").TOptional<import("typebox").TString>;
        entries: import("typebox").TArray<import("typebox").TObject<{
            node: import("typebox").TString;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
        }>>;
    }>>;
    profile: import("typebox").TString;
    template: import("typebox").TObject<{
        scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
        key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    document: import("typebox").TAny;
    views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    catalogue: import("typebox").TOptional<import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
        type: import("typebox").TString;
        digest: import("typebox").TOptional<import("typebox").TString>;
        definitions: import("typebox").TOptional<import("typebox").TObject<{
            types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
            properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
        }>>;
        directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"admitted">;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
            inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sourceTypes: import("typebox").TArray<import("typebox").TString>;
            targetTypes: import("typebox").TArray<import("typebox").TString>;
            viaQualifier: import("typebox").TOptional<import("typebox").TString>;
            release: import("typebox").TString;
            qualifiers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                datatype: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
            property: import("typebox").TString;
            direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
            release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
        }>]>>>;
    }>>;
    viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
        account: import("typebox").TOptional<import("typebox").TString>;
        context: import("typebox").TString;
        actions: import("typebox").TObject<{
            statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
        }>;
    }>, import("typebox").TObject<{
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
        account: import("typebox").TOptional<import("typebox").TString>;
    }>]>>;
    reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        status: import("typebox").TInteger;
        body: import("typebox").TAny;
        headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    }>>;
    meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        text: import("typebox").TString;
        lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>>;
    unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        admitted: import("typebox").TLiteral<false>;
    }>>>;
    actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
        action: import("typebox").TString;
        operationId: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
    }>>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"ready">;
        viewerActions: import("typebox").TArray<import("typebox").TObject<{
            action: import("typebox").TString;
            operations: import("typebox").TArray<import("typebox").TString>;
        }>>;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"unavailable">;
    }>, import("typebox").TObject<{
        status: import("typebox").TLiteral<"denied">;
    }>]>>;
} & Extension>;
