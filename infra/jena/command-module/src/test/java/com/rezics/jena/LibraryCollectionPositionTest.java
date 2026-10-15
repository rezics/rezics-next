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
import org.apache.jena.tdb2.TDB2Factory;

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
    @Test public void exportPagesSeekPhysicalWindowsAcrossCollectionsAndLongMemberships() throws Exception {
        Node agent=uri("https://rezics.com/id/00000000-0000-4000-8000-000000000001");
        for(int size:new int[]{32,128,512}) {
            var path=java.nio.file.Files.createTempDirectory("library-export-page-");
            var store=TDB2Factory.connectDataset(path.toString());
            var data=store.asDatasetGraph();
            try {
                data.begin(ReadWrite.WRITE);
                Node control=uri(CommandPolicy.CONTROL),dataset=uri("urn:rezics:dataset:product");
                data.add(control,dataset,p("dataEpoch"),NodeFactory.createLiteralString("epoch"));
                data.add(control,dataset,p("sequence"),NodeFactory.createLiteralString("1"));
                for(int i=0;i<=size;i++) {
                    Node collection=id(100+i),structure=id(10000+i),generation=id(20000+i);
                    data.add(CURRENT,collection,org.apache.jena.vocabulary.RDF.type.asNode(),p("Collection"));
                    data.add(CURRENT,collection,p("curator"),agent);
                    data.add(CURRENT,collection,p("collectionState"),p("Active"));
                    data.add(CURRENT,collection,p("disclosure"),p("Private"));
                    data.add(CURRENT,collection,uri("https://schema.org/name"),NodeFactory.createLiteralString("Shelf "+i));
                    data.add(CURRENT,collection,p("structure"),structure);
                    data.add(CURRENT,structure,p("selectedGeneration"),generation);
                }
                for(int i=0;i<size;i++) {
                    Node placement=id(30000+i);
                    data.add(CURRENT,placement,p("generation"),id(20000));
                    data.add(CURRENT,placement,p("occurrenceRole"),p(i==0?"GroupRole":"MemberRole"));
                    data.add(CURRENT,placement,uri("https://schema.org/item"),id(40000+i));
                    if(i==1) data.add(CURRENT,placement,p("removedBy"),id(50000));
                }
                data.commit();data.end();
                var counted=new Counted(data);counted.begin(ReadWrite.READ);
                try(var execution=QueryExecutionFactory.create("SELECT ?id WHERE { GRAPH <"+CommandPolicy.CURRENT
                    +"> { ?id <"+p("curator").getURI()+"> <"+agent+"> } } ORDER BY STR(?id) LIMIT 21",DatasetFactory.wrap(counted))) {
                    var results=execution.execSelect();while(results.hasNext()) results.next();
                } finally { counted.end(); }
                assertTrue(counted.rows>=size);
                long[] firstRows=new long[2];
                for(int phase:new int[]{4,5}) {
                    String after="";int delivered=0,pages=0;
                    var seen=new java.util.HashSet<String>();
                    while(true) {
                        var request=CommandService.jsonObject(java.util.Map.of("operation","library-export-page","agent",agent.getURI(),
                            "phase",phase,"after",after,"limit",21));
                        var result=LibraryCollectionPage.read(data,request);
                        @SuppressWarnings("unchecked") var rows=(java.util.List<java.util.Map<String,Object>>)result.get("rows");
                        int examined=(Integer)result.get("examined");
                        assertTrue("native RDF rows stay within the requested window",examined<=21*7);
                        if(pages++==0) firstRows[phase-4]=examined;
                        for(var row:rows) {
                            if(!row.get("kind").equals("skip")) { delivered++;assertTrue(seen.add(row.get(phase==4?"collection":"placement").toString())); }
                        }
                        if(rows.size()<21) break;
                        after=rows.getLast().get("key").toString();
                        assertTrue(pages<1000);
                    }
                    assertEquals(phase==4?size+1:size-2,delivered);
                }
                System.out.println("library collection page size="+size+" oldSortedRows="+counted.rows
                    +" shelfRows="+firstRows[0]+" membershipRows="+firstRows[1]);
            } finally {
                store.close();
                try(var paths=java.nio.file.Files.walk(path)) {
                    for(var item:paths.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.delete(item);
                }
            }
        }
    }
}
