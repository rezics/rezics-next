package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class g1035WriteWorkTest {
    @Test public void compiledShapeChecksOnlyItsFocusButRetainsNestedAndSparqlConstraints() {
        var shapes = org.apache.jena.rdf.model.ModelFactory.createDefaultModel();
        org.apache.jena.riot.RDFParser.fromString("""
            @prefix sh: <http://www.w3.org/ns/shacl#> .
            @prefix x: <urn:test:> .
            x:root a sh:NodeShape ; sh:property [ sh:path x:value ; sh:minCount 1 ; sh:node x:nested ] .
            x:nested a sh:NodeShape ; sh:property [ sh:path x:name ; sh:minCount 1 ] ;
                sh:sparql [ sh:select "SELECT $this WHERE { $this <urn:test:name> \\\"denied\\\" }" ] .
            """, org.apache.jena.riot.Lang.TTL).parse(shapes);
        var profile = new ProfileRegistry.Profile("test", shapes, null);
        var data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node graph = g939PublicNamesTest.CURRENT, focus = g939PublicNamesTest.uri("urn:test:focus"),
                child = g939PublicNamesTest.uri("urn:test:child"), name = g939PublicNamesTest.uri("urn:test:name");
            data.add(graph, focus, g939PublicNamesTest.uri("urn:test:value"), child);
            data.add(graph, child, name, NodeFactory.createLiteralString("allowed"));
            var validation = new CommandService.Validation("test", profile, "urn:test:root", List.of(focus.getURI()), List.of(CommandPolicy.CURRENT), Map.of());
            assertNull(CommandService.validateOne(data, validation));
            // An unrelated malformed subject is not a population scan target.
            data.add(graph, g939PublicNamesTest.uri("urn:test:unrelated"), RDF.type.asNode(), g939PublicNamesTest.uri("urn:test:root"));
            assertNull(CommandService.validateOne(data, validation));
            data.deleteAny(graph, child, name, Node.ANY);
            assertEquals("invalid", CommandService.validateOne(data, validation).get("status"));
            data.add(graph, child, name, NodeFactory.createLiteralString("denied"));
            assertEquals("invalid", CommandService.validateOne(data, validation).get("status"));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void validatingUnchangedNamesDoesNotRewriteDocumentsOrDirectoryOrder() {
        var data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node space = g939PublicNamesTest.id(1);
            var current = g939PublicNamesTest.CURRENT;
            var control = g939PublicNamesTest.uri(CommandPolicy.CONTROL);
            var product = g939PublicNamesTest.uri("urn:rezics:dataset:product");
            var sequence = g939PublicNamesTest.p("sequence");
            g939PublicNamesTest.name(data, space, "Space");
            data.add(current, space, g939PublicNamesTest.p("disclosure"), g939PublicNamesTest.p("Public"));
            data.add(control, product, sequence, NodeFactory.createLiteralString("1"));
            PublicNameProjection.refresh(data, space);
            var before = org.apache.jena.atlas.iterator.Iter.toList(data.find(g939PublicNamesTest.PUBLIC, Node.ANY, Node.ANY, Node.ANY));
            data.deleteAny(control, product, sequence, Node.ANY);
            data.add(control, product, sequence, NodeFactory.createLiteralString("2"));
            var plan = new CommandPolicy.Plan(null, Set.of(), Set.of(), Set.of(), Set.of(), false, false, true);
            var validation = new CommandService.Validation("test", null, "test", List.of(space.getURI()), List.of(CommandPolicy.CURRENT), Map.of());
            try (var work = new CommandWork()) {
                PublicNameProjection.refresh(work.observed(data), plan, "urn:receipt:test", List.of(validation), List.of());
                assertTrue(work.counters().contains("other_adds=0"));
                assertTrue(work.counters().contains("other_deletes=0"));
                assertEquals(Set.copyOf(before), Set.copyOf(org.apache.jena.atlas.iterator.Iter.toList(data.find(g939PublicNamesTest.PUBLIC, Node.ANY, Node.ANY, Node.ANY))));
            }
            // A real rename updates the index; private transitions remove every
            // name and directory entry rather than preserving stale payloads.
            data.deleteAny(current, space, g939PublicNamesTest.uri("http://www.w3.org/2000/01/rdf-schema#label"), Node.ANY);
            data.add(current, space, g939PublicNamesTest.uri("http://www.w3.org/2000/01/rdf-schema#label"), NodeFactory.createLiteralLang("New name", "ar"));
            PublicNameProjection.refresh(data, space);
            var unit = g939PublicNamesTest.nameUnit(space, "space");
            assertFalse(data.contains(g939PublicNamesTest.PUBLIC, unit, g939PublicNamesTest.p("publicTitle"), NodeFactory.createLiteralLang("Camp Lanterns", "en")));
            assertTrue(data.contains(g939PublicNamesTest.PUBLIC, unit, g939PublicNamesTest.p("publicTitle"), NodeFactory.createLiteralLang("New name", "ar")));
            data.deleteAny(current, space, g939PublicNamesTest.p("disclosure"), Node.ANY);
            data.add(current, space, g939PublicNamesTest.p("disclosure"), g939PublicNamesTest.p("Private"));
            PublicNameProjection.refresh(data, space);
            assertFalse(data.find(g939PublicNamesTest.PUBLIC, Node.ANY, Node.ANY, Node.ANY).hasNext());
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void nativeCountersMeasureUtf8PayloadAndNeverExportItsValue() {
        var data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try (var work = new CommandWork()) {
            work.observed(data).add(g939PublicNamesTest.CURRENT, g939PublicNamesTest.id(1), RDF.type.asNode(), NodeFactory.createLiteralString("秘密"));
            assertTrue(work.counters().contains("current_literal_bytes=6"));
            assertTrue(work.counters().contains("max_literal_bytes=6"));
            assertFalse(work.counters().contains("秘密"));
            assertTrue(work.serverTiming().startsWith("jena;dur="));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
