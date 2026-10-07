# First installation and launch intake

Run [production configuration checks and migrations](deployment.md#ready-to-deploy)
before starting the release. The bootstrap consumes the public Main APIs; it
does not connect to owner databases or reuse demo identities, Works, posts or
ratings. Its command is `task ops:bootstrap`.

## Operator and authority

Boot Account and Main with `PLATFORM_FIRST_ADMIN_ACCOUNT` unset. Register the
first real operator through Account and verify its email. Record
the returned Account subject in `ACCOUNT_OPERATOR_USER_IDS`, restart Account,
and confirm the one-time bootstrap assigned `owner` at
`GET /api/account/admin/me`. Account selects an existing configured candidate;
it cannot assign an owner to an identity that has not yet registered. Stored
roles govern later authority, and restarting does not restore a removed role.
Keep subsequent operator assignment and removal in Account's audited APIs.

Provision the operator's Person Agent through Main's Agent API. Put its native
IRI and the Account subject in a local copy of
[the launch plan](../../tests/fixtures/launch/plan.yaml). Use the operator's
Account session cookie and a consented Main bearer token for that same subject.
Include `classification:define` and `rating:configure` in the token's scopes:
bootstrap installs the variant-kind and canonicity Concept schemes and the three
Global questions for Characters, performances within a position or event, and
units within a release. Each question is authored once in English, with reviewed
presentations in the other seven UI locales. Resource means start at five ratings;
projection means start at ten. Bootstrap creates no observations.
Supply them as `BOOTSTRAP_ACCOUNT_COOKIE` and `BOOTSTRAP_MAIN_TOKEN`; neither is
written to the journal. Renew the token through Account if it expires, then
repeat the command with the same plan and namespace.

After signing in and provisioning the Agent, set `PLATFORM_FIRST_ADMIN_ACCOUNT`
to that Account subject in Main's operator environment and restart Main.
Access requires the existing active principal; a missing, mistyped or inactive
subject fails startup without consuming the designation. Its startup owner
command grants permanent `platform:grant`, `platform:use:platform-admin` and
the administrator resource permissions, committing their shared immutable audit
receipt atomically. Verify that receipt in Main's startup log, then remove the
setting. Once a designation exists, Access logs that a supplied setting is
ignored, including a replay with the same subject or a different candidate.
Configuration never restores revoked grants or a deactivated principal.

Appoint at least two distinct active permanent `platform:grant` holders. The
first holder assigns the second through the ordinary Access grant API:
`POST /v1/access/grant-changes` with profile `platform-grant-change-v1`, action
`create`, permission `platform:grant`, `scopeId: platform:access`, the second
principal as recipient, and `validUntil: null`. Supply the issuer's Agent IRI,
a new grant UUID, the current authority epoch and an idempotency key; the Main
token needs the `access:grant` OAuth scope.
The issuer needs a live Agent controller and the permanent
`access.grant.assign.platform` assignment ceiling supplied at first designation.
Issuing `platform:grant` to a principal confers that assignment ceiling on the
recipient's live Agent controller for the same lifetime, never longer than the
issuer's own ceiling. Revoking the grant, or letting it expire, removes the
ceiling. A principal with no live Agent controller cannot receive
`platform:grant`, and a group grant does not confer a ceiling.
Later assignments and revocations use this same grant path within that ceiling;
the last active permanent holder cannot be removed or deactivated. Assign
`platform:use:platform-admin` and resource permissions separately when the
backup also needs administrator operations. A governance grant alone supplies
assignment authority, not resource authority.

Before opening production and lifting the registration pause, run:

```sh
task ops:platform-governance -- .temp/production.env
```

This checks Access directly and fails unless an active principal holds a
permanent direct `platform:grant`; it warns until two distinct principals hold
it. Finite grants do not satisfy the gate. Keep registration paused if the check
fails. Main remains available without governance so the first operator can sign
in and provision the Agent that receives designation. Production `/health/ready`
checks whether Main is safe to serve, including recorded migrations and the
absence of payment provider rows; governance is the separate opening gate.
`ops:env-check` validates configuration and states
this opening rule; it does not establish governance verification. Run catalogue
bootstrap verification separately after designation.

Account ownership and Main grants are separate. The platform administrator's
live Agent controller can create/configure its own official Zones, change its
created semantic definitions and reviewed labels, create/verify catalogue Works,
admit sources, and operate platform moderation. Work and Collection reads and
edits use ordinary creator/curator authority; administrator permissions never
grant access to a member's private shelves, lists, Works or exports. OAuth scopes remain ceilings. Scope closure,
recovery holds, explicit policies, principal and controller revocation still
fence operations. A holder of `platform:use:platform-admin` receives the existing
`trusted` rate-limit class;
bootstrap uses its ordinary budget without installing a service client or
overriding limits. It refuses denied operations and retains commands for replay.
It never inserts grants into a database.

The creating principal receives definition stewardship from its successful
sealed semantic creation receipt and current Agent controller proof. This
covers meaning changes and draft labels for that definition; it does not confer
independent lexicon review authority. An explicit resource policy, controller
revocation, protection, retirement or recovery hold still fences the action.

## Prepare the launch plan

The checked-in plan is a bounded VNDB title-intake proof. It is not the complete
launch catalogue: releases, translations, producer credits and LN volumes stay
with their source mapping owners. Its JSON pointers refer to G-852's admitted
dump slice. The executor checks the slice checksum, byte bound, record identity,
title, language and served type registry before any write. It retains those
exact values and the dump provenance through `POST /v1/sources/intakes`.

Name each enabled source's steward and backup. `TBD` is intentionally present
in the template; production refuses it. Preserve the pinned dump URL, version,
checksum, slice checksum, licence, dated rights evidence and attribution. The
VNDB slice excludes descriptions, images, votes and other unadmitted fields.
Wikidata and Open Library are declared but disabled until pinned slices, source
mappings and stewards are supplied. Do not substitute live API requests or enable
Bangumi, RanobeDB, AniList or non-commercial sources through this plan.

The Zone manifests create empty official LN/VN catalogue Collections and a
franchise wiki with mounted Characters, Places, Events and Chapters Collections.
Mounted Collections, navigation and presentation are data. The import proof
places the same native catalogue Work in both LN/VN Collections; it creates no
extra Work for a Zone or language.

## Safety responders

Before opening registration, uploads or posting, appoint a primary and a backup
safety responder. **The maintainer has not named the launch backup yet.** Do
not replace that missing appointment with a demo subject or the primary's own
Account. Record both approved Account subjects and provision their platform
moderation/evidence authority through the
[trust and safety procedure](trust-and-safety.md#platform-suitability-moderation-setup).
Verify both Account email addresses and record their preferred mail language.

In the operator's `.temp/production.env`, set `SAFETY_PRIMARY_ACCOUNT` and
`SAFETY_BACKUP_ACCOUNT` to those distinct subjects, alongside the existing
`ACCOUNT_ISSUER`, Main confidential-client credentials and retained erasure
relay. Restart Main. The checked-in Main environment example leaves both unset;
an incomplete roster fails startup, and an unset roster leaves alerting disabled.
No default backup is appointed by the software. Account uses its existing SMTP
configuration and mandatory notice queue; optional notification preferences and
optional-mail suppression do not disable safety alerts.

Run the deadline and absent-responder drill with both responders, including a
lost mail acknowledgement, before claiming readiness. Confirm the primary's
approach alert, the backup's absence and overdue alerts, and the recorded SMTP
result in `access.safety_alert_delivery`. A pending or uncertain delivery is not
a successful drill. The [alert operating procedure](trust-and-safety.md#deadline-alerts-and-responder-absence)
describes acknowledgement, recovery and audit inspection. Mandatory mail to
affected uploaders remains the separate SAFETY07 launch gate.

## Bootstrap and verify

Keep the environment file, customized plan and receipts under `.temp/` in the
installation checkout. Set the two credentials in the process environment,
then run one command:

```sh
task ops:bootstrap -- --plan .temp/launch/plan.yaml --env .temp/production.env \
  --main https://main.example.com --account https://account.example.com
```

The command validates the production environment and matching service origins,
confirms the Account owner session, creates the launch structure and vocabulary,
then admits the bounded source records. Every catalogue creation first obtains
a candidate receipt and declares `new-creative-scope`; the executor never calls
the `own-work` authoring path for imported material. A nonempty candidate result
requires adjudication and stops the import. Verification then confirms the
catalogue receipt, public Zones, definition keys, public Work reads and each
question's wording in all eight UI locales. Question presentations preserve the
English measurement and its rating population.

For an isolated QA environment, use `--mode qa` and its loopback service origins.
That mode relaxes production environment and steward prerequisites; it does not
relax API authority, source pins, request bounds or Account owner identity.

Re-read the resulting public resources without writes:

```sh
task ops:bootstrap -- --verify --plan .temp/launch/plan.yaml --env .temp/production.env \
  --main https://main.example.com --account https://account.example.com
```

## Retry and recovery

The journal is `.temp/bootstrap/<namespace>/journal.json`; the confirmed result
and counts per served type are in `result.json` beside it. Preserve these with
the plan for the timed restore drill. Counts describe this bounded plan's
confirmed imports, not the whole graph. A second run retains the same owner
receipts and sends no already-confirmed commands.

Commands are saved before dispatch. After a killed process or lost response,
repeat the command unchanged: it sends the original request body and key,
including the candidate receipt. Pending `202`, short `Retry-After` responses
and transient unavailability receive bounded sequential retries. A longer wait,
authority denial, unknown network outcome or exhausted retries leaves the
command unconfirmed for the next run. A run stops after its 600-second preparation
budget and resumes through the same journal. Bootstrap never changes principal or
spawns parallel import workers to evade rate limits.

One process owns the local journal lock. After a killed process the next run
reclaims it only if that PID no longer exists. An unreadable lock requires
operator inspection. Preserve the journal when changing machines; a changed
plan or actor is refused. Do not delete receipts to recover from a stale head
or change the namespace to bypass an uncertain operation. Inspect the API's
owner result, resolve the conflict, then explicitly prepare a new plan.

## Acceptance and remaining launch gates

Run `task goal -- test tests/qa/integration/g-724-bootstrap.test.ts` for the
isolated empty-stack acceptance. It uses real Account OAuth, owner databases,
Fuseki, immutable S3 objects and the unchanged trusted-class budget. The test
invokes the bootstrap Task command, kills its process group after a confirmed
catalogue API write but before client acknowledgement, resumes the exact command,
then verifies public resources and a no-op rerun. The dev/test template retains
`TBD` stewards; production still refuses those enabled sources.

The bounded title proof does not establish the complete launch catalogue.
Integrate the full source mapping and name production source stewards before
starting a larger campaign.
