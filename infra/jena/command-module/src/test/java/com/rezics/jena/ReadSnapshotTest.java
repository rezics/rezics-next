package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Counterexamples for G-336: retaining TDB alone is not a retained read API. */
public class ReadSnapshotTest {
    static final Node GRAPH = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    static final Node ITEM = NodeFactory.createURI("urn:rezics:snapshot-probe:item");
    static final Node BODY = NodeFactory.createURI("https://rezics.com/vocab/searchBody");
    static final Node OLD = NodeFactory.createLiteralString("before");
    static final Node NEW = NodeFactory.createLiteralString("after");

    static void replace(DatasetGraph data, Node before, Node after) {
        data.begin(ReadWrite.WRITE);
        try {
            if (before != null) data.delete(GRAPH, ITEM, BODY, before);
            if (after != null) data.add(GRAPH, ITEM, BODY, after);
            data.commit();
        } finally { data.end(); }
    }

    @Test public void nativeTdbReadRetainsOldValuesAndDeletionsButOnlyOnItsOwningThread() throws Exception {
        var directory = Files.createTempDirectory("read-snapshot-test-");
        DatasetGraph data = TDB2Factory.connectDataset(directory.toString()).asDatasetGraph();
        try (var writer = Executors.newSingleThreadExecutor()) {
            replace(data, null, OLD);
            data.begin(ReadWrite.READ);
            try {
                assertTrue(data.contains(GRAPH, ITEM, BODY, OLD));
                writer.submit(() -> replace(data, OLD, NEW)).get(5, TimeUnit.SECONDS);
                assertTrue(data.contains(GRAPH, ITEM, BODY, OLD));
                assertFalse(data.contains(GRAPH, ITEM, BODY, NEW));
                // Passing the dataset object to another HTTP worker does not pass its transaction.
                assertTrue(writer.submit(() -> {
                    data.begin(ReadWrite.READ);
                    try { return data.contains(GRAPH, ITEM, BODY, NEW); }
                    finally { data.end(); }
                }).get(5, TimeUnit.SECONDS));
                writer.submit(() -> replace(data, NEW, null)).get(5, TimeUnit.SECONDS);
                assertTrue("a retained graph also retains erased data", data.contains(GRAPH, ITEM, BODY, OLD));
            } finally { data.end(); }
            data.begin(ReadWrite.READ);
            try { assertFalse(data.contains(GRAPH, ITEM, BODY, Node.ANY)); }
            finally { data.end(); }
        } finally { data.close(); }
    }

    @Test public void retainedTdbDoesNotRetainTheProductionTextReader() throws Exception {
        var directory = Files.createTempDirectory("read-snapshot-text-test-");
        EntityDefinition definition = new EntityDefinition("uri", "text", "graph");
        definition.set("text", BODY);
        definition.setUidField("uid");
        TextIndexConfig config = new TextIndexConfig(definition);
        config.setValueStored(true);
        TextIndexLucene lucene = new TextIndexLucene(new ByteBuffersDirectory(), config);
        FilteredGraphTextIndex index = new FilteredGraphTextIndex(lucene);
        DatasetGraph data = new DatasetGraphText(TDB2Factory.connectDataset(directory.toString()).asDatasetGraph(),
            index, new TextDocProducerTriples(index));
        try (var writer = Executors.newSingleThreadExecutor()) {
            replace(data, null, OLD);
            data.begin(ReadWrite.READ);
            try {
                assertEquals(1, index.query(BODY, "before", GRAPH.getURI(), null, 10).size());
                writer.submit(() -> replace(data, OLD, NEW)).get(5, TimeUnit.SECONDS);
                assertTrue(data.contains(GRAPH, ITEM, BODY, OLD));
                assertEquals("text query sees the new committed Lucene reader", 0,
                    index.query(BODY, "before", GRAPH.getURI(), null, 10).size());
                assertEquals(1, index.query(BODY, "after", GRAPH.getURI(), null, 10).size());
            } finally { data.end(); }
        } finally { data.close(); }
    }
}
