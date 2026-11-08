# Content editions

Decision: `contract.ts` contains the Edition DTO and API state types. Runtime response schemas and exact document
validation live in the Web API adapter's `edition-schema.ts`; `edition-api.ts` re-exports the parsers and applies
them to native responses before returning data.
