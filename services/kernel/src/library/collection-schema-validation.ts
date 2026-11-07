/** Preserve original JSON fields at the Collection HTTP boundary. */
import { Compile } from 'typebox/compile';
import type { Static, TSchema } from 'typebox';
export function strict<S extends TSchema>(schema: S) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return validator.Check(value)
          ? { value: value as Static<S> }
          : {
              issues: [{ message: 'Value does not match the Collection schema' }],
            };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
