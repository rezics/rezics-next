FROM maven:3.9.16-eclipse-temurin-21@sha256:c2a2c58516d160f43b50f12baa427ca86989e0bc942609e04aff61da5d9a7d74 AS module
WORKDIR /build
COPY infra/jena/command-module/pom.xml /build/pom.xml
RUN mvn -B -ntp dependency:go-offline
COPY infra/jena/command-module/src /build/src
COPY services/main/src/modules/query/templates /build/src/test/resources/query-templates/
COPY generated/model/ /build/profiles/
COPY infra/jena/fuseki-text.ttl /build/fuseki-text.ttl
ENV MAVEN_OPTS="-Xmx128m"
ENV JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -XX:ActiveProcessorCount=4 -Djava.io.tmpdir=/build/tmp"
# Fixture databases need a writable disk mount: syncing the image layer can exceed
# their unchanged transaction deadlines. Each fixture still creates a fresh directory.
# ExternalFixture tests need a live SQL fixture. This package build excludes that
# category; the focused wrapper qualifies those original cases separately at this pin.
RUN --mount=type=cache,id=rezics-native-test-files,target=/build/tmp,sharing=locked mvn -B -ntp -DexcludedGroups=com.rezics.jena.ExternalFixture -DargLine=-Xmx384m -DforkCount=1 -DreuseForks=false package

FROM maven:3.9.16-eclipse-temurin-21@sha256:c2a2c58516d160f43b50f12baa427ca86989e0bc942609e04aff61da5d9a7d74 AS distribution
ARG FUSEKI_VERSION=6.2.0
ARG FUSEKI_SHA512=ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132
RUN curl --fail --location --retry 3 \
      "https://archive.apache.org/dist/jena/binaries/apache-jena-fuseki-${FUSEKI_VERSION}.tar.gz" \
      --output /tmp/fuseki.tar.gz \
    && echo "${FUSEKI_SHA512}  /tmp/fuseki.tar.gz" | sha512sum --check - \
    && mkdir -p /opt \
    && tar -xzf /tmp/fuseki.tar.gz -C /opt
# Jena 6.2.0 truncates xsd:integer beyond signed 64 bits in the TDB2 node table; see
# docs/development/toolchain.md. fuseki-server.jar precedes extra/*, so the class is replaced in it.
ARG THRIFT_CONVERT_SHA256=a7917fb253f46c0bef8bde44d66a469087a554abe9a919e0c79d31d1ec12314e
COPY infra/jena/patches/ThriftConvert.java /patches/ThriftConvert.java
RUN set -eu; \
    jar="/opt/apache-jena-fuseki-${FUSEKI_VERSION}/fuseki-server.jar"; \
    class=org/apache/jena/riot/thrift/ThriftConvert.class; \
    mkdir /tmp/original /tmp/patched; \
    (cd /tmp/original && jar xf "$jar" "$class"); \
    echo "${THRIFT_CONVERT_SHA256}  /tmp/original/${class}" | sha256sum --check -; \
    test "$(jar tf "$jar" | grep -c 'org/apache/jena/riot/thrift/ThriftConvert')" = 1; \
    javac --release 21 -proc:none -cp "$jar" -d /tmp/patched /patches/ThriftConvert.java; \
    (cd /tmp/patched && jar uf "$jar" org/apache/jena/riot/thrift/ThriftConvert*.class); \
    (cd /tmp/original && jar xf "$jar" "$class"); \
    if echo "${THRIFT_CONVERT_SHA256}  /tmp/original/${class}" | sha256sum --check --status -; then \
      echo "ThriftConvert was not replaced" >&2; exit 1; fi; \
    rm -rf /tmp/original /tmp/patched

FROM eclipse-temurin:21.0.12_8-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f
ENV FUSEKI_HOME=/opt/apache-jena-fuseki-6.2.0 \
    FUSEKI_BASE=/fuseki \
    MAIN=server-plain \
    JVM_ARGS=-Xms256m\ -Xmx2g
COPY --from=distribution /opt/apache-jena-fuseki-6.2.0 /opt/apache-jena-fuseki-6.2.0
# Includes the pinned Lucene ICU analyzer and ICU4J data for server and indexer.
COPY --from=module /build/target/fuseki-command.jar /fuseki/extra/fuseki-command.jar
COPY infra/jena/fuseki-text.ttl /fuseki/fuseki-text.ttl
COPY infra/jena/fuseki-text-qa.ttl /fuseki/fuseki-text-qa.ttl
COPY --chmod=0755 infra/jena/fuseki-owner.sh /usr/local/bin/fuseki-owner
COPY --chmod=0755 infra/jena/compact-tdb2.sh /usr/local/bin/tdb2-compact
COPY generated/model/manifest.json /fuseki/profiles/manifest.json
COPY generated/model/shapes/ /fuseki/profiles/shapes/
RUN mkdir -p /fuseki/databases/rezics/tdb2 /fuseki/databases/rezics/lucene \
    && chown -R 10001:10001 /fuseki
USER 10001:10001
WORKDIR /fuseki
EXPOSE 3030
ENTRYPOINT ["/usr/local/bin/fuseki-owner"]
CMD ["/opt/apache-jena-fuseki-6.2.0/fuseki-server", "--port=3030", "--no-cors", "--timeout=10000", "--config=/fuseki/fuseki-text.ttl"]
