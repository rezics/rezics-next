goal: performance
manager: performance

# Whole-query publication plans

See the Library owner decision and cost derivation in
[`services/kernel/src/library/README.md`](../../services/kernel/src/library/README.md#whole-query-collection-publication).

This attempt committed a service-local nine-axis lower-bound calculation, reused the existing staging ceiling as the
root allowance, and moved public-catalogue refusal before Search scope preparation. It did not alter the staging
settlement hold or final output dispatch.

The current first-prefix branch's lower bound is over the existing candidate-key and native-row ceilings. Keep the
caps and producer limits unchanged until the performance owner resolves the recorded derivation. Then complete and
wire immutable one-attempt plans for staging, checkpoint recovery, exhaustion sealing and final activation, including
all nested Source/currentness/identity/custody, output and callback costs. Replace the held settlement envelope only
after the combined per-branch plan fits the existing root; retain the same original Work and native admission.

Add the smallest causal native cases for same-checkpoint recovery to exhaustion, changed Source/episode/identity
before settlement and activation, missing seal/foreign proof preserving A, and the legacy remaining-counter case.
Run the named Library and five Search receiving suites through the controller; acceptance remains deferred there.
