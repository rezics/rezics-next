# Realm member count point read growth

## Binding

The measured operation is `GET /v1/realms/{realmId}/presentation` through the registered production Kernel created by `CommunityDriver.growthFixture()`. That route retains the existing Realm home disclosure checks and calls `readRealmMemberCount` inside its native home snapshot; the raw helper is not an endpoint.

The binding decision is to use the existing Realm presentation read as the caller operation. It is the header consumer named by the community Cost contract and keeps Access and privacy decisions in their current owner.

## Growth evidence

The fixture keeps one selected Realm and route fixed. It independently measures selected current members, unrelated Realm count controls, and retained closed membership history at 256, 1024 and 4096. Selected member source rows model a pre-install database image and are counted by the native bounded `maintainRealmMemberCounts` workflow before observation. The actual selected member leave and rejoin use the production HTTP route and registered worker. Unrelated Realms are valid source rows; retained history is seeded before each measured read.

Each series uses the shared `checkGrowth` observer with constant rows and statements and logarithmic blocks. Assertions retain one planned row from the exact `realm_member_count` control, no sequential scan of that control or member history, exact current count, safe integer count, and canonical bigint version. The outcome cases include zero, populated count, actual removal and rejoin, missing and partial controls, missing removal coverage, unsupported future horizon, expired home deadline, SQL failure propagation, and protected non-member disclosure.

## Source and execution

Source revision: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`.

Fixture binding: `createCommunityDriver` provisions Auth-issued accounts and production Access; `growthFixture()` binds a registered `createKernel` to `GrowthDatabase.pool`. Measured reads go through `CommunityDriver.request`, so the growth capture includes the actual home operation and its native SQL.

Eventual acceptance command: `bun run --cwd services/kernel check test/community/growth-realm-member-count-read.test.ts`.

Controller launch deferral kept that acceptance unrun in this attempt. No three-scale measurements or reached runtime assertions are claimed; the authored test records the exact scales and assertions for controller execution after integration.
