# Quota and request-budget boundaries

The [quota owner](../../services/main/src/modules/quota/store.ts) defines
reservation, settlement, compensation and independent grant ledgers; [SUB04](../../scripts/qa/cases/subscriptions-and-pro.ts)
qualifies last-capacity races. API rate limits, domain admission, usage metering
and commercial charging retain different units and failure semantics.

Shared request budgets remain to be selected across composed queries, graph
expansion, memory, result bytes, batch fan-out, source fetches, solver work and
queue retention. A client Filter or preset cannot raise a server ceiling, and a
nested Block or service hop must not restart the budget. Each affected API needs
bounded retry/backoff, partial or exhausted outcomes with safe diagnostics.
