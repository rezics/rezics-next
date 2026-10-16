package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.junit.Test;

public class PublicationDependencyUpgradeTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }

    @Test public void retainedLinksKeepTheirExactSelectorsAndUpgradeOnlyOnce() {
        var data = DatasetFactory.createTxnMem().asDatasetGraph();
        var graph = uri(CommandPolicy.REVISIONS);
        var type = uri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
        Node source = uri("urn:test:publication"), dependency = uri("urn:test:dependency");
        Node unrelated = uri("urn:test:unrelated"), selector = uri("urn:test:exact-revision");
        var legacy = uri("https://schema.org/recipeInstructions");
        var neutral = uri("https://rezics.com/vocab/publicationDependency");
        data.begin(ReadWrite.WRITE);
        try {
            data.add(graph, source, type, uri("https://rezics.com/vocab/WorkStructurePublicSource"));
            data.add(graph, dependency, type, uri("http://www.w3.org/ns/oa#SpecificResource"));
            data.add(graph, source, legacy, dependency);
            data.add(graph, dependency, uri("http://www.w3.org/ns/oa#hasSelector"), selector);
            data.add(graph, unrelated, legacy, dependency);
            PublicationDependencyUpgrade.apply(data);
            assertTrue(data.contains(graph, source, neutral, dependency));
            assertTrue(data.contains(graph, source, legacy, dependency));
            assertTrue(data.contains(graph, dependency, uri("http://www.w3.org/ns/oa#hasSelector"), selector));
            assertFalse(data.contains(graph, unrelated, neutral, dependency));
            long size = data.stream().count();
            PublicationDependencyUpgrade.apply(data);
            assertEquals(size, data.stream().count());
        } finally { data.abort(); data.end(); data.close(); }
    }
}
