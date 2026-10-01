# First installation and launch intake

Run [production configuration checks and migrations](deployment.md#ready-to-deploy)
before starting the release. The bootstrap consumes the public Main APIs; it
does not connect to owner databases or reuse demo identities, Works, posts or
ratings. Its command is `task ops:bootstrap`.

## Operator and authority

Register the first real operator through Account and verify its email. Record
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
Supply them as `BOOTSTRAP_ACCOUNT_COOKIE` and `BOOTSTRAP_MAIN_TOKEN`; neither is
written to the journal. Renew the token through Account if it expires, then
repeat the command with the same plan and namespace.

Account ownership does not currently confer a Main platform role. Main must
already admit this Agent's scoped authority for Zone creation/configuration,
semantic definition creation, catalogue creation and verification, and source
intake. An OAuth scope is a ceiling, not a grant. Bootstrap refuses a denied
operation and retains its command for replay. It never inserts grants into a
database. Platform moderation provisioning still requires a public Access
authority path; the existing [manual setup](trust-and-safety.md#platform-suitability-moderation-setup)
is not executed by this command.

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
catalogue receipt, public Zones, definition keys and public Work reads.

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

## Remaining launch gates

The current production-shaped acceptance still needs an isolated real-stack
run with a platform administrator and its API-provisioned authority. The
checked-in deterministic tests exercise the executor's API requests, pinned
evidence, no-op replay, interruption, rate-limit handling and creator proof;
they do not establish complete empty-stack installation. Integrate the full
source mapping and the public platform-authority path before recording that
acceptance or starting a larger campaign.
