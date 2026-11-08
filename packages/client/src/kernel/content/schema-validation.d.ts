import type { Static, TSchema } from 'typebox';
/** Validate the published TypeBox shape without Elysia removing unknown input or response fields. */
export declare function strictContentSchema<S extends TSchema>(schema: S, check?: (value: unknown) => readonly {
    pointer: string;
    code: string;
}[]): {
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
