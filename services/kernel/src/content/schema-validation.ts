import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

/** Validate the published TypeBox shape without Elysia removing unknown input or response fields. */
export function strictContentSchema<S extends TSchema>(
  schema: S,
  check?: (value: unknown) => readonly { pointer: string; code: string }[],
) {
  // Catalogue composition needs the shape, but workers never validate HTTP payloads.
  // Compile only at the input/response boundary; a supplied validator already owns that work.
  let validator: ReturnType<typeof Compile<S>> | undefined;
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return (check ? check(value).length === 0 : (validator ??= Compile(schema)).Check(value))
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the content schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}
