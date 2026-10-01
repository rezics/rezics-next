# Adding API and event surfaces

API operations own backend behavior; UI, SDK, CLI and MCP consume them. An
accepted asynchronous request does not prove another owner's effect finished.

## Add an operation

1. Define runtime schemas in the owner route module. Bind Account/Access
   authority, expected state, idempotency and cost; test denial, races and lost responses.
2. Export `openApiOperations` for bearer security and `Idempotency-Key` where
   required. Register Main routes in `domainRoutes` in `services/main/src/app.ts`.
3. Test receipt replay and generated response shapes; run `task gen:check`.

## Operation representation and errors

Route schemas, `services/main/src/routes/problems.ts` and generated OpenAPI
define installed envelopes and safe Problem Details codes. Reconcile an uncertain
graph outcome with the same body and key. No general operation-status endpoint exists.

## Owner extension points

- Export `oauthScopes` in `services/account/src/oauth-scopes/<owner>.ts`;
  declaration does not grant consent or Access rights.
- Export `outboxEventHandlers` in `services/main/src/modules/<owner>/outbox-event.ts`
  with exact RDF kind, receipt action and CloudEvent type. The relay verifies the
  terminal receipt and position. Export `receiptFamilies` in the owner's
  `receipt-family.ts` for Access-admitted actions; system events prove their graph terminal.
- Export `projectionRecipes` in the owner's `projection-recipe.ts` with `text` or
  `skip` per exact Content model. Unknown models hold the cursor; duplicate
  declarations fail at startup.
