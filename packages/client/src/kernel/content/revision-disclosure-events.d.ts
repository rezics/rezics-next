import { Type } from 'typebox';
/** Identity-only payloads. Exact private targets never enter the outbox. */
export declare const REVISION_DISCLOSURE_EVENTS: {
    readonly 'com.rezics.content.revision-disclosure.issued.v1': Type.TObject<{
        disclosureId: Type.TString;
        catalogueId: Type.TString;
    }>;
    readonly 'com.rezics.content.revision-disclosure.revoked.v1': Type.TObject<{
        disclosureId: Type.TString;
        catalogueId: Type.TString;
    }>;
};
