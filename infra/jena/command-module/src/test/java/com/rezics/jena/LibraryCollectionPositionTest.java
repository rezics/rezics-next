package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.Iterator;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.*;
import org.junit.Test;

public class LibraryCollectionPositionTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri("urn:library:" + value); }
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), CONTROL=uri(CommandPolicy.CONTROL),
        AGENT=id(1), OTHER=id(2), COLLECTION=id(3), STRUCTURE=id(4);
    private static class Counted extends DatasetGraphWrapper implements DatasetGraphWrapperView {
        long rows;
        Counted(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node g,Node s,Node p,Node o) {
            return Iter.map(super.find(g,s,p,o),quad -> { rows++; return quad; });
        }
        @Override public Iterator<Quad> find(Quad q) { return find(q.getGraph(),q.getSubject(),q.getPredicate(),q.getObject()); }
        @Override public Graph getGraph(Node g) { return GraphView.createNamedGraph(this,g); }
    }
    private static String query(Counted data, boolean aggregate) {
        String q=aggregate
            ? "SELECT (SHA256(GROUP_CONCAT(?part;separator=\"|\")) AS ?position) WHERE { { SELECT ?part WHERE { GRAPH <"
                +CommandPolicy.CURRENT+"> { ?id <"+p("curator").getURI()+"> <"+AGENT+"> ; <"
                +p("collectionHead").getURI()+"> ?head . BIND(CONCAT(STR(?id),STR(?head)) AS ?part) } } ORDER BY ?part } }"
            : "SELECT ?position WHERE { GRAPH <"+CommandPolicy.CONTROL+"> { <"+AGENT+"> <"
                +p("libraryCollectionPosition").getURI()+"> ?position } } LIMIT 2";
        try(var execution=QueryExecutionFactory.create(q,DatasetFactory.wrap(data))) {
            var result=execution.execSelect();
            assertTrue(result.hasNext());
            String position=result.next().get("position").toString();
            assertFalse(result.hasNext());
            return position;
        }
    }
    private static void change(DatasetGraph data, java.util.function.Consumer<CommandOverlay> mutate,String receipt) {
        var primary=new CommandOverlay(data);
        mutate.accept(primary);
        var owners=LibraryCollectionPosition.curators(data,primary.additions(),primary.removals());
        primary.apply();
        owners.addAll(LibraryCollectionPosition.curators(data,primary.additions(),primary.removals()));
        LibraryCollectionPosition.advance(data,owners,receipt);
    }
    @Test public void exportFenceReadsOnePositionInsteadOfEveryCollection() {
        for(int size:new int[]{32,128,512}) {
            var data=new Counted(DatasetGraphFactory.createTxnMem());
            data.begin(ReadWrite.WRITE);
            try {
                for(int i=0;i<size;i++) {
                    data.add(CURRENT,id(100+i),p("curator"),AGENT);
                    data.add(CURRENT,id(100+i),p("collectionHead"),id(1000+i));
                }
                LibraryCollectionPosition.advance(data,java.util.Set.of(AGENT),"urn:receipt:seed");
                data.rows=0; query(data,true); long baseline=data.rows;
                data.rows=0; assertEquals("urn:receipt:seed",query(data,false)); long bounded=data.rows;
                assertTrue("old inventory digest must expose the growth",baseline>=size);
                assertEquals(1,bounded);
                data.rows=0;
                change(data,primary -> primary.add(CURRENT,id(100),p("protectionHead"),id(9)),"urn:receipt:protect");
                long writeRows=data.rows;
                assertTrue("one collection mutation must not enumerate the curator's inventory",writeRows<=8);
                System.out.println("library collection fence size="+size+" baselineRows="+baseline+" rows="+bounded+" writeRows="+writeRows);
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void positionsFollowStructureProtectionRenameTransferAndRemoval() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            change(data,primary -> {
                primary.add(CURRENT,COLLECTION,p("curator"),AGENT);
                primary.add(CURRENT,STRUCTURE,p("structureOf"),COLLECTION);
            },"urn:receipt:create");
            assertTrue(data.contains(CONTROL,AGENT,p("libraryCollectionPosition"),uri("urn:receipt:create")));
            for(String predicate:new String[]{"selectedGeneration","protectionHead","http://schema.org/name"}) {
                Node subject=predicate.equals("selectedGeneration")?STRUCTURE:COLLECTION;
                change(data,primary -> primary.add(CURRENT,subject,p(predicate),id(9)),"urn:receipt:"+predicate);
                assertTrue(data.contains(CONTROL,AGENT,p("libraryCollectionPosition"),uri("urn:receipt:"+predicate)));
            }
            change(data,primary -> {
                primary.delete(CURRENT,COLLECTION,p("curator"),AGENT);
                primary.add(CURRENT,COLLECTION,p("curator"),OTHER);
            },"urn:receipt:transfer");
            for(Node owner:new Node[]{AGENT,OTHER})
                assertTrue(data.contains(CONTROL,owner,p("libraryCollectionPosition"),uri("urn:receipt:transfer")));
            change(data,primary -> primary.deleteAny(CURRENT,COLLECTION,Node.ANY,Node.ANY),"urn:receipt:delete");
            assertTrue(data.contains(CONTROL,OTHER,p("libraryCollectionPosition"),uri("urn:receipt:delete")));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
