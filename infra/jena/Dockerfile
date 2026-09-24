FROM maven:3.9.16-eclipse-temurin-21@sha256:c2a2c58516d160f43b50f12baa427ca86989e0bc942609e04aff61da5d9a7d74 AS distribution

ARG FUSEKI_VERSION=6.2.0
ARG FUSEKI_SHA512=ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132
RUN curl --fail --location --retry 3 \
      "https://archive.apache.org/dist/jena/binaries/apache-jena-fuseki-${FUSEKI_VERSION}.tar.gz" \
      --output /tmp/fuseki.tar.gz \
    && echo "${FUSEKI_SHA512}  /tmp/fuseki.tar.gz" | sha512sum --check - \
    && mkdir -p /opt \
    && tar -xzf /tmp/fuseki.tar.gz -C /opt

FROM eclipse-temurin:21.0.12_8-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f

ENV FUSEKI_HOME=/opt/apache-jena-fuseki-6.2.0 \
    FUSEKI_BASE=/fuseki \
    MAIN=main \
    JVM_ARGS=-Xms256m\ -Xmx2g
COPY --from=distribution /opt/apache-jena-fuseki-6.2.0 /opt/apache-jena-fuseki-6.2.0
COPY infra/jena/fuseki-text.ttl /fuseki/fuseki-text.ttl
RUN mkdir -p /fuseki/databases/rezics/tdb2 /fuseki/databases/rezics/lucene /fuseki/extra /fuseki/profiles \
    && chown -R 10001:10001 /fuseki
USER 10001:10001
WORKDIR /fuseki
EXPOSE 3030
CMD ["/opt/apache-jena-fuseki-6.2.0/fuseki-server", "--port=3030", "--no-cors", "--timeout=10000", "--config=/fuseki/fuseki-text.ttl"]
