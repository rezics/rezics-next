package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** A maintenance reset deletes the text generation, so the startup audit cannot
 * admit inside that write. The process that already proved exclusivity admits
 * again when the fresh graph is stored. A process that did not prove it refuses. */
public class DatasetResetAdmissionTest {
    private static final Node CONTROL = NodeFactory.createURI(CommandPolicy.CONTROL);
    private static final Node PRODUCT = NodeFactory.createURI("urn:rezics:dataset:product");
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node ANCHOR = NodeFactory.createURI(CommandPolicy.PUBLIC_ANCHOR);
    private static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
    private static Node vocab(String name) { return NodeFactory.createURI("https://rezics.com/vocab/" + name); }
    private static Node integer(String value) {
        return NodeFactory.createLiteralByValue(new BigInteger(value), XSDDatatype.XSDinteger);
    }

    @Test public void exclusiveStartupAdmitsAgainAfterTheFreshGraphAndPreparesTheDirectory() {
        try (Store store = new Store()) {
            store.seed();
            configuredStartup(store.data, null);
            assertTrue(store.admitted());
            DatasetResetPolicy.reset(store.data);
            assertFalse("the reset withdraws the writer with the generation", store.admitted());
            assertFalse("startup qualification needs a stored text generation",
                SearchDeltaJournal.qualifyAtStartup(store.data));
            store.seed();
            long before = System.nanoTime();
            assertTrue(SearchDeltaJournal.qualify(store.data));
            long readmitMs = Math.max(SearchDeltaJournal.deferredAdmissionNanos(), System.nanoTime() - before) / 1_000_000L;
            assertTrue(store.admitted());
            assertTrue(store.semanticQualified());
            store.write(() -> {
                assertEquals(0, PublicNameProjection.prepareWorkScopeDirectory(store.data));
                assertEquals("complete", PublicNameProjection.workScopeDirectoryPhase(store.data));
                return null;
            });
            System.out.println("dataset-reset-admission exclusiveReadmitMs=" + readmitMs);
            assertTrue("in-process admission replaces the Fuseki restart", readmitMs < 2_000);
        }
    }

    @Test public void nonexclusiveStartupRefusesAdmissionAfterTheFreshGraph() {
        try (Store store = new Store()) {
            store.seed();
            configuredStartup(store.data, "http://jena.apache.org/fuseki#update");
            assertFalse(store.admitted());
            DatasetResetPolicy.reset(store.data);
            store.seed();
            assertTrue("the generation audit still succeeds", SearchDeltaJournal.qualify(store.data));
            assertFalse(store.admitted());
            assertThrows(IllegalStateException.class, () -> store.write(() ->
                PublicNameProjection.prepareWorkScopeDirectory(store.data)));
            System.out.println("dataset-reset-admission nonexclusiveRefused=true");
        }
    }

    /** Parse the production endpoint configuration and run the real startup callback. */
    private static void configuredStartup(DatasetGraph data, String additionalOperation) {
        var model = org.apache.jena.riot.RDFDataMgr.loadModel("fuseki-text.ttl");
        String previous = System.getProperty("rezics.profiles");
        System.setProperty("rezics.profiles", "profiles");
        try {
            var module = new CommandModule();
            var service = model.listResourcesWithProperty(RDF.type,
                model.createResource("http://jena.apache.org/fuseki#Service")).nextResource();
            var dataset = service.getPropertyResourceValue(model.createProperty("http://jena.apache.org/fuseki#dataset"));
            if (additionalOperation != null) {
                var endpoint = model.createResource()
                    .addProperty(model.createProperty("http://jena.apache.org/fuseki#operation"), model.createResource(additionalOperation))
                    .addProperty(model.createProperty("http://jena.apache.org/fuseki#name"), "maintenance");
                service.addProperty(model.createProperty("http://jena.apache.org/fuseki#endpoint"), endpoint);
            }
            var descriptions = new org.apache.jena.fuseki.build.DatasetDescriptionMap();
            descriptions.register(dataset.asNode(), data);
            var point = org.apache.jena.fuseki.build.FusekiConfig.buildDataAccessPoint(
                model.getGraph(), service.asNode(), descriptions);
            assertNotNull(point);
            assertSame(data, point.getDataService().getDataset());
            assertEquals(additionalOperation == null, CommandService.deltaExclusive(point.getDataService()));
            module.configDataAccessPoint(point, model);
        } finally {
            if (previous == null) System.clearProperty("rezics.profiles");
            else System.setProperty("rezics.profiles", previous);
            model.close();
        }
    }

    private static final class Store implements AutoCloseable {
        final DatasetGraphText data;
        Store() {
            var definition = new EntityDefinition("uri", "publicTitle", "graph");
            definition.set("publicTitle", vocab("publicTitle"));
            definition.setUidField("uid");
            var config = new TextIndexConfig(definition);
            config.setValueStored(true);
            var index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            data = new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),
                index, new TextDocProducerTriples(index));
        }
        void seed() {
            write(() -> {
                data.add(CONTROL, PRODUCT, vocab("dataEpoch"), NodeFactory.createLiteralString("fresh-epoch"));
                data.add(CONTROL, PRODUCT, vocab("routingEpoch"), NodeFactory.createLiteralString("fresh-routing"));
                data.add(CONTROL, PRODUCT, vocab("sequence"), integer("0"));
                data.add(CONTROL, PRODUCT, vocab("textIndexGeneration"), NodeFactory.createURI(GENERATION));
                data.add(PUBLIC, ANCHOR, RDF.type.asNode(), vocab("SearchGraphAnchor"));
                SearchDeltaJournal.initialize(data);
                return null;
            });
        }
        <T> T write(java.util.function.Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T result = operation.get(); data.commit(); return result; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; }
            finally { data.end(); }
        }
        boolean admitted() {
            data.begin(ReadWrite.READ);
            try { return TemplateIndexService.workScopeWriterAdmitted(data); }
            finally { data.end(); }
        }
        boolean semanticQualified() {
            data.begin(ReadWrite.READ);
            try {
                return data.contains(PublicNameProjection.REPAIR,
                    NodeFactory.createURI("urn:rezics:projection:semantic-source-basis"),
                    vocab("semanticSourceQualification"), Node.ANY);
            } finally { data.end(); }
        }
        @Override public void close() { SearchDeltaJournal.stopRecovery(data); data.close(); }
    }
}
