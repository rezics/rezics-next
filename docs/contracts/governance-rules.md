# Governance rules and decisions

An approved rule is a basis for a decision, not authority inferred from a title,
classification or graph presence. The current [rule owner](../../services/main/src/modules/governance/rules.ts)
publishes immutable, scoped JSON revisions with a compare-and-set head and
idempotent receipt in Access. [Governance decisions](../../services/main/src/modules/governance/schema.ts)
bind exact rule/evidence revisions; [proposal execution](../../services/main/src/modules/proposal/schema.ts)
binds the approved effect and current body capability. The earlier design placed
rules in Jena; Access is the implemented owner for rule revisions.

## Rule lifecycle still to model

The generic published document does not yet distinguish draft, reviewed, active,
superseded and retired states; semantic text from localized presentation; an
activation interval; eligible decision makers; or per-rule enforcement powers.
Authoring, activation and enforcement should remain separately grantable.
Activation should compare the approved candidate digest and policy generation,
serialize within its scope and recheck old jobs before application. Translation
changes must not change the approved meaning.

AI review needs a recorded method, inputs, model/tool configuration, limitations
and output under a selected policy. An ambiguous or unavailable review calls for
an explicit human or pending disposition. No generic JSON publication or vote
outcome currently proves those review conditions.

## Decision boundaries

[Editorial correction](editorial-protection.md) uses independent human review
for the initial protected profile. Future effects must bind the exact proposal,
target, evidence and expected protection/control state and retain protection
during application. A stale basis stays pending or rejected; an appeal or
reversal adds an attributable decision. The first executable proposal capability
is the exact access.org.roster.policy effect; the [proposal owner](../../services/main/src/modules/proposal/execute.ts)
defines its digest, target and recovery contract. Additional capabilities need
their own effect profiles and tests.
