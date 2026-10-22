package com.rezics.jena;

import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.dboe.base.record.RecordFactory;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.tdb2.store.NodeId;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.vocabulary.RDF;

/** GPOS seeks one curator, then one selected generation. Physical checkpoints
 * stay inside Main's sealed export cursor. Empty/withdrawn collections spend a
 * step too; a sparse page never scans ahead to fill itself. */
final class LibraryCollectionPage {
    private static final String RV="https://rezics.com/vocab/", SCHEMA="https://schema.org/";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV+value); }
    private static final Node CURRENT=uri(CommandPolicy.CURRENT);
    private int examined;
    private Node one(DatasetGraph data,Node subject,Node predicate) {
        var rows=data.find(CURRENT,subject,predicate,Node.ANY);
        try {
            if(!rows.hasNext()) return null;
            examined++; Node value=rows.next().getObject();
            if(rows.hasNext()) throw new IllegalArgumentException("Library export field is ambiguous");
            return value;
        } finally { Iter.close(rows); }
    }
    private record Entry(Node subject,String key) {}
    private Entry next(DatasetGraph data,Node predicate,Node object,String after,boolean retained) {
        DatasetGraph base=data;
        while(base instanceof DatasetGraphWrapper wrapper && TDBInternal.getDatasetGraphTDB(base)==null) base=wrapper.getWrapped();
        var tdb=TDBInternal.requireStorage(base);
        var index=(TupleIndexRecord)TDBInternal.findIndex(base,"GPOS").baseTupleIndex();
        var factory=new RecordFactory(32,0); var start=factory.createKeyOnly(); var end=factory.createKeyOnly();
        Node[] prefix={CURRENT,predicate,object};
        for(int i=0;i<3;i++) {
            var node=TDBInternal.getNodeId(tdb,prefix[i]);
            if(NodeId.isDoesNotExist(node)) return null;
            NodeIdFactory.set(node,start.getKey(),i*8);NodeIdFactory.set(node,end.getKey(),i*8);
        }
        NodeIdFactory.setNext(TDBInternal.getNodeId(tdb,object),end.getKey(),16);
        if(!after.isEmpty()) {
            if(!after.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid Library export key");
            byte[] bytes=HexFormat.of().parseHex(after);
            if(!Arrays.equals(Arrays.copyOf(bytes,24),Arrays.copyOf(start.getKey(),24)))
                throw new IllegalArgumentException("Library export key differs from owner prefix");
            if(retained) return new Entry(tdb.getQuadTable().getNodeTupleTable().getNodeTable()
                .getNodeForNodeId(NodeIdFactory.get(bytes,24)),after);
            System.arraycopy(bytes,0,start.getKey(),0,32);
            for(int i=31;i>=0 && ++start.getKey()[i]==0;i--) { /* strict successor */ }
        }
        var rows=index.getRangeIndex().iterator(start,end);
        try {
            if(!rows.hasNext()) return null;
            var row=rows.next();examined++;
            return new Entry(tdb.getQuadTable().getNodeTupleTable().getNodeTable()
                .getNodeForNodeId(NodeIdFactory.get(row.getKey(),24)),HexFormat.of().formatHex(row.getKey()));
        } finally { Iter.close(rows); }
    }
    private record Collection(Node id,Node generation,String name,String disclosure) {}
    private Collection collection(DatasetGraph data,Node id) {
        if(!data.contains(CURRENT,id,RDF.type.asNode(),p("Collection"))) return null;
        examined++;
        if(!p("Active").equals(one(data,id,p("collectionState"))) || one(data,id,p("protectionHead"))!=null) return null;
        Node name=one(data,id,uri(SCHEMA+"name")),disclosure=one(data,id,p("disclosure")),structure=one(data,id,p("structure"));
        if(name==null || !name.isLiteral() || structure==null || disclosure==null
            || !Set.of(p("Public"),p("Private")).contains(disclosure)) return null;
        Node generation=one(data,structure,p("selectedGeneration"));
        return generation==null?null:new Collection(id,generation,name.getLiteralLexicalForm(),disclosure.equals(p("Public"))?"public":"private");
    }
    private Map<String,Object> row(String key,Collection collection,Entry placement,DatasetGraph data) {
        if(collection==null) return Map.of("key",key,"kind","skip");
        Map<String,Object> row=new LinkedHashMap<>();
        row.put("key",key); row.put("kind",placement==null?"shelf":"member");
        row.put("collection",collection.id().getURI());row.put("name",collection.name());row.put("disclosure",collection.disclosure());
        if(placement!=null) {
            if(!p("MemberRole").equals(one(data,placement.subject(),p("occurrenceRole")))
                || one(data,placement.subject(),p("removedBy"))!=null) return Map.of("key",key,"kind","skip");
            Node target=one(data,placement.subject(),uri(SCHEMA+"item"));
            if(target==null || !target.isURI()) return Map.of("key",key,"kind","skip");
            row.put("work",target.getURI());row.put("placement",placement.subject().getURI());
        }
        return row;
    }
    static Map<String,Object> read(DatasetGraph data,JsonObject request) {
        String agent=ProfileRegistry.required(request,"agent"),after=request.get("after").getAsString().value();
        int phase=request.get("phase").getAsNumber().value().intValue(),limit=request.get("limit").getAsNumber().value().intValue();
        if(!request.get("phase").toString().equals(Integer.toString(phase)) || !request.get("limit").toString().equals(Integer.toString(limit))
            || !agent.matches("https://rezics.com/id/[0-9a-f-]{36}") || (phase!=4 && phase!=5) || limit<1 || limit>21)
            throw new IllegalArgumentException("Invalid Library export window");
        var reader=new LibraryCollectionPage();
        QueryWorkService.beginRead(data);
        try {
            List<Map<String,Object>> rows=new ArrayList<>();
            String collectionKey=after,memberKey="-";
            if(phase==5 && !after.isEmpty()) {
                String[] parts=after.split("/",-1);
                if(parts.length!=2) throw new IllegalArgumentException("Invalid Library membership cursor");
                collectionKey=parts[0];memberKey=parts[1];
            }
            Collection selected=null;
            while(rows.size()<limit) {
                if(phase==4 || memberKey.equals("-")) {
                    Entry entry=reader.next(data,p("curator"),uri(agent),collectionKey,false);
                    if(entry==null) break;
                    collectionKey=entry.key();selected=reader.collection(data,entry.subject());
                    memberKey=selected==null?"-":"";
                    String key=phase==4?collectionKey:collectionKey+"/"+memberKey;
                    rows.add(phase==4?reader.row(key,selected,null,data):Map.of("key",key,"kind","skip"));
                } else {
                    if(selected==null) {
                        Entry entry=reader.next(data,p("curator"),uri(agent),collectionKey,true);
                        selected=entry==null?null:reader.collection(data,entry.subject());
                    }
                    Entry entry=selected==null?null:reader.next(data,p("generation"),selected.generation(),memberKey,false);
                    if(entry==null) { memberKey="-";rows.add(Map.of("key",collectionKey+"/-","kind","skip")); }
                    else { memberKey=entry.key();rows.add(reader.row(collectionKey+"/"+memberKey,selected,entry,data)); }
                }
            }
            return Map.of("rows",rows,"examined",reader.examined,"position",TemplateIndexService.position(data));
        } finally { QueryWorkService.endRead(data); }
    }
}
