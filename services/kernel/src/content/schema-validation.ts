import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

/** Validate the published TypeBox shape without Elysia removing unknown input or response fields. */
export function strictContentSchema<S extends TSchema>(
  schema: S,
  check?: (value: unknown) => readonly { pointer: string; code: string }[],
) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return (check ? check(value).length === 0 : validator.Check(value))
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the content schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
