ARG BUN_IMAGE=oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY . .
ENV YARN_ENABLE_SCRIPTS=false YARN_ENABLE_IMMUTABLE_INSTALLS=true
RUN bun yarn.cjs workspaces focus $(cat runtime-workspaces.txt) --production \
    && bun -e 'import { releaseRuntimeFiles } from "./scripts/ops/release-payload.ts"; for (const entry of await Bun.file("runtime-entrypoints.json").json()) releaseRuntimeFiles(process.cwd(), entry);' \
    && rm yarn.cjs runtime-workspaces.txt runtime-entrypoints.json

FROM ${BUN_IMAGE} AS runtime
ARG ROLE=main
ARG SOURCE_DATE_EPOCH=0
WORKDIR /app
ENV NODE_ENV=production REZICS_ROLE=${ROLE}
# The context already excludes private and development payloads. Carry its full
# import closure, including future runtime roots outside services and packages.
COPY --from=dependencies --chown=bun:bun /app/ ./
USER bun
ENTRYPOINT ["bun", "infra/release/entrypoint.ts"]
