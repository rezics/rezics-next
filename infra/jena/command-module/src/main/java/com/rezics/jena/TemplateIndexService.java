package com.rezics.jena;

import java.util.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.vocabulary.RDF;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.dboe.base.record.RecordFactory;

/** Physical RDF-type/anchor directory. Keys contain no disclosure decisions.
 * Its local basis is advanced in the SAME native transaction as the facts. */
final class TemplateIndexService {
    static final String RV = "https://rezics.com/vocab/", CURRENT = CommandPolicy.CURRENT,
        REVISIONS = CommandPolicy.REVISIONS, STATE = "urn:rezics:graph:template-index";
    static final List<String> TYPES = List.of("TextContribution", "RealmPublicationSlot", "AuthorCredit", "FixedRelease");
    private static final List<String> PROPERTIES = List.of("work", "mainVersion", "realm", "externalKey", "language", "publicationHead", "publicationDecision", "contribution", "selectedDraft", "selectionHead", "creditRevision", "retiredBy");
    record Entity(String graph, String id, Map<String,List<String>> terms) {}
    record Key(String graph, String predicate, String anchor, String type) {}

    static List<Entity> capture(DatasetGraph data, CommandPolicy.Plan plan) {
        List<Entity> result = new ArrayList<>();
        for (String id : plan.current()) result.add(entity(data, CURRENT, id));
        for (String id : plan.revisions()) result.add(entity(data, REVISIONS, id));
        return result;
    }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static List<String> values(DatasetGraph data, String graph, String id, String predicate) {
        var iter = data.find(uri(graph),uri(id),uri(predicate),Node.ANY);
        List<String> result = new ArrayList<>();
        try {
            while(iter.hasNext()) {
                Node node = iter.next().getObject();
                if (!node.isURI() && !node.isLiteral()) throw new IllegalArgumentException("index term is not scalar");
                result.add(node.isURI() ? node.getURI() : node.getLiteralLexicalForm());
                if (result.size()>16) throw new IllegalArgumentException("physical entity field exceeds bound");
            }
        } finally { Iter.close(iter); }
        Collections.sort(result); return result;
    }
    static Entity entity(DatasetGraph data, String graph, String id) {
        Map<String,List<String>> terms = new TreeMap<>();
        List<String> types = values(data,graph,id,RDF.type.getURI()).stream().filter(type -> TYPES.stream().anyMatch(name->type.equals(RV+name))).toList();
        terms.put("type",types);
        if (!types.isEmpty()) for (String property : PROPERTIES) terms.put(property,values(data,graph,id,RV+property));
        if(types.contains(RV+"AuthorCredit")) terms.put("ordinal",values(data,graph,id,"https://schema.org/position"));
        for(String head : terms.getOrDefault("publicationHead",List.of())) terms.put("publicationDraft",values(data,REVISIONS,head,RV+"selectedDraft"));
        for(String head : terms.getOrDefault("selectionHead",List.of())) {
            terms.put("selectionContribution",values(data,REVISIONS,head,RV+"contribution"));
            terms.put("selectionDecision",values(data,REVISIONS,head,RV+"publicationDecision"));
            terms.put("selectionDraft",values(data,REVISIONS,head,RV+"selectedDraft"));
        }
        return new Entity(graph,id,terms);
    }
    static Set<Key> keys(Entity entity) {
        Set<Key> result = new HashSet<>();
        for (String predicate : List.of("work","mainVersion")) for(String root : entity.terms().getOrDefault(predicate,List.of()))
            for (String type : entity.terms().get("type")) result.add(new Key(entity.graph(),RV+predicate,root,type));
        return result;
    }
    private static String identity(Key key) {
        try { return "urn:rezics:template-basis:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest((key.graph()+"\0"+key.predicate()+"\0"+key.anchor()+"\0"+key.type()).getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    private static String basis(DatasetGraph data, Key key) {
        var iter = data.find(uri(STATE),uri(identity(key)),uri(RV+"sequence"),Node.ANY);
        try { return iter.hasNext() ? iter.next().getObject().getLiteralLexicalForm() : "0"; }
        finally { Iter.close(iter); }
    }
    static void retain(DatasetGraph data, String receipt, Map<String,Object> delta) {
        data.add(uri(STATE),uri(receipt),uri(RV+"templateIndexPayload"),
            NodeFactory.createLiteralString(CommandService.jsonObject(delta).toString()));
    }
    static org.apache.jena.atlas.json.JsonObject replay(DatasetGraph data,String receipt,CommandPolicy.Plan plan) {
        var values = values(data,STATE,receipt,RV+"templateIndexPayload");
        if(!values.isEmpty()) return org.apache.jena.atlas.json.JSON.parse(values.getFirst());
        Map<String,Object> legacy=new LinkedHashMap<>(snapshot(data,capture(data,plan)));
        // An old receipt cannot certify a current anchor's omitted insertions.
        // Startup backfill supplies that complete basis independently.
        legacy.put("bases",List.of());return CommandService.jsonObject(legacy);
    }
    static Map<String,Object> snapshot(DatasetGraph data, List<Entity> entities) {
        Set<Key> keys = new HashSet<>(); entities.forEach(entity -> keys.addAll(keys(entity)));
        List<Map<String,Object>> rows = entities.stream().map(entity -> Map.<String,Object>of(
            "graph",entity.graph(),"id",entity.id(),"terms",entity.terms())).toList();
        List<Map<String,Object>> bases = keys.stream().map(key -> Map.<String,Object>of(
            "graph",key.graph(),"predicate",key.predicate(),"anchor",key.anchor(),"type",key.type(),"sequence",basis(data,key))).toList();
        return Map.of("entities",rows,"bases",bases,"position",position(data));
    }
    static Map<String,Object> refresh(DatasetGraph data, List<Entity> before, CommandPolicy.Plan plan) {
        List<Entity> after = capture(data,plan);
        Set<Key> changed = new HashSet<>();
        for(int i=0;i<after.size();i++) if(!after.get(i).equals(before.get(i))) {
            changed.addAll(keys(before.get(i))); changed.addAll(keys(after.get(i)));
        }
        String sequence = position(data).get("sequence");
        Map<Key,String> previous=new HashMap<>();
        for(Key key : changed) {
            previous.put(key,basis(data,key));
            data.deleteAny(uri(STATE),uri(identity(key)),uri(RV+"sequence"),Node.ANY);
            data.add(uri(STATE),uri(identity(key)),uri(RV+"sequence"),NodeFactory.createLiteralString(sequence));
        }
        Map<String,Object> result = new LinkedHashMap<>(snapshot(data,after));
        // Removed anchors also close their local basis, even with no remaining row.
        Set<Key> all = new HashSet<>(changed); after.forEach(entity -> all.addAll(keys(entity)));
        result.put("bases",all.stream().map(key -> Map.of("graph",key.graph(),"predicate",key.predicate(),
            "anchor",key.anchor(),"type",key.type(),"sequence",basis(data,key),"previous",previous.getOrDefault(key,basis(data,key)))).toList());
        return result;
    }
    private static Map<String,String> position(DatasetGraph data) {
        return Map.of("dataEpoch",values(data,CommandPolicy.CONTROL,"urn:rezics:dataset:product",RV+"dataEpoch").getFirst(),
            "sequence",values(data,CommandPolicy.CONTROL,"urn:rezics:dataset:product",RV+"sequence").getFirst());
    }
    static Map<String,Object> read(DatasetGraph data, JsonObject request) {
        data.begin(ReadWrite.READ);
        try {
            if ("basis".equals(ProfileRegistry.required(request,"operation"))) {
                var rows = request.get("keys").getAsArray();
                if(rows.size()>128) throw new IllegalArgumentException("too many index roots");
                List<Map<String,Object>> bases = new ArrayList<>();
                for(var item : rows) {
                    var row = item.getAsObject(); Key key = new Key(ProfileRegistry.required(row,"graph"),
                        ProfileRegistry.required(row,"predicate"),ProfileRegistry.required(row,"anchor"),ProfileRegistry.required(row,"type"));
                    bases.add(Map.of("graph",key.graph(),"predicate",key.predicate(),"anchor",key.anchor(),"type",key.type(),"sequence",basis(data,key)));
                }
                return Map.of("bases",bases,"position",position(data));
            }
            if (!"backfill".equals(ProfileRegistry.required(request,"operation"))) throw new IllegalArgumentException("unknown index read");
            int phase = request.get("phase").getAsNumber().value().intValue();
            if(phase<0 || phase>=TYPES.size()) throw new IllegalArgumentException("invalid index phase");
            String graph = phase==3 ? REVISIONS : CURRENT;
            DatasetGraph base = data;
            while(base instanceof DatasetGraphWrapper wrapper && TDBInternal.getDatasetGraphTDB(base)==null) base=wrapper.getWrapped();
            var tdb = TDBInternal.requireStorage(base);
            var index = (TupleIndexRecord) TDBInternal.findIndex(base,"GPOS").baseTupleIndex();
            var factory = new RecordFactory(32,0);
            var start = factory.createKeyOnly(); var end = factory.createKeyOnly();
            Node[] prefix = {uri(graph),RDF.type.asNode(),uri(RV+TYPES.get(phase))};
            for(int i=0;i<3;i++) {
                var id = TDBInternal.getNodeId(tdb,prefix[i]);
                if(org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) return Map.of("entities",List.of(),"bases",List.of(),"position",position(data),"next", "");
                NodeIdFactory.set(id,start.getKey(),i*8); NodeIdFactory.set(id,end.getKey(),i*8);
            }
            NodeIdFactory.setNext(TDBInternal.getNodeId(tdb,prefix[2]),end.getKey(),16);
            String after = request.get("after").getAsString().value();
            byte[] afterBytes = after.isEmpty() ? null : HexFormat.of().parseHex(after);
            if(afterBytes!=null) {
                if(afterBytes.length!=32 || !Arrays.equals(Arrays.copyOf(afterBytes,24),Arrays.copyOf(start.getKey(),24)))
                    throw new IllegalArgumentException("index checkpoint differs from prefix");
                System.arraycopy(afterBytes,0,start.getKey(),0,32);
            }
            List<Entity> entities = new ArrayList<>(); String last = "";
            var iter = index.getRangeIndex().iterator(start,end);
            try {
                while(iter.hasNext() && entities.size()<256) {
                    var record = iter.next();
                    if(afterBytes!=null && Arrays.equals(afterBytes,record.getKey())) continue;
                    var subject = tdb.getQuadTable().getNodeTupleTable().getNodeTable()
                        .getNodeForNodeId(NodeIdFactory.get(record.getKey(),24));
                    entities.add(entity(data,graph,subject.getURI())); last=HexFormat.of().formatHex(record.getKey());
                }
                Map<String,Object> result = new LinkedHashMap<>(snapshot(data,entities)); result.put("next",iter.hasNext()?last:"");
                return result;
            } finally { Iter.close(iter); }
        } finally { data.end(); }
    }
    private TemplateIndexService() {}
}
