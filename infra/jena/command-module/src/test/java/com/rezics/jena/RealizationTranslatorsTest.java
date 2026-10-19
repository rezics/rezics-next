package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.sparql.expr.ExprEvalException;
import org.apache.jena.sparql.expr.NodeValue;
import org.apache.jena.sparql.function.FunctionRegistry;
import org.junit.Test;

public class RealizationTranslatorsTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static String id(int n) { return "https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", n); }
    private static NodeValue iri(int n) { return NodeValue.makeNode(NodeFactory.createURI(id(n))); }
    private static String state(int text, int work, String translators) {
        return "{\"profile\":\"realization-v1\",\"id\":\""+id(text)+"\",\"work\":\""+id(work)+"\",\"translators\":"+translators+"}";
    }
    private static String agents(int... ids) {
        return "["+java.util.Arrays.stream(ids).mapToObj(n -> "\""+id(n)+"\"").collect(java.util.stream.Collectors.joining(","))+"]";
    }

    @Test public void immutablePropertyIsBoundedAndUnknownIsNotAnEmptyTranslatorSet() {
        var function = new RealizationTranslators();
        assertEquals(id(5), function.exec(NodeValue.makeString(state(2,1,agents(5))),iri(2),iri(1)).getString());
        assertEquals("", function.exec(NodeValue.makeString(state(2,1,"[]")),iri(2),iri(1)).getString());
        for (String invalid : List.of("{}",state(2,3,agents(5)),state(3,1,agents(5)),state(2,1,agents(5,5)),
            state(2,1,"[\"https://provider.example/agent\"]"),state(2,1,"null"),"x".repeat(8193),
            state(2,1,agents(java.util.stream.IntStream.range(20,37).toArray())))) {
            assertThrows(ExprEvalException.class, () -> function.exec(NodeValue.makeString(invalid),iri(2),iri(1)));
        }
    }

    @Test public void sameReleaseAndSameWorkEntryUseTheCoveredRevisionAfterItsCurrentHeadChanges() {
        var functions = FunctionRegistry.get();
        String name = RV+"realizationTranslators";
        var prior = functions.get(name); functions.put(name,RealizationTranslators.class);
        var data = DatasetFactory.createTxnMem();
        try {
            var current = data.getNamedModel("urn:test:current");
            var revisions = data.getNamedModel("urn:test:revisions");
            java.util.function.BiFunction<Integer,String,org.apache.jena.rdf.model.Property> p = (ignored,predicate) -> current.createProperty(RV+predicate);
            // Release 10 is the positive: its pinned old text names translator 5,
            // while the mutable text head now names translator 6.
            int[][] entries = { {10,20,2,30,1}, {11,21,3,31,1}, {12,22,4,32,1},
                {13,23,7,33,1}, {14,24,8,34,1}, {14,25,9,35,99}, {15,26,16,36,1} };
            for (int[] row : entries) {
                var release = current.createResource(id(row[0]));
                release.addProperty(p.apply(0,"coverage"),current.createResource(id(row[1])));
                release.addLiteral(p.apply(0,"platform"),row[0]==12 ? "Switch" : "Windows");
                release.addLiteral(p.apply(0,"releaseStatus"),"official");
                var entry = current.createResource(id(row[1]));
                entry.addProperty(p.apply(0,"work"),current.createResource(id(row[4])));
                entry.addProperty(p.apply(0,"realization"),current.createResource(id(row[2])));
                entry.addProperty(p.apply(0,"revision"),current.createResource(id(row[3])));
                entry.addLiteral(p.apply(0,"contentLanguage"),row[0]==13 ? "ja" : "en");
                entry.addLiteral(p.apply(0,"completeness"),"complete");
                var text = current.createResource(id(row[2]));
                text.addProperty(p.apply(0,"work"),current.createResource(id(row[4])));
                text.addProperty(p.apply(0,"head"),current.createResource(id(100+row[2])));
                text.addProperty(p.apply(0,"translator"),current.createResource(id(6)));
                var revision = revisions.createResource(id(row[3]));
                revision.addProperty(p.apply(0,"component"),revisions.createResource(id(row[2])));
                revision.addLiteral(p.apply(0,"realizationState"),row[0]==15 ? "{}"
                    : state(row[2],row[4],agents(row[0]==11 || row[1]==24 ? 6 : 5)));
            }
            // 11 has the wrong translator, 12 the right translator on the wrong
            // platform, 13 the wrong language, 14 that translator on another
            // Work's coverage entry, 15 unknown immutable state.
            String body = "PREFIX rv:<"+RV+"> SELECT DISTINCT ?release WHERE { GRAPH <urn:test:current> {"
                + "?release rv:platform \"Windows\";rv:releaseStatus \"official\";rv:coverage ?entry. "
                + "?entry rv:work <"+id(1)+">;rv:contentLanguage \"en\";rv:completeness \"complete\";"
                + "rv:realization ?text;rv:revision ?revision. ?text rv:work <"+id(1)+">. }"
                + "GRAPH <urn:test:revisions> {?revision rv:component ?text;rv:realizationState ?state.}"
                + "BIND(rv:realizationTranslators(?state,?text,<"+id(1)+">) AS ?translators)"
                + "FILTER(BOUND(?translators) && %sCONTAINS(CONCAT(\" \",?translators,\" \"),\" "+id(5)+" \")) } ORDER BY ?release";
            try (var read = QueryExecutionFactory.create(body.formatted(""),data)) {
                var rows = read.execSelect(); assertTrue(rows.hasNext());
                assertEquals(id(10),rows.next().getResource("release").getURI()); assertFalse(rows.hasNext());
            }
            try (var read = QueryExecutionFactory.create(body.formatted("!"),data)) {
                var rows = read.execSelect();
                assertEquals(id(11),rows.next().getResource("release").getURI());
                assertEquals(id(14),rows.next().getResource("release").getURI()); assertFalse(rows.hasNext());
            }
        } finally { data.close(); if (prior == null) functions.remove(name); else functions.put(name,prior); }
    }
}
