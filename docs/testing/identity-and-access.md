# Account and Access acceptance

The [typed IAM cases](../../scripts/qa/cases/identity-and-access.ts) state the
stable scenarios and required results. [Coverage declarations](../../scripts/qa/coverage/iam.ts)
and the owner tests identify the executable evidence. The
[qualification record](../plan/README.md#current-state) reports the completed run;
a selected test pass alone does not qualify a case.

Account authenticates a private user. Access selects and checks an acting Agent
for each protected operation. Neither an OAuth scope nor a public Agent
identifier supplies the other's authority. Acceptance must preserve the exact
Account, Access and Main owner boundaries, and distinguish denial from an
unavailable dependency or an unresolved partial effect.

The recorded IAM01 qualification covers separate OAuth product clients and
explicit Agent selection through Main and Access. It does not qualify browser
tab storage or the full Studio/session/task-default resolution. Those
[additional obligations](../../scripts/qa/cases/identity-and-access.ts)
remain pending without changing the qualified backend case denominator.
Web stories and browser tests own the browser behavior; the
[frontend direction](../plan/frontend.md#identity-and-administration) records
the decisions for surfaces not yet built.
