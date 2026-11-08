import type { Static, TSchema } from 'typebox';
export declare function strict<S extends TSchema>(schema: S): {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: Static<S>;
            output: Static<S>;
        } | undefined;
        validate(value: unknown): {
            value: Static<S>;
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => S;
            output: () => S;
        };
    };
};
