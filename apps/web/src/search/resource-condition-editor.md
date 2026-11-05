# Request-only Realm and Collection conditions

This editor implements the request-only resource operands owned by [universal search conditions](../../../../docs/search-conditions.md). It does not define another filter grammar or evaluate authorization in the browser.

The Search editor admits only the closed leaves `{collection:{id:UUID}}` and `{realm:{id:UUID}}`. The ID must be a lowercase canonical UUID. Each operand has exactly one `id` field. The existing condition constructor still checks the full Boolean tree, released saved-filter expansion and structural limits. Resource leaves are represented by a private structural stand-in during that check; that stand-in is never emitted. Saved/public-filter consumers use default construction and continue to reject resource leaves, including resource syntax hidden in a saved definition.

The existing non-embedded Search `ConditionEditor` opts into the request-resource extension. Embedded editors remain closed. A caller may provide display metadata through `requestResources={{ labels: [{ kind, id, labels }] }}`; the `labels` list is optional. An ID field is always available immediately, and a displayed label never supplies or replaces an ID. No picker service is required.

Local operand errors point to `/filter/and/0/.../{collection|realm}/id`, following the authored `and`, `or` and `not` path. Missing IDs use `required`; non-string IDs use `invalid_type`; noncanonical IDs use `invalid_format`; extra selector keys use `unknown_field`. Native errors keep their returned condition pointer and attach to the same ID field when it identifies that operand. Unknown or inaccessible resources retain the native concealed outcome. The tree is left intact for correction; the editor never removes a denied leaf or decides whether a NOT or OR makes the query true.

Decision: The existing non-embedded Search editor opts into request-only resource leaves; embedded saved/public editors keep the closed default, and supplied labels remain display-only.
