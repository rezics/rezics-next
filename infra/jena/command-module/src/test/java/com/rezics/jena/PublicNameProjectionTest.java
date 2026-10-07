package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class PublicNameProjectionTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static final Node CURRENT=uri(CommandPolicy.CURRENT), PUBLIC=uri(CommandPolicy.PUBLIC_SEARCH),
        LABEL=uri("http://www.w3.org/2000/01/rdf-schema#label"),
        IN_SCHEME=uri("http://www.w3.org/2004/02/skos/core#inScheme"),
        SPACE=id(1), REALM=id(2), SCHEME=id(3);
    private static Node unit(Node resource, String kind) {
        return uri(PublicNameProjection.PREFIX+kind+":"+resource.getURI().substring("https://rezics.com/id/".length()));
    }
    private static CommandPolicy.Plan plan(Node parent) {
        return new CommandPolicy.Plan(null,Set.of(),Set.of(parent.getURI()),Set.of(),Set.of(),false,false,true);
    }
    private static void refresh(DatasetGraph data, Node parent, String receipt) {
        PublicNameProjection.refresh(data,plan(parent),receipt,List.of(),List.of());
    }
    private static void set(DatasetGraph data, Node subject, String predicate, Node value) {
        data.deleteAny(CURRENT,subject,p(predicate),Node.ANY);
        if (value!=null) data.add(CURRENT,subject,p(predicate),value);
    }
    private static void space(DatasetGraph data) {
        data.add(CURRENT,SPACE,RDF.type.asNode(),p("Space"));
        data.add(CURRENT,SPACE,LABEL,NodeFactory.createLiteralLang("Lantern parent","en"));
        data.add(CURRENT,SPACE,p("disclosure"),p("Public"));
        data.add(uri(CommandPolicy.CONTROL),uri("urn:rezics:dataset:product"),p("sequence"),NodeFactory.createLiteralString("1"));
        PublicNameProjection.refresh(data,SPACE);
    }
    private static void realm(DatasetGraph data, Node resource) {
        data.add(CURRENT,resource,RDF.type.asNode(),p("Realm"));
        data.add(CURRENT,resource,p("space"),SPACE);
        data.add(CURRENT,resource,p("realmState"),p("Active"));
        PublicNameProjection.refresh(data,resource);
    }
    private static void concept(DatasetGraph data, Node resource, Node predicate, Node parent) {
        data.add(CURRENT,resource,RDF.type.asNode(),uri("http://www.w3.org/2004/02/skos/core#Concept"));
        data.add(CURRENT,resource,LABEL,NodeFactory.createLiteralLang("Lantern concept","en"));
        data.add(CURRENT,resource,p("conceptState"),p("Active"));
        data.add(CURRENT,resource,predicate,parent);
        PublicNameProjection.refresh(data,resource);
    }
    private static boolean stored(DatasetGraph data, Node resource, String kind) {
        return data.contains(PUBLIC,unit(resource,kind),p("publicTitle"),Node.ANY);
    }
    private static class Counted extends DatasetGraphWrapper {
        long probes, rows, mutations;
        Counted(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            probes++;
            if (g.equals(CURRENT) && s.equals(Node.ANY)
                && Set.of(PublicNameProjectionTest.p("space"),PublicNameProjectionTest.p("conceptRealm"),IN_SCHEME).contains(p))
                fail("parent writes must not open a dependent population iterator");
            return org.apache.jena.atlas.iterator.Iter.map(super.find(g,s,p,o), q -> { rows++; return q; });
        }
        @Override public void add(Quad q) { mutations++; super.add(q); }
        @Override public void delete(Quad q) { mutations++; super.delete(q); }
        @Override public void add(Node g,Node s,Node p,Node o) { mutations++; super.add(g,s,p,o); }
        @Override public void delete(Node g,Node s,Node p,Node o) { mutations++; super.delete(g,s,p,o); }
    }
    private static List<Long> parentWork(int population, String relation) {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            Node parent=relation.equals("space")?SPACE:relation.equals("conceptRealm")?REALM:SCHEME;
            for (int i=0;i<population;i++) {
                if (relation.equals("space")) realm(data,id(100+i));
                else concept(data,id(100+i),relation.equals("conceptRealm")?p(relation):IN_SCHEME,parent);
            }
            if (relation.equals("inScheme")) set(data,parent,"schemeState",p("Retired"));
            else set(data,parent,"listing",NodeFactory.createLiteralString("unlisted"));
            var counted=new Counted(data);
            refresh(counted,parent,"urn:receipt:parent-withdrawal");
            assertTrue(stored(data,id(100),relation.equals("space")?"realm":"concept"));
            assertFalse(PublicNameProjection.visible(data,id(100)));
            return List.of(counted.probes,counted.rows,counted.mutations);
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void parentWritesHaveConstantWorkAcrossEveryDependentPopulation() {
        for (String relation:List.of("space","conceptRealm","inScheme"))
            assertEquals(relation,parentWork(1,relation),parentWork(513,relation));
    }
    @Test public void repairResumesCommittedBatchesRollsBackInterruptionAndReplaysNoOp() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data);
            for (int i=0;i<150;i++) realm(data,id(100+i));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted"));
            refresh(data,SPACE,"urn:receipt:withdraw"); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-one"));
            assertEquals(86,storedRealms(data,150)); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-interrupted"));
            data.abort();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(86,storedRealms(data,150));
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-interrupted"));
            assertEquals(22,storedRealms(data,150));
            var counted=new Counted(data);
            assertEquals(0,PublicNameProjection.repairBatch(counted,"urn:receipt:repair-one"));
            assertEquals(0,counted.mutations);
            assertEquals(22,PublicNameProjection.repairBatch(data,"urn:receipt:repair-last"));
            assertEquals(0,storedRealms(data,150)); data.commit();
        } finally { data.end(); data.close(); }
    }
    private static int storedRealms(DatasetGraph data,int count) {
        int result=0; for (int i=0;i<count;i++) if (stored(data,id(100+i),"realm")) result++; return result;
    }
    @Test public void newerParentGenerationRestartsPendingRepairAndRestoresEveryDependent() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); for (int i=0;i<150;i++) realm(data,id(100+i));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertEquals(64,PublicNameProjection.repairBatch(data,"urn:receipt:repair-withdraw"));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed")); refresh(data,SPACE,"urn:receipt:restore");
            for (int i=0;i<3;i++) assertTrue(PublicNameProjection.repairBatch(data,"urn:receipt:repair-restore:"+i)<=64);
            assertEquals(150,storedRealms(data,150));
            for (int i=0;i<150;i++) assertTrue(PublicNameProjection.visible(data,id(100+i)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void cascadesUseTheExistingMaintenanceEntryPointAndRespectMovedOrDeletedDependents() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            for (int i=0;i<150;i++) concept(data,id(100+i),p("conceptRealm"),REALM);
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertFalse(PublicNameProjection.visible(data,id(100)));
            for (int i=0;i<4;i++) PublicNameProjection.refresh(data,
                new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true),
                "urn:rezics:receipt:catalogue-search-index:repair:"+i,List.of(),List.of());
            for (int i=0;i<150;i++) assertFalse(stored(data,id(100+i),"concept"));
            data.deleteAny(CURRENT,id(100),Node.ANY,Node.ANY);
            set(data,id(101),"conceptRealm",null);
            PublicNameProjection.refresh(data,id(101));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed")); refresh(data,SPACE,"urn:receipt:restore");
            for (int i=0;i<4;i++) PublicNameProjection.repairBatch(data,"urn:receipt:restore-batch:"+i);
            assertFalse(stored(data,id(100),"concept"));
            assertTrue(PublicNameProjection.visible(data,id(101)));
            for (int i=2;i<150;i++) assertTrue(PublicNameProjection.visible(data,id(100+i)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void nativeRankAndAllDirectoryOrdersFenceUnrepairedNamesAndRenamedSources() {
        var definition=new EntityDefinition("uri","label","graph"); definition.set("publicTitle",p("publicTitle"));
        definition.setLangField("lang"); definition.setUidField("uid");
        var config=new TextIndexConfig(definition); config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(DatasetGraphFactory.createTxnMem(),index,new TextDocProducerTriples(index));
        data.begin(ReadWrite.WRITE);
        try { space(data); realm(data,REALM); concept(data,id(100),p("conceptRealm"),REALM); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertTrue(PublicNameProjection.visible(data,REALM)); assertTrue(PublicNameProjection.visible(data,id(100))); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            // No capability link: the realm's stored name remains until repair.
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:withdraw");
            assertTrue(stored(data,REALM,"realm")); assertTrue(stored(data,id(100),"concept")); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            for (String kind:List.of("realm","concept")) {
                var page=index.ranked(p("publicTitle"),"Lantern",64,null,data,
                    new FilteredGraphTextIndex.RankScope(null,null,null,false,kind,null));
                assertFalse(page.hits().isEmpty());
                assertTrue(page.hits().stream().allMatch(hit -> hit.key()==null));
                for (String order:List.of("identity","newest","updated")) {
                    var directory=index.directory(kind,order,64,null,data);
                    assertFalse(directory.hits().isEmpty());
                    assertTrue(directory.hits().stream().allMatch(hit -> hit.key()==null));
                }
            }
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            set(data,SPACE,"listing",NodeFactory.createLiteralString("listed"));
            data.deleteAny(CURRENT,SPACE,LABEL,Node.ANY); data.add(CURRENT,SPACE,LABEL,NodeFactory.createLiteralLang("Renamed parent","en"));
            refresh(data,SPACE,"urn:receipt:rename");
            assertFalse(PublicNameProjection.visible(data,REALM));
            assertTrue(PublicNameProjection.visible(data,id(100))); // Its own label is unchanged.
            PublicNameProjection.repairBatch(data,"urn:receipt:rename-repair");
            assertTrue(PublicNameProjection.visible(data,REALM));
            assertTrue(data.contains(PUBLIC,unit(REALM,"realm"),p("publicTitle"),NodeFactory.createLiteralLang("Renamed parent","en")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void sitesRepairWhenTheirRealmWithdrawsAndRestoresWithoutASpaceMutation() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM);
            data.add(CURRENT,SPACE,p("realmCapability"),REALM);
            Node site=id(4);
            data.add(CURRENT,site,RDF.type.asNode(),p("Zone"));
            data.add(CURRENT,site,p("space"),SPACE);
            data.add(CURRENT,site,p("zoneState"),p("Active"));
            data.add(CURRENT,site,p("disclosure"),p("Public"));
            PublicNameProjection.refresh(data,site);
            assertTrue(PublicNameProjection.visible(data,site));
            set(data,REALM,"realmState",p("Retired")); refresh(data,REALM,"urn:receipt:realm-withdraw");
            assertTrue(stored(data,site,"site")); assertFalse(PublicNameProjection.visible(data,site));
            PublicNameProjection.repairBatch(data,"urn:receipt:site-withdraw-repair");
            assertFalse(stored(data,site,"site"));
            set(data,REALM,"realmState",p("Active")); refresh(data,REALM,"urn:receipt:realm-restore");
            PublicNameProjection.repairBatch(data,"urn:receipt:site-restore-repair");
            assertTrue(PublicNameProjection.visible(data,site));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void workNameCandidatesNeverWalkThePublicationUnitPopulation() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            Node work=id(100);
            data.add(CURRENT,work,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
            data.add(CURRENT,work,p("catalogueVisible"),NodeFactory.createLiteralByValue(true,org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
            data.add(PUBLIC,unit(work,"work"),p("resource"),work);
            var bounded=new DatasetGraphWrapper(data) {
                @Override public Iterator<Quad> find(Node g,Node s,Node predicate,Node o) {
                    if (g.equals(PUBLIC) && s.equals(Node.ANY) && predicate.equals(p("work")))
                        fail("candidate visibility must not enumerate a Work's publication units");
                    return super.find(g,s,predicate,o);
                }
            };
            assertTrue(PublicNameProjection.visible(bounded,work));
            assertTrue(PublicNameProjection.visibleUnit(bounded,unit(work,"work").getURI()));
        } finally { data.abort(); data.end(); data.close(); }
    }
    private static final Node WORK=id(800), MAIN=id(801), SELECTION=id(802), CONTRIBUTION=id(803),
        DECISION=id(804), DRAFT=id(805), REVISION_GRAPH=uri(CommandPolicy.REVISIONS);
    private static void publishedOwner(DatasetGraph data) {
        data.add(CURRENT,WORK,RDF.type.asNode(),uri("https://schema.org/CreativeWork"));
        data.add(CURRENT,WORK,LABEL,NodeFactory.createLiteralLang("Owned work name","en"));
        data.add(CURRENT,WORK,p("mainVersion"),MAIN);
        data.add(CURRENT,MAIN,RDF.type.asNode(),p("MainVersion"));
        data.add(CURRENT,MAIN,p("work"),WORK);
        data.add(CURRENT,MAIN,p("selectionHead"),SELECTION);
        data.add(CURRENT,CONTRIBUTION,p("work"),WORK);
        data.add(CURRENT,CONTRIBUTION,p("publicationHead"),DECISION);
        data.add(REVISION_GRAPH,SELECTION,RDF.type.asNode(),p("PublicationSelection"));
        data.add(REVISION_GRAPH,SELECTION,p("work"),WORK);
        data.add(REVISION_GRAPH,SELECTION,p("mainVersion"),MAIN);
        data.add(REVISION_GRAPH,SELECTION,p("context"),MAIN);
        data.add(REVISION_GRAPH,SELECTION,p("contribution"),CONTRIBUTION);
        data.add(REVISION_GRAPH,SELECTION,p("publicationDecision"),DECISION);
        data.add(REVISION_GRAPH,SELECTION,p("selectedDraft"),DRAFT);
        data.add(REVISION_GRAPH,DECISION,RDF.type.asNode(),p("PublicationDecision"));
        data.add(REVISION_GRAPH,DECISION,p("component"),CONTRIBUTION);
        data.add(REVISION_GRAPH,DECISION,p("contribution"),CONTRIBUTION);
        data.add(REVISION_GRAPH,DECISION,p("work"),WORK);
        data.add(REVISION_GRAPH,DECISION,p("selectedDraft"),DRAFT);
        data.add(REVISION_GRAPH,DECISION,p("disclosure"),p("Public"));
        data.add(REVISION_GRAPH,DRAFT,RDF.type.asNode(),p("RevisionAnchor"));
        data.add(REVISION_GRAPH,DRAFT,p("component"),CONTRIBUTION);
    }
    private static long counter(CommandWork work, String name) {
        var match=java.util.regex.Pattern.compile("(?:^|,)"+name+"=([0-9]+)").matcher(work.counters());
        return match.find()?Long.parseLong(match.group(1)):0;
    }
    private static List<Long> workProjectionCost(int chapters,int unrelated) {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            publishedOwner(data);
            Node metadata=id(806);
            data.add(CURRENT,WORK,p("descriptiveMetadataHead"),metadata);
            data.add(REVISION_GRAPH,metadata,p("metadataState"),NodeFactory.createLiteralString(
                "{\"kind\":\"header\",\"originalTitle\":null,\"localized\":[{\"title\":\"Nom propre\",\"language\":\"fr\"}]}"));
            for (int i=0;i<chapters+unrelated;i++) {
                Node search=uri("urn:unit:growing:"+i);
                data.add(PUBLIC,search,p("work"),i<chapters?WORK:id(900));
                data.add(PUBLIC,search,p("publicTitle"),NodeFactory.createLiteralLang("Irrelevant chapter "+i,"en"));
                data.add(PUBLIC,search,p("selection"),SELECTION);
                data.add(PUBLIC,search,p("mainVersion"),MAIN);
                data.add(PUBLIC,search,p("context"),id(901));
            }
            var counted=new Counted(data) {
                @Override public Iterator<Quad> find(Node g,Node subject,Node predicate,Node object) {
                    if (g.equals(PUBLIC) && subject.equals(Node.ANY) && predicate.equals(p("work")))
                        fail("Work projection must not open the publication-unit population");
                    if (g.equals(PUBLIC) && predicate.equals(p("publicTitle"))
                        && subject.isURI() && subject.getURI().startsWith("urn:unit:"))
                        fail("chapter and unrelated-unit titles are not authored Work names");
                    return super.find(g,subject,predicate,object);
                }
            };
            List<Long> result;
            try (var work=new CommandWork()) {
                refresh(counted,WORK,"urn:receipt:work-owner-projection");
                result=List.of(counted.probes,counted.rows,counted.mutations,
                    counter(work,"public_name_heads_visited"),counter(work,"public_name_labels_visited"));
            }
            assertTrue(PublicNameProjection.visible(data,WORK));
            assertEquals(2,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(WORK,"work"),p("publicTitle"),Node.ANY)));
            assertTrue(data.contains(PUBLIC,unit(WORK,"work"),p("publicTitle"),NodeFactory.createLiteralLang("Nom propre","fr")));
            System.out.println("public-name Work cost chapters="+chapters+" unrelated="+unrelated+" probes/rows/mutations/heads/labels="+result);
            return result;
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void workProjectionCostIsIndependentOfChaptersIrrelevantUnitsAndUnrelatedResources() {
        var small=workProjectionCost(1,1);
        assertEquals(small,workProjectionCost(1000,1));
        assertEquals(small,workProjectionCost(1000,2000));
        assertEquals(Long.valueOf(1),small.get(3));
        assertEquals(Long.valueOf(2),small.get(4));
    }
    @Test public void workPublicationOwnerWithdrawalErasureAndRestorationAreImmediateWithoutUnitLinks() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            publishedOwner(data); PublicNameProjection.refresh(data,WORK);
            // The legal selection shape never required an immutable matchUnit link.
            assertFalse(data.contains(REVISION_GRAPH,SELECTION,p("matchUnit"),Node.ANY));
            assertTrue(PublicNameProjection.visible(data,WORK));
            set(data,CONTRIBUTION,"publicationHead",id(899));
            assertFalse(PublicNameProjection.visible(data,WORK));
            refresh(data,CONTRIBUTION,"urn:receipt:owner-withdraw");
            assertFalse(stored(data,WORK,"work"));
            set(data,CONTRIBUTION,"publicationHead",DECISION);
            refresh(data,CONTRIBUTION,"urn:receipt:owner-restore");
            assertTrue(PublicNameProjection.visible(data,WORK));
            data.add(REVISION_GRAPH,DRAFT,RDF.type.asNode(),p("ErasedRevision"));
            assertFalse(PublicNameProjection.visible(data,WORK));
            data.delete(REVISION_GRAPH,DRAFT,RDF.type.asNode(),p("ErasedRevision"));
            assertTrue(PublicNameProjection.visible(data,WORK));
        } finally { data.abort(); data.end(); data.close(); }
    }
    private static void collection(DatasetGraph data, Node collection,int names) {
        data.add(CURRENT,collection,RDF.type.asNode(),p("Collection"));
        data.add(CURRENT,collection,p("collectionState"),p("Active"));
        data.add(CURRENT,collection,p("disclosure"),p("Public"));
        data.add(CURRENT,collection,p("curator"),id(818));
        data.add(CURRENT,collection,p("collectionHead"),id(819));
        data.add(CURRENT,collection,p("collectionKind"),p("StaticCollection"));
        data.add(REVISION_GRAPH,id(819),RDF.type.asNode(),p("CollectionRevision"));
        for (int i=0;i<names;i++) data.add(CURRENT,collection,uri("https://schema.org/name"),
            NodeFactory.createLiteralLang("Language name "+i,"en-x-n"+String.format("%04d",i)));
    }
    private static int maintainedNameTurn(DatasetGraph data,String receipt) {
        return PublicNameProjection.repairNameLabels(data,receipt);
    }
    private static long largeNameWriteCost(int labels,int unrelated) {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        try {
            Node collection=id(810); collection(data,collection,labels);
            for (int i=0;i<unrelated;i++) data.add(CURRENT,id(10000+i),uri("https://schema.org/name"),NodeFactory.createLiteralString("Unrelated"));
            var profiles=ProfileRegistry.load(java.nio.file.Path.of("profiles"));
            assertNull(CommandService.validateOne(data,new CommandService.Validation("collection-curation-v1",
                profiles.get("collection-curation-v1"),"https://rezics.com/definition/collection-curation-v1/collection-shape",
                List.of(collection.getURI()),List.of(CommandPolicy.CURRENT,CommandPolicy.REVISIONS),java.util.Map.of())));
            long cost;
            try (var work=new CommandWork()) {
                refresh(data,collection,"urn:receipt:large-collection");
                cost=counter(work,"public_name_labels_visited");
            }
            assertFalse(PublicNameProjection.visible(data,collection));
            System.out.println("public-name label write labels="+labels+" unrelated="+unrelated+" visited="+cost);
            return cost;
        } finally { data.abort(); data.end(); data.close(); }
    }
    private static long[] countRangeRecords(DatasetGraph data) {
        var tdb=org.apache.jena.tdb2.sys.TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data));
        var table=tdb.getQuadTable().getNodeTupleTable().getTupleTable();
        var original=table.selectIndex("GSPO");
        var record=(org.apache.jena.tdb2.store.tupletable.TupleIndexRecord)original.baseTupleIndex();
        long[] visited={0};
        var range=(org.apache.jena.dboe.index.RangeIndex)java.lang.reflect.Proxy.newProxyInstance(
            org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(),new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
            (proxy,method,args)->{
                Object result=method.invoke(record.getRangeIndex(),args);
                if (method.getName().equals("iterator")) return org.apache.jena.atlas.iterator.Iter.map((Iterator<?>)result,
                    value->{visited[0]++;return value;});
                return result;
            });
        var counted=new org.apache.jena.tdb2.store.tupletable.TupleIndexRecord(4,original.getMapping(),"GSPO",range.getRecordFactory(),range);
        for (int i=0;i<table.numIndexes();i++) if (table.getIndex(i)==original)
            table.setTupleIndex(i,new org.apache.jena.tdb2.store.tupletable.TupleIndexWrapper(original) {
                @Override public org.apache.jena.tdb2.store.tupletable.TupleIndex baseTupleIndex() { return counted; }
            });
        return visited;
    }
    @Test public void labelWriteWorkIsFixedAndEveryLegalLanguageRemainsReachableThroughTheNativeIndex() {
        assertEquals(65,largeNameWriteCost(65,0));
        assertEquals(65,largeNameWriteCost(1001,2000));
        var definition=new EntityDefinition("uri","label","graph"); definition.set("publicTitle",p("publicTitle"));
        definition.setLangField("lang"); definition.setUidField("uid");
        var config=new TextIndexConfig(definition); config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),index,new TextDocProducerTriples(index));
        Node collection=id(810);
        data.begin(ReadWrite.WRITE);
        try { collection(data,collection,1001); refresh(data,collection,"urn:receipt:many-languages"); data.commit(); }
        finally { data.end(); }
        long[] records=countRangeRecords(data);
        for (int batch=0;batch<16;batch++) {
            data.begin(ReadWrite.WRITE);
            try (var work=new CommandWork()) {
                long before=records[0];
                int copied=maintainedNameTurn(data,"urn:receipt:copy-languages:"+batch);
                assertTrue(records[0]-before<=65);
                if (batch>0) assertTrue(records[0]>before);
                assertTrue(copied<=64);
                assertTrue(counter(work,"public_name_labels_visited")<=70);
                System.out.println("public-name label repair batch="+batch+" copied="+copied+" visited="+counter(work,"public_name_labels_visited"));
                data.commit();
            } finally { data.end(); }
        }
        data.begin(ReadWrite.READ);
        try {
            assertEquals(1001,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(collection,"collection"),p("publicTitle"),Node.ANY)));
            assertTrue(PublicNameProjection.visible(data,collection));
            for (int sample:List.of(0,64,128,1000)) {
                var page=index.ranked(p("publicTitle"),"Language name "+sample,64,null,data,
                    new FilteredGraphTextIndex.RankScope(null,null,null,false,"collection",null));
                assertTrue(page.hits().stream().anyMatch(hit->hit.key()!=null));
            }
            assertEquals(1,index.directory("collection","identity",64,null,data).hits().size());
        } finally { data.end(); data.close(); }
    }
    @Test public void labelCopyResumesAfterAbortReplaysNoOpAndRestartsWhenSourceChanges() {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); Node collection=id(810);
        data.begin(ReadWrite.WRITE);
        try { collection(data,collection,160); refresh(data,collection,"urn:receipt:name-source"); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try { assertEquals(64,maintainedNameTurn(data,"urn:receipt:copy-one")); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try { assertEquals(64,maintainedNameTurn(data,"urn:receipt:copy-interrupted")); data.abort(); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(64,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(collection,"collection"),p("publicTitle"),Node.ANY)));
            assertEquals(64,maintainedNameTurn(data,"urn:receipt:copy-interrupted"));
            var counted=new Counted(data);
            assertEquals(0,maintainedNameTurn(counted,"urn:receipt:copy-one")); assertEquals(0,counted.mutations);
            data.deleteAny(CURRENT,collection,uri("https://schema.org/name"),Node.ANY);
            data.add(CURRENT,collection,uri("https://schema.org/name"),NodeFactory.createLiteralLang("Current replacement","fr"));
            refresh(data,collection,"urn:receipt:replacement");
            assertFalse(PublicNameProjection.visible(data,collection));
            assertEquals(0,maintainedNameTurn(counted,"urn:receipt:copy-interrupted"));
            for (int batch=0;batch<4;batch++) assertTrue(maintainedNameTurn(data,"urn:receipt:replacement-copy:"+batch)<=64);
            assertTrue(PublicNameProjection.visible(data,collection));
            assertEquals(1,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(collection,"collection"),p("publicTitle"),Node.ANY)));
            assertTrue(data.contains(PUBLIC,unit(collection,"collection"),p("publicTitle"),NodeFactory.createLiteralLang("Current replacement","fr")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void collectionPayloadLanguagesUseTheSameResumableMaintenanceWithoutACardinalityCap() {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        try {
            Node collection=id(810),head=id(816); collection(data,collection,0);
            data.add(CURRENT,collection,uri("https://schema.org/name"),NodeFactory.createLiteralLang("Original name","en"));
            data.add(CURRENT,collection,p("collectionNameHead"),head);
            var labels=new org.apache.jena.atlas.json.JsonObject(); labels.put("en","Original name");
            for (int i=0;i<100;i++) labels.put("en-x-n"+String.format("%04d",i),"Localized "+i);
            var payload=new org.apache.jena.atlas.json.JsonObject(); payload.put("original","en"); payload.put("labels",labels);
            data.add(REVISION_GRAPH,head,RDF.type.asNode(),p("CollectionNameRevision"));
            data.add(REVISION_GRAPH,head,RDF.type.asNode(),p("RevisionAnchor"));
            data.add(REVISION_GRAPH,head,p("component"),collection);
            data.add(REVISION_GRAPH,head,p("operation"),id(817));
            data.add(REVISION_GRAPH,head,p("profilePayload"),NodeFactory.createLiteralString(payload.toString()));
            Node profile=uri("https://rezics.com/definition/collection-public-name-v1");
            data.add(REVISION_GRAPH,head,p("modelRevision"),profile); data.add(REVISION_GRAPH,head,p("shapeRevision"),profile);
            data.add(REVISION_GRAPH,head,p("datasetId"),uri("urn:rezics:dataset:product"));
            data.add(REVISION_GRAPH,head,p("dataEpoch"),NodeFactory.createLiteralString("epoch"));
            data.add(REVISION_GRAPH,head,p("sequence"),NodeFactory.createLiteralByValue(1,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            var profiles=ProfileRegistry.load(java.nio.file.Path.of("profiles"));
            assertNull(CommandService.validateOne(data,new CommandService.Validation("collection-public-name-v1",
                profiles.get("collection-public-name-v1"),profile.getURI()+"/revision-shape",
                List.of(head.getURI()),List.of(CommandPolicy.CURRENT,CommandPolicy.REVISIONS),java.util.Map.of())));
            refresh(data,collection,"urn:receipt:collection-payload");
            assertFalse(PublicNameProjection.visible(data,collection));
            String query="PREFIX rv: <https://rezics.com/vocab/> SELECT ?cursor WHERE { GRAPH <urn:rezics:projection:public-name-repair> { "
                +"?parent rv:labelCopyPhase ?phase ; rv:labelCopyStep ?step ; rv:labelCopyGeneration ?generation . "
                +"BIND(CONCAT(\"labels:\",STR(?phase),\":\",STR(?step)) AS ?cursor) } } LIMIT 1";
            String cursor;
            try (var run=org.apache.jena.query.QueryExecutionFactory.create(query,org.apache.jena.query.DatasetFactory.wrap(data))) {
                cursor=run.execSelect().next().getLiteral("cursor").getString();
            }
            for (int batch=0;batch<3;batch++) {
                PublicNameProjection.refresh(data,new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true),
                    "urn:rezics:receipt:catalogue-search-index:payload-copy:"+batch,List.of(),List.of());
                if (batch==0) try (var run=org.apache.jena.query.QueryExecutionFactory.create(query,org.apache.jena.query.DatasetFactory.wrap(data))) {
                    assertNotEquals(cursor,run.execSelect().next().getLiteral("cursor").getString());
                }
            }
            assertTrue(PublicNameProjection.visible(data,collection));
            assertEquals(101,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(collection,"collection"),p("publicTitle"),Node.ANY)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void copiedStoresRestartTheCursorWhenPhysicalNodeOrderChanges() {
        var original=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        Node collection=id(810);
        java.util.List<Quad> snapshot;
        original.begin(ReadWrite.WRITE);
        try {
            collection(original,collection,160); refresh(original,collection,"urn:receipt:copy-store-source");
            assertEquals(64,maintainedNameTurn(original,"urn:receipt:copy-store-first")); original.commit();
        } finally { original.end(); }
        original.begin(ReadWrite.READ);
        try { snapshot=org.apache.jena.atlas.iterator.Iter.toList(original.find()); }
        finally { original.end(); original.close(); }
        var copied=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); copied.begin(ReadWrite.WRITE);
        try {
            for (int i=159;i>=0;i--) copied.add(CURRENT,collection,uri("https://schema.org/name"),
                NodeFactory.createLiteralLang("Language name "+i,"en-x-n"+String.format("%04d",i)));
            for (Quad quad:snapshot) copied.add(quad);
            assertEquals(0,maintainedNameTurn(copied,"urn:receipt:copy-store-reset"));
            assertFalse(PublicNameProjection.visible(copied,collection));
            for (int batch=0;batch<6;batch++) maintainedNameTurn(copied,"urn:receipt:copy-store-resume:"+batch);
            assertTrue(PublicNameProjection.visible(copied,collection));
            assertEquals(160,org.apache.jena.atlas.iterator.Iter.count(copied.find(PUBLIC,unit(collection,"collection"),p("publicTitle"),Node.ANY)));
        } finally { copied.abort(); copied.end(); copied.close(); }
    }
    private static String labelMaintenanceReceipt(DatasetGraph data,Node resource) {
        java.util.List<String> state=new java.util.ArrayList<>();
        for (String predicate:List.of("labelCopyPhase","labelCopyStep","labelCopyGeneration")) {
            var rows=data.find(PublicNameProjection.REPAIR,resource,p(predicate),Node.ANY);
            try {
                Node value=rows.hasNext()?rows.next().getObject():null;
                state.add(value==null?null:value.isLiteral()?value.getLiteralLexicalForm():value.getURI());
            }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        if (state.get(0)==null) return null;
        String identity="[\"epoch\",\"public-name-repair\",\""+resource.getURI()+"\",\"labels:"
            +state.get(0)+":"+state.get(1)+"\",\""+state.get(2)+"\"]";
        try {
            return "urn:rezics:receipt:catalogue-search-index:"+java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(identity.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) { throw new AssertionError(error); }
    }
    private static void drainDerivedLabelReceipts(DatasetGraph data,Node resource,Set<String> receipts) {
        for (int batch=0;batch<12;batch++) {
            String receipt=labelMaintenanceReceipt(data,resource);
            if (receipt==null) return;
            assertTrue("pending maintenance receipt must advance across source rebuilds",receipts.add(receipt));
            PublicNameProjection.refresh(data,new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true),receipt,List.of(),List.of());
        }
        fail("label maintenance did not finish its bounded continuation");
    }
    @Test public void largeWorkNamesRestoreAfterInterruptedPublicationWithdrawalWithoutChangingWorkHeads() {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        try {
            publishedOwner(data);
            for (int i=0;i<160;i++) data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Work alias "+i,"fr"));
            refresh(data,WORK,"urn:receipt:large-work-source");
            Set<String> receipts=new java.util.HashSet<>();
            drainDerivedLabelReceipts(data,WORK,receipts);
            assertTrue(PublicNameProjection.visible(data,WORK));
            set(data,CONTRIBUTION,"publicationHead",id(899));
            assertFalse(PublicNameProjection.visible(data,WORK));
            refresh(data,CONTRIBUTION,"urn:receipt:large-work-withdraw");
            String clear=labelMaintenanceReceipt(data,WORK);
            assertTrue(receipts.add(clear));
            maintainedNameTurn(data,clear);
            set(data,CONTRIBUTION,"publicationHead",DECISION);
            refresh(data,CONTRIBUTION,"urn:receipt:large-work-restore");
            drainDerivedLabelReceipts(data,WORK,receipts);
            assertTrue(PublicNameProjection.visible(data,WORK));
            assertEquals(161,org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC,unit(WORK,"work"),p("publicTitle"),Node.ANY)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void priorTitleCleanupAndParentRepairStayBoundedWhenNamesAreLarge() {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM); concept(data,id(810),p("conceptRealm"),REALM);
            for (int i=0;i<1001;i++) data.add(CURRENT,id(810),uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Alias "+i,"en"));
            set(data,SPACE,"listing",NodeFactory.createLiteralString("unlisted")); refresh(data,SPACE,"urn:receipt:large-parent-withdraw");
            try (var work=new CommandWork()) {
                assertTrue(PublicNameProjection.repairBatch(data,"urn:receipt:large-parent-repair")<=64);
                assertTrue(counter(work,"public_name_labels_visited")<=64*130);
            }
            assertFalse(PublicNameProjection.visible(data,id(810)));
            // Artificially retain a large old projection to exercise bounded erasure cleanup.
            for (int i=0;i<1001;i++) data.add(PUBLIC,unit(id(810),"concept"),p("publicTitle"),NodeFactory.createLiteralString("Old "+i));
            try (var work=new CommandWork()) {
                PublicNameProjection.refresh(data,id(810));
                assertTrue(counter(work,"public_name_labels_visited")<=65);
            }
            assertFalse(PublicNameProjection.visible(data,id(810)));
            try (var work=new CommandWork()) {
                assertEquals(64,maintainedNameTurn(data,"urn:receipt:large-clear"));
                assertTrue(counter(work,"public_name_labels_visited")<=70);
            }
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void completeWorkNamesBeyondTheBodyCacheRankWithExactSelectedBodyWitnesses() {
        var definition=new EntityDefinition("uri","label","graph");definition.set("publicTitle",p("publicTitle"));definition.set("body",p("searchBody"));
        definition.setLangField("lang");definition.setUidField("uid");
        var config=new TextIndexConfig(definition);config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),index,new TextDocProducerTriples(index));
        Node body=uri("urn:unit:selected-catalogue-body");
        data.begin(ReadWrite.WRITE);
        try {
            publishedOwner(data);
            for(int i=0;i<1001;i++) data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Distinct alias "+i,"fr"));
            // Legacy legal selections may omit matchUnit; the one selected public unit is sufficient.
            data.add(PUBLIC,body,RDF.type.asNode(),p("MatchUnit"));data.add(PUBLIC,body,p("work"),WORK);
            data.add(PUBLIC,body,p("mainVersion"),MAIN);data.add(PUBLIC,body,p("context"),MAIN);
            data.add(PUBLIC,body,p("selection"),SELECTION);data.add(PUBLIC,body,p("contribution"),CONTRIBUTION);
            data.add(PUBLIC,body,p("revision"),DRAFT);data.add(PUBLIC,body,p("language"),NodeFactory.createLiteralString("en"));
            data.add(PUBLIC,body,p("disclosure"),p("Public"));data.add(PUBLIC,body,p("searchBody"),NodeFactory.createLiteralLang("Matching body words","en"));
            for(Node title:CatalogueNamePolicy.expected(data,WORK))data.add(PUBLIC,body,p("publicTitle"),title);
            assertFalse(data.contains(PUBLIC,body,p("publicTitle"),NodeFactory.createLiteralLang("Distinct alias 1000","fr")));
            refresh(data,WORK,"urn:receipt:catalogue-search-aliases");
            for(int batch=0;batch<17;batch++)maintainedNameTurn(data,"urn:receipt:catalogue-alias-copy:"+batch);
            index.refreshRankSubject(data,body.getURI());
            data.commit();
        } finally {data.end();}
        data.begin(ReadWrite.READ);
        try {
            var page=index.ranked(p("searchBody"),"Distinct alias 1000",64,null,data,new FilteredGraphTextIndex.RankScope(null,null,null,true));
            var named=page.hits().stream().filter(hit->hit.key()!=null).toList();assertEquals(1,named.size());
            assertEquals(MAIN.getURI(),named.getFirst().key());assertEquals(body.getURI(),named.getFirst().unit());
            assertEquals(unit(WORK,"work").getURI(),named.getFirst().id());
            var last=page.hits().getLast();
            var next=index.ranked(p("searchBody"),"Distinct alias 1000",64,new FilteredGraphTextIndex.RankAfter(last.id(),last.score(),page.commit(),last.document()),data,new FilteredGraphTextIndex.RankScope(null,null,null,true));
            assertTrue(next.hits().stream().noneMatch(hit->hit.key()!=null));
            var bodyPage=index.ranked(p("searchBody"),"Matching body words",64,null,data,new FilteredGraphTextIndex.RankScope(null,null,null,true));
            assertTrue(bodyPage.hits().stream().anyMatch(hit->body.getURI().equals(hit.id())&&hit.key()!=null));
        } finally {data.end();}
        data.begin(ReadWrite.WRITE);
        try {set(data,CONTRIBUTION,"publicationHead",id(899));data.commit();}finally{data.end();}
        data.begin(ReadWrite.READ);
        try {
            var page=index.ranked(p("searchBody"),"Distinct alias 1000",64,null,data,new FilteredGraphTextIndex.RankScope(null,null,null,true));
            assertTrue(page.hits().stream().allMatch(hit->hit.key()==null));
        } finally {data.end();data.close();}
    }
    private record CatalogueFixture(FilteredGraphTextIndex index, DatasetGraphText data) {}
    private static CatalogueFixture catalogueFixture() {
        var definition=new EntityDefinition("uri","label","graph");
        definition.set("publicTitle",p("publicTitle"));definition.set("body",p("searchBody"));
        definition.setLangField("lang");definition.setUidField("uid");
        var config=new TextIndexConfig(definition);config.setValueStored(true);
        var index=new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(),config));
        var data=new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),index,new TextDocProducerTriples(index));
        index.bindRankData(data);
        return new CatalogueFixture(index,data);
    }
    private record CatalogueSelection(Node selection, Node contribution, Node decision, Node draft, Node body) {}
    private static CatalogueSelection catalogueSelection(DatasetGraph data, int n, Node owner, Node context, String language) {
        Node selection=id(n),contribution=id(n+1),decision=id(n+2),draft=id(n+3),body=id(n+4);
        data.add(CURRENT,owner,p("selectionHead"),selection);
        data.add(CURRENT,contribution,p("work"),WORK);data.add(CURRENT,contribution,p("publicationHead"),decision);
        data.add(CURRENT,contribution,p("author"),id(90000));
        data.add(REVISION_GRAPH,selection,RDF.type.asNode(),p("PublicationSelection"));
        for (var fact:java.util.Map.of("work",WORK,"mainVersion",MAIN,"context",context,"contribution",contribution,
            "publicationDecision",decision,"selectedDraft",draft,"language",NodeFactory.createLiteralString(language)).entrySet())
            data.add(REVISION_GRAPH,selection,p(fact.getKey()),fact.getValue());
        data.add(REVISION_GRAPH,decision,RDF.type.asNode(),p("PublicationDecision"));
        for(var fact:java.util.Map.of("component",contribution,"contribution",contribution,"work",WORK,
            "selectedDraft",draft,"disclosure",p("Public")).entrySet())data.add(REVISION_GRAPH,decision,p(fact.getKey()),fact.getValue());
        data.add(REVISION_GRAPH,draft,RDF.type.asNode(),p("RevisionAnchor"));data.add(REVISION_GRAPH,draft,p("component"),contribution);
        data.add(PUBLIC,body,RDF.type.asNode(),p("MatchUnit"));
        for(var fact:java.util.Map.of("work",WORK,"mainVersion",MAIN,"context",context,"selection",selection,
            "contribution",contribution,"revision",draft,"language",NodeFactory.createLiteralString(language),"disclosure",p("Public")).entrySet())
            data.add(PUBLIC,body,p(fact.getKey()),fact.getValue());
        data.add(PUBLIC,body,p("searchBody"),NodeFactory.createLiteralLang("Exact selected witness body",language));
        return new CatalogueSelection(selection,contribution,decision,draft,body);
    }
    private static List<FilteredGraphTextIndex.RankHit> catalogueNameHits(CatalogueFixture fixture, String language, String realm, String author) {
        return fixture.index().ranked(p("searchBody"),"Complete boundary alias",64,null,fixture.data(),
            new FilteredGraphTextIndex.RankScope(realm,language,author,true)).hits().stream().filter(hit->hit.key()!=null).toList();
    }
    @Test public void completeNameWitnessReachesTheLastAdmittedLanguageAndAuthorWithoutASampleCap() {
        var fixture=catalogueFixture();var data=fixture.data();data.begin(ReadWrite.WRITE);
        String language;CatalogueSelection last;
        try {
            publishedOwner(data);data.delete(CURRENT,MAIN,p("selectionHead"),SELECTION);
            var selections=new java.util.HashMap<Node,CatalogueSelection>();
            for(int i=0;i<64;i++) {
                var selected=catalogueSelection(data,20000+i*10,MAIN,MAIN,"en-x"+String.format("%02d",i));
                selections.put(selected.selection(),selected);
            }
            // Select the actual final TDB owner-index row, not insertion order.
            var heads=data.find(CURRENT,MAIN,p("selectionHead"),Node.ANY);Node finalHead=null;
            try {while(heads.hasNext())finalHead=heads.next().getObject();}finally{org.apache.jena.atlas.iterator.Iter.close(heads);}
            last=selections.get(finalHead);assertNotNull(last);
            var languages=data.find(REVISION_GRAPH,finalHead,p("language"),Node.ANY);
            try{language=languages.next().getObject().getLiteralLexicalForm();}finally{org.apache.jena.atlas.iterator.Iter.close(languages);}
            data.deleteAny(REVISION_GRAPH,finalHead,p("language"),Node.ANY);
            data.add(REVISION_GRAPH,finalHead,p("language"),NodeFactory.createLiteralString("en-"+language.substring(3).toUpperCase(java.util.Locale.ROOT)));
            set(data,last.contribution(),"author",id(90001));
            data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Complete boundary alias","fr"));
            refresh(data,WORK,"urn:receipt:last-language-name");data.commit();
        } finally {data.end();}
        data.begin(ReadWrite.READ);
        try {
            try(var cost=new CommandWork()) {
                var hits=catalogueNameHits(fixture,language.toUpperCase(java.util.Locale.ROOT),null,id(90001).getURI());
                assertEquals(1,hits.size());assertEquals(last.body().getURI(),hits.getFirst().unit());
                assertEquals(64,counter(cost,"catalogue_name_witness_heads_visited")); // One cached owner proof for candidate and group.
            }
            assertTrue(catalogueNameHits(fixture,"zz",null,null).isEmpty());
            assertTrue(catalogueNameHits(fixture,language,null,id(90002).getURI()).isEmpty());
        } finally {data.end();}
        data.begin(ReadWrite.WRITE);
        try {
            // Native Main CAS rejects a 65th language before it can become current.
            data.add(CURRENT,MAIN,p("head"),id(91000));
            String update="PREFIX rv: <https://rezics.com/vocab/> DELETE { GRAPH <"+CommandPolicy.CURRENT+"> { <"+MAIN.getURI()+"> rv:selectionHead ?prior ; rv:head <"+id(91000).getURI()+"> } } "
                +"INSERT { GRAPH <"+CommandPolicy.CURRENT+"> { <"+MAIN.getURI()+"> rv:selectionHead <"+id(91001).getURI()+"> ; rv:head <"+id(91002).getURI()+"> } GRAPH <"+CommandPolicy.REVISIONS+"> { <"+id(91001).getURI()+"> rv:language \"zz\" } GRAPH <"+CommandPolicy.RECEIPTS+"> { <urn:receipt:language-bound> rv:outcome rv:Succeeded } } "
                +"WHERE { GRAPH <"+CommandPolicy.CURRENT+"> { <"+MAIN.getURI()+"> rv:head <"+id(91000).getURI()+"> . OPTIONAL { <"+MAIN.getURI()+"> rv:selectionHead ?prior } } }";
            var plan=CommandPolicy.parse(update,"urn:receipt:language-bound");
            assertEquals("Main language head limit exceeded",HeadCasPolicy.capture(data,plan,"urn:receipt:language-bound").error());
            data.add(CURRENT,MAIN,p("selectionHead"),id(91001));
            assertThrows(TextIndexException.class,()->catalogueNameHits(fixture,"zz",null,null));
        } finally {data.abort();data.end();data.close();}
    }
    @Test public void exactLanguageAndRealmNameWitnessesDenyCurrentWithdrawalsBeforeRepair() throws Exception {
        var fixture=catalogueFixture();var data=fixture.data();data.begin(ReadWrite.WRITE);
        CatalogueSelection selected;Node slot;
        try {
            publishedOwner(data);space(data);realm(data,REALM);
            String key=REALM.getURI()+"\0"+MAIN.getURI();
            slot=uri("urn:rezics:realm-selection:"+java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(key.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
            data.add(CURRENT,slot,RDF.type.asNode(),p("RealmPublicationSlot"));
            data.add(CURRENT,slot,p("realm"),REALM);data.add(CURRENT,slot,p("work"),WORK);data.add(CURRENT,slot,p("mainVersion"),MAIN);
            selected=catalogueSelection(data,30000,MAIN,MAIN,"zh-Hant");
            var adoption=catalogueSelection(data,30100,slot,REALM,"zh-Hant");
            // Optional language copy is absent on legacy Realm selections.
            data.deleteAny(REVISION_GRAPH,adoption.selection(),p("language"),Node.ANY);
            // Adoption points to the same eligible Contribution decision/draft.
            for(String predicate:List.of("contribution","publicationDecision","selectedDraft")) {
                Node value=predicate.equals("contribution")?selected.contribution():predicate.equals("publicationDecision")?selected.decision():selected.draft();
                data.deleteAny(REVISION_GRAPH,adoption.selection(),p(predicate),Node.ANY);data.add(REVISION_GRAPH,adoption.selection(),p(predicate),value);
            }
            setPublic(data,adoption.body(),"contribution",selected.contribution());setPublic(data,adoption.body(),"revision",selected.draft());
            data.add(REVISION_GRAPH,adoption.selection(),p("slot"),slot);
            for(int i=0;i<2000;i++)data.add(CURRENT,id(40000+i),p("selectionHead"),adoption.selection());
            data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Complete boundary alias","fr"));
            refresh(data,WORK,"urn:receipt:exact-witness-name");data.commit();
        } finally {data.end();}
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(1,catalogueNameHits(fixture,"zh-Hant",null,null).size());
            try(var cost=new CommandWork()) {
                assertEquals(1,catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).size());
                assertEquals(1,counter(cost,"catalogue_name_witness_heads_visited"));
            }
            assertTrue(catalogueNameHits(fixture,"en",REALM.getURI(),null).isEmpty()); // No Main fallback.
            for(String reason:List.of("publication","draft","contribution")) {
                if(reason.equals("publication"))set(data,selected.contribution(),"publicationHead",id(99999));
                if(reason.equals("draft"))data.add(REVISION_GRAPH,selected.draft(),RDF.type.asNode(),p("ErasedRevision"));
                if(reason.equals("contribution"))data.add(CURRENT,selected.contribution(),p("protectionHead"),id(99999));
                assertTrue(PublicNameProjection.visible(data,WORK)); // English remains live.
                assertTrue(reason,catalogueNameHits(fixture,"zh-Hant",null,null).isEmpty());
                assertTrue(reason,catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());
                set(data,selected.contribution(),"publicationHead",selected.decision());
                data.delete(REVISION_GRAPH,selected.draft(),RDF.type.asNode(),p("ErasedRevision"));
                data.deleteAny(CURRENT,selected.contribution(),p("protectionHead"),Node.ANY);
            }
            data.delete(CURRENT,MAIN,p("selectionHead"),selected.selection());
            assertTrue(catalogueNameHits(fixture,"zh-Hant",null,null).isEmpty());
            assertEquals(1,catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).size()); // Independent current adoption.
            data.add(CURRENT,MAIN,p("selectionHead"),selected.selection());
            for(Node parent:List.of(REALM,SPACE))for(String reason:List.of("private","unlisted","protection","merged","erased")) {
                if(reason.equals("private"))set(data,parent,"disclosure",p("Private"));
                if(reason.equals("unlisted"))set(data,parent,"listing",NodeFactory.createLiteralString("unlisted"));
                if(reason.equals("protection"))data.add(CURRENT,parent,p("protectionHead"),id(99999));
                if(reason.equals("merged"))data.add(CURRENT,parent,p("mergedInto"),id(99999));
                if(reason.equals("erased")){data.add(CURRENT,parent,p("head"),id(99999));data.add(REVISION_GRAPH,id(99999),RDF.type.asNode(),p("ErasedRevision"));}
                assertTrue(parent+" "+reason,catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());
                assertEquals(1,catalogueNameHits(fixture,"zh-Hant",null,null).size());
                set(data,parent,"disclosure",p("Public"));data.deleteAny(CURRENT,parent,p("listing"),Node.ANY);
                for(String predicate:List.of("protectionHead","mergedInto","head"))data.deleteAny(CURRENT,parent,p(predicate),Node.ANY);
                data.delete(REVISION_GRAPH,id(99999),RDF.type.asNode(),p("ErasedRevision"));
            }
            set(data,REALM,"realmState",p("Retired"));assertTrue(catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());
            set(data,REALM,"realmState",p("Active"));
            var adoptionHeads=data.find(CURRENT,slot,p("selectionHead"),Node.ANY);Node adoptionHead;
            try{adoptionHead=adoptionHeads.next().getObject();}finally{org.apache.jena.atlas.iterator.Iter.close(adoptionHeads);}
            set(data,slot,"selectionHead",id(99999));assertTrue(catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());
            set(data,slot,"selectionHead",adoptionHead);
            set(data,slot,"work",id(99999));assertTrue(catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());set(data,slot,"work",WORK);
            set(data,slot,"mainVersion",id(99999));assertTrue(catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).isEmpty());set(data,slot,"mainVersion",MAIN);
            data.add(PUBLIC,id(99998),p("selection"),selected.selection());assertThrows(TextIndexException.class,()->catalogueNameHits(fixture,"zh-Hant",null,null));
            data.deleteAny(PUBLIC,id(99998),Node.ANY,Node.ANY);
            assertEquals(1,catalogueNameHits(fixture,"zh-Hant",null,null).size());assertEquals(1,catalogueNameHits(fixture,"zh-Hant",REALM.getURI(),null).size());
            // Alternate legacy slot spellings cannot create a second Realm/Main owner.
            Node legacySlot=id(99997);
            var slotRows=data.find(CURRENT,slot,Node.ANY,Node.ANY);var facts=new java.util.ArrayList<Quad>();
            try{slotRows.forEachRemaining(facts::add);}finally{org.apache.jena.atlas.iterator.Iter.close(slotRows);}
            for(Quad fact:facts)data.add(CURRENT,legacySlot,fact.getPredicate(),fact.getObject());
            data.deleteAny(CURRENT,slot,Node.ANY,Node.ANY);
            data.deleteAny(REVISION_GRAPH,adoptionHead,p("slot"),Node.ANY);data.add(REVISION_GRAPH,adoptionHead,p("slot"),legacySlot);
            var realmScope=new FilteredGraphTextIndex.RankScope(REALM.getURI(),"zh-Hant",null,true);
            assertThrows(TextIndexException.class,()->fixture.index().ranked(p("searchBody"),"Exact selected witness body",64,null,data,realmScope));
            data.add(REVISION_GRAPH,adoptionHead,p("slot"),id(99996));
            assertThrows(TextIndexException.class,()->fixture.index().ranked(p("searchBody"),"Exact selected witness body",64,null,data,realmScope));
        } finally {data.abort();data.end();data.close();}
    }
    private static void setPublic(DatasetGraph data,Node subject,String predicate,Node object) {
        data.deleteAny(PUBLIC,subject,p(predicate),Node.ANY);data.add(PUBLIC,subject,p(predicate),object);
    }
    @Test public void catalogueCacheRecipeUsesBoundedOwnerSamplesAndExactAdmissionUnderGrowth() {
        for (int population:List.of(64,1001)) {
            var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
            try {
                publishedOwner(data);
                for (int i=0;i<population;i++) data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("Catalogue alias "+i,"fr"));
                for (int i=0;i<2000;i++) data.add(CURRENT,id(10000+i),uri("https://schema.org/alternateName"),NodeFactory.createLiteralString("Unrelated"));
                Set<Node> recipe;
                try (var work=new CommandWork()) {
                    recipe=CatalogueNamePolicy.expected(data,WORK);
                    assertEquals(65,counter(work,"catalogue_name_values_visited"));
                    System.out.println("catalogue recipe aliases="+population+" unrelated=2000 visited="+counter(work,"catalogue_name_values_visited"));
                }
                assertEquals(64,recipe.size());
                Node body=uri("urn:unit:catalogue-body"); data.add(PUBLIC,body,p("work"),WORK);
                for (Node name:recipe) data.add(PUBLIC,body,p("publicTitle"),name);
                var changes=List.of(new SearchDeltaJournal.Change(body.getURI(),true,true));
                assertNull(CatalogueNamePolicy.check(data,"urn:receipt:catalogue",changes));
                Node removed=recipe.iterator().next(); data.delete(PUBLIC,body,p("publicTitle"),removed);
                assertNotNull(CatalogueNamePolicy.check(data,"urn:receipt:catalogue",changes));
                data.add(PUBLIC,body,p("publicTitle"),NodeFactory.createLiteralLang("Invented copied name","en"));
                assertNotNull(CatalogueNamePolicy.check(data,"urn:receipt:catalogue",changes));
                data.deleteAny(PUBLIC,body,p("publicTitle"),Node.ANY);
                for (Node name:recipe) data.add(PUBLIC,body,p("publicTitle"),name);
                data.add(uri(CommandPolicy.RECEIPTS),uri("urn:receipt:other-work"),p("work"),id(900));
                assertNotNull(CatalogueNamePolicy.check(data,"urn:receipt:other-work",changes));
                assertNotNull(CatalogueNamePolicy.check(data,"urn:receipt:catalogue",List.of(new SearchDeltaJournal.Change(body.getURI(),false,true))));
                for (int i=0;i<1001;i++) data.add(PUBLIC,body,p("publicTitle"),NodeFactory.createLiteralString("Over budget "+i));
                try (var work=new CommandWork()) {
                    assertNotNull(CatalogueNamePolicy.check(data,"urn:receipt:catalogue",changes));
                    assertEquals(64,counter(work,"catalogue_name_copies_visited"));
                }
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void nativeCatalogueProposalAndPostWritePolicyShareOneRecipeIncludingHeaderAndTitleOverrides() {
        var data=org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(); data.begin(ReadWrite.WRITE);
        try {
            publishedOwner(data);
            data.add(CURRENT,WORK,uri("https://schema.org/alternateName"),NodeFactory.createLiteralLang("別名","zh-Hant"));
            var header=org.apache.jena.atlas.json.JSON.parse("{\"kind\":\"header\",\"originalTitle\":null,\"localized\":[{\"title\":\"Titre\",\"language\":\"fr\"}]}");
            var request=new org.apache.jena.atlas.json.JsonObject();request.put("work",WORK.getURI());
            var override=new org.apache.jena.atlas.json.JsonObject();override.put("header",header);
            var title=new org.apache.jena.atlas.json.JsonObject();title.put("value","Replacement title");title.put("language","en");
            override.put("replacementTitle",title);request.put("override",override);
            var proposed=CatalogueNamePolicy.recipe(data,request).get("names").getAsArray();
            org.apache.jena.sparql.function.FunctionRegistry.get().put("https://rezics.com/vocab/rankedText",FilteredGraphTextIndex.RankedFunction.class);
            var scope=new org.apache.jena.atlas.json.JsonObject();scope.put("catalogueNames",request);
            String literal=org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString(scope.toString()));
            String query="SELECT ?recipe WHERE { BIND(<https://rezics.com/vocab/rankedText>(<https://rezics.com/vocab/publicTitle>,\"\",64,\"\","+literal+") AS ?recipe) }";
            try (var run=org.apache.jena.query.QueryExecutionFactory.create(query,org.apache.jena.query.DatasetFactory.wrap(data))) {
                var returned=org.apache.jena.atlas.json.JSON.parse(run.execSelect().next().getLiteral("recipe").getString()).get("names").getAsArray();
                assertEquals(proposed.toString(),returned.toString());
            }
            data.deleteAny(CURRENT,WORK,LABEL,Node.ANY);data.add(CURRENT,WORK,LABEL,NodeFactory.createLiteralLang("Replacement title","en"));
            Node metadata=id(807);data.add(CURRENT,WORK,p("descriptiveMetadataHead"),metadata);
            data.add(REVISION_GRAPH,metadata,p("metadataState"),NodeFactory.createLiteralString(header.toString()));
            assertEquals(proposed.toString(),CatalogueNamePolicy.recipe(data,org.apache.jena.atlas.json.JSON.parse("{\"work\":\""+WORK.getURI()+"\"}")).get("names").toString());
            data.add(REVISION_GRAPH,metadata,RDF.type.asNode(),p("ErasedRevision"));
            assertFalse(CatalogueNamePolicy.expected(data,WORK).contains(NodeFactory.createLiteralLang("Titre","fr")));
        } finally { data.abort();data.end();data.close(); }
    }
    @Test public void malformedAndExternalNeighboursNeverAbortAnotherTargetsNameWriteOrAdmission() {
        var data=DatasetGraphFactory.createTxnMem();data.begin(ReadWrite.WRITE);
        try {
            space(data);
            for (Node malformed:List.of(uri("urn:x"),uri("https://rezics.com/id/short"),uri("https://rezicsXcom/id/00000000-0000-4000-8000-000000000001"),
                NodeFactory.createBlankNode(),NodeFactory.createLiteralString("foreign"))) {
                for (String predicate:List.of("work","space","realmCapability","zoneCapability")) {
                    set(data,SPACE,predicate,malformed);
                    var changes=List.of(new SearchDeltaJournal.Change("urn:unit:foreign",true,false,malformed));
                    PublicNameProjection.refresh(data,plan(SPACE),"urn:receipt:foreign-neighbour:"+predicate,List.of(),changes);
                    set(data,SPACE,predicate,null);
                    assertFalse(PublicNameProjection.visible(data,malformed));
                    PublicNameProjection.refresh(data,malformed);
                }
            }
            PublicNameProjection.refresh(data,SPACE);
            assertTrue(PublicNameProjection.visible(data,SPACE));
            assertFalse(PublicNameProjection.nameMaintenanceQuad(new Quad(PUBLIC,uri(PublicNameProjection.PREFIX+"visibility:"+"-".repeat(36)),p("nameVisibility"),NodeFactory.createLiteralString("private"))));
            Node receipt=uri("urn:rezics:receipt:catalogue-search-index:malformed-request");
            data.add(uri(CommandPolicy.RECEIPTS),receipt,p("nameResource"),uri("urn:x"));
            assertThrows(IllegalArgumentException.class,()->PublicNameProjection.refresh(data,
                new CommandPolicy.Plan(null,Set.of(),Set.of(),Set.of(),Set.of(),false,false,true),receipt.getURI(),List.of(),List.of()));
        } finally { data.abort();data.end();data.close(); }
    }
    @Test public void liveParentFenceRejectsProtectionErasureMergeAndRetirementBeforeRepair() {
        var data=DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            space(data); realm(data,REALM); concept(data,id(100),p("conceptRealm"),REALM);
            for (Node parent:List.of(SPACE,REALM)) {
                for (String predicate:List.of("protectionHead","mergedInto")) {
                    set(data,parent,predicate,id(900)); assertFalse(PublicNameProjection.visible(data,id(100)));
                    set(data,parent,predicate,null); assertTrue(PublicNameProjection.visible(data,id(100)));
                }
                set(data,parent,"head",id(900));
                data.add(uri(CommandPolicy.REVISIONS),id(900),RDF.type.asNode(),p("ErasedRevision"));
                assertFalse(PublicNameProjection.visible(data,id(100)));
                data.deleteAny(uri(CommandPolicy.REVISIONS),id(900),Node.ANY,Node.ANY);
                assertTrue(PublicNameProjection.visible(data,id(100)));
            }
            concept(data,id(101),IN_SCHEME,SCHEME);
            set(data,SCHEME,"schemeState",p("Retired")); assertFalse(PublicNameProjection.visible(data,id(101)));
            set(data,SCHEME,"schemeState",p("Active")); assertTrue(PublicNameProjection.visible(data,id(101)));
            set(data,REALM,"realmState",p("Retired")); assertFalse(PublicNameProjection.visible(data,id(100)));
        } finally { data.abort(); data.end(); data.close(); }
    }
}
