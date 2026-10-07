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

/** Physical RDF-type/anchor directories and closed offline owner preparation.
 * Keys contain no disclosure decisions; local bases advance with the facts. */
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
        String operation=ProfileRegistry.required(request,"operation");
        if ("membership-prepare".equals(operation)) return membershipPrepare(data,request,MembershipProfiles.VALUE);
        if ("membership-status".equals(operation)) return membershipStatus(data);
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
    private static final String SCHEMA = "https://schema.org/", PREPARATION = "urn:rezics:membership-preparation",
        NORMAL_FORM = "ordered-membership-v1", COMPLETED = RV+"membershipCompletedForm";
    private static final String PROCESS = UUID.randomUUID().toString();
    private static final Map<org.apache.jena.tdb2.store.DatasetGraphTDB,String> STORES = new WeakHashMap<>();
    private static class MembershipProfiles {
        static final ProfileRegistry VALUE = ProfileRegistry.load(java.nio.file.Path.of(System.getProperty("rezics.profiles", "/fuseki/profiles")));
    }
    private record MembershipCheckpoint(String storage, long version, int phase, String after) {}
    private static org.apache.jena.tdb2.store.DatasetGraphTDB membershipStorage(DatasetGraph data) {
        DatasetGraph base = data;
        while (base instanceof DatasetGraphWrapper wrapper && TDBInternal.getDatasetGraphTDB(base)==null) base=wrapper.getWrapped();
        return TDBInternal.requireStorage(base);
    }
    private static String membershipIncarnation(org.apache.jena.tdb2.store.DatasetGraphTDB tdb) {
        // NodeIds are physical addresses: even reopening the same directory in a
        // new process cannot certify an old continuation. Compaction swaps TDBs.
        synchronized (STORES) { return PROCESS+":"+STORES.computeIfAbsent(tdb, ignored -> UUID.randomUUID().toString()); }
    }
    private static Node membershipOne(DatasetGraph data, String graph, Node subject, String predicate, boolean required) {
        var iter=data.find(uri(graph),subject,uri(predicate),Node.ANY);
        try {
            Node value=iter.hasNext()?iter.next().getObject():null;
            if (iter.hasNext() || required && value==null) throw new IllegalArgumentException("ambiguous or missing membership field: "+predicate);
            return value;
        } finally { Iter.close(iter); }
    }
    private static String membershipUri(Node node) {
        if (node==null || !node.isURI()) throw new IllegalArgumentException("membership reference must be an IRI");
        return node.getURI();
    }
    private static String membershipText(Node node) {
        if (node==null || !node.isLiteral()) throw new IllegalArgumentException("membership key must be a literal");
        return node.getLiteralLexicalForm();
    }
    private static String membershipHash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static void membershipDeadline(long deadline) {
        if (Thread.currentThread().isInterrupted() || System.currentTimeMillis()>=deadline)
            throw new MembershipDeadline();
    }
    private static MembershipCheckpoint membershipCheckpoint(DatasetGraph data) {
        Node stored=membershipOne(data,STATE,uri(PREPARATION),RV+"membershipCheckpoint",false);
        if (stored==null) return null;
        JsonObject row=org.apache.jena.atlas.json.JSON.parse(stored.getLiteralLexicalForm());
        return new MembershipCheckpoint(ProfileRegistry.required(row,"storage"),row.get("version").getAsNumber().value().longValue(),
            row.get("phase").getAsNumber().value().intValue(),row.get("after").getAsString().value());
    }
    // Even raw fixture writes invalidate the proof. Preparation runs with writers
    // stopped; unrelated concurrent commits conservatively restart a bounded
    // seek, rather than allowing a new row behind the cursor to be missed.
    private static boolean membershipCurrent(MembershipCheckpoint checkpoint, org.apache.jena.tdb2.store.DatasetGraphTDB tdb) {
        return checkpoint!=null && checkpoint.storage().equals(membershipIncarnation(tdb))
            && checkpoint.version()==tdb.getTxnSystem().getThreadTransaction().getDataVersion();
    }
    /** Semantic proof survives physical storage changes. Only the exhaustive
     * preparer creates it; native primary deltas preserve it and raw mutation
     * admission removes it. Restore cutover makes its old epoch ineligible. */
    static boolean membershipCompleted(DatasetGraph data) {
        var control=CommandInvariant.readControl(data);
        if(control==null || control.held() || unsupportedMembershipStorage(data)) return false;
        Node stored=membershipOne(data,STATE,uri(PREPARATION),COMPLETED,false);
        if(stored==null || !stored.isLiteral()) return false;
        try {
            JsonObject proof=org.apache.jena.atlas.json.JSON.parse(stored.getLiteralLexicalForm());
            return NORMAL_FORM.equals(ProfileRegistry.required(proof,"revision"))
                && control.epoch().getLiteralLexicalForm().equals(ProfileRegistry.required(proof,"dataEpoch"));
        } catch(RuntimeException invalid) { return false; }
    }
    private static boolean unsupportedMembershipStorage(DatasetGraph data) {
        // C6 default storage belongs to slim metadata. Ordered membership uses
        // the named current graph; an unsafe restored default placement must
        // never hide outside the preparer's native named-graph seek.
        for(String type:List.of(RV+"OccurrencePlacement",RV+"RemovedPlacement",SCHEMA+"ItemList",SCHEMA+"ListItem"))
            if(data.contains(org.apache.jena.sparql.core.Quad.defaultGraphNodeGenerated,Node.ANY,RDF.type.asNode(),uri(type))) return true;
        return data.contains(org.apache.jena.sparql.core.Quad.defaultGraphNodeGenerated,Node.ANY,uri(SCHEMA+"itemListElement"),Node.ANY);
    }
    static void invalidateMembershipCompletion(DatasetGraph data) {
        if(!data.isInTransaction() || data.transactionMode()!=ReadWrite.WRITE)
            throw new IllegalStateException("unsafe membership mutation must be fenced inside its write transaction");
        data.deleteAny(uri(STATE),uri(PREPARATION),uri(COMPLETED),Node.ANY);
    }
    private static Map<String,Object> membershipStatus(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try { return Map.of("needsPreparation",!membershipCompleted(data)); }
        finally { data.end(); }
    }
    /** Closed owner repair, authenticated by the existing native command envelope.
     * No query, graph, focus or update language is supplied by the caller. Each
     * turn examines <=256 seek tuples and converts <=24 placements. Validation
     * copies bounded placement fields and parent skeleton/one member; a final
     * predicate-prefix seek proves every retained list edge separately. */
    static Map<String,Object> membershipPrepare(DatasetGraph data, JsonObject request, ProfileRegistry profiles) {
        String epoch=ProfileRegistry.required(request,"dataEpoch"),routing=ProfileRegistry.required(request,"routingEpoch"),
            requestId=ProfileRegistry.required(request,"requestId");
        UUID.fromString(requestId);
        long deadline=request.get("deadline").getAsNumber().value().longValue();
        if (System.currentTimeMillis()>=deadline || Thread.currentThread().isInterrupted()) return Map.of("status","deadline");
        String digest=membershipHash(epoch+"\0"+routing+"\0"+requestId+"\0"+deadline);
        Node turn=uri("urn:rezics:membership-turn:"+requestId);
        data.begin(ReadWrite.WRITE);
        boolean committed=false;
        try {
            membershipDeadline(deadline);
            var control=CommandInvariant.readControl(data);
            if (control==null || control.held() || !epoch.equals(control.epoch().getLiteralLexicalForm())
                || !routing.equals(control.routing().getLiteralLexicalForm())) return Map.of("status","guard-unmatched");
            Node retained=membershipOne(data,STATE,turn,RV+"membershipResult",false);
            if (retained!=null) {
                if (!digest.equals(membershipText(membershipOne(data,STATE,turn,RV+"requestDigest",true))))
                    return Map.of("status","conflict");
                return membershipMap(org.apache.jena.atlas.json.JSON.parse(membershipText(retained)));
            }
            if(unsupportedMembershipStorage(data)) return CommandService.invalid("ordered membership requires named current storage; unsafe default restore must be fenced");
            var tdb=membershipStorage(data); var checkpoint=membershipCheckpoint(data);
            boolean restarted=checkpoint!=null && !membershipCurrent(checkpoint,tdb);
            boolean completed=membershipCompleted(data);
            // A physical phase-4 checkpoint cannot replace a missing/old proof.
            // Only unfinished cursors may resume under physical validity.
            int phase=completed?4:checkpoint==null || restarted || checkpoint.phase()==4?0:checkpoint.phase();
            String after=phase==4 || checkpoint==null || restarted || checkpoint.phase()==4?"":checkpoint.after();
            int examined=0,placements=0;
            while (phase<4 && examined<256 && placements<24) {
                membershipDeadline(deadline);
                var index=(TupleIndexRecord)TDBInternal.findIndex(tdb,"GPOS").baseTupleIndex();
                var factory=new RecordFactory(32,0); var start=factory.createKeyOnly(); var end=factory.createKeyOnly();
                Node[] prefix=phase==3?new Node[]{uri(CURRENT),uri(SCHEMA+"itemListElement")}
                    :new Node[]{uri(CURRENT),RDF.type.asNode(),uri(phase==2?SCHEMA+"ItemList":RV+(phase==0?"OccurrencePlacement":"RemovedPlacement"))};
                boolean exists=true;
                for(int i=0;i<prefix.length;i++) {
                    var id=TDBInternal.getNodeId(tdb,prefix[i]);
                    if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) { exists=false;break; }
                    NodeIdFactory.set(id,start.getKey(),i*8);NodeIdFactory.set(id,end.getKey(),i*8);
                }
                if (!exists) { phase++;after="";continue; }
                NodeIdFactory.setNext(TDBInternal.getNodeId(tdb,prefix[prefix.length-1]),end.getKey(),(prefix.length-1)*8);
                if (!after.isEmpty()) {
                    byte[] bytes=HexFormat.of().parseHex(after);
                    if (bytes.length!=32 || !Arrays.equals(Arrays.copyOf(bytes,prefix.length*8),Arrays.copyOf(start.getKey(),prefix.length*8)))
                        throw new IllegalArgumentException("membership checkpoint differs from physical prefix");
                    // Start strictly after the retained record; no repeated prefix row.
                    System.arraycopy(bytes,0,start.getKey(),0,32);incrementMembershipKey(start.getKey());
                }
                var iter=index.getRangeIndex().iterator(start,end);
                boolean exhausted;
                try {
                    while (iter.hasNext() && examined<256 && placements<24) {
                        membershipDeadline(deadline);
                        var record=iter.next();examined++;
                        Node subject=tdb.getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(record.getKey(),24));
                        Map<String,Object> invalid;
                        if (phase<2) {
                            boolean changed=membershipPlacement(data,subject,phase==0,profiles);
                            invalid=membershipValidatePlacement(data,subject,profiles);
                            if (changed) placements++;
                        } else {
                            Node member=phase==3?tdb.getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(record.getKey(),16)):null;
                            invalid=membershipValidateList(data,subject,member,profiles);
                        }
                        if (invalid!=null) return invalid;
                        after=HexFormat.of().formatHex(record.getKey());
                        membershipDeadline(deadline);
                    }
                    exhausted=!iter.hasNext();
                } finally { Iter.close(iter); }
                if (exhausted) { phase++;after=""; }
            }
            if(phase==4 && !completed) {
                invalidateMembershipCompletion(data);
                data.add(uri(STATE),uri(PREPARATION),uri(COMPLETED),NodeFactory.createLiteralString(
                    CommandService.jsonObject(Map.of("revision",NORMAL_FORM,"dataEpoch",epoch)).toString()));
            }
            List<String> receipts=new ArrayList<>();
            if (placements>0) {
                String receipt="urn:rezics:receipt:bootstrap:ordered-membership:"+digest;
                membershipReceipt(data,control,receipt,digest,placements);
                receipts.add(receipt);
            }
            Map<String,Object> result=new LinkedHashMap<>();
            result.put("status","committed");result.put("complete",phase==4);result.put("placements",placements);
            result.put("receipts",receipts);result.put("examined",examined);result.put("phase",phase);result.put("after",after);result.put("restarted",restarted);
            // TDB advances its serialization version once for this commit,
            // including the checkpoint itself. Aborts never advance it.
            var next=Map.<String,Object>of("storage",membershipIncarnation(tdb),"version",tdb.getTxnSystem().getThreadTransaction().getDataVersion()+1,"phase",phase,"after",after);
            data.deleteAny(uri(STATE),uri(PREPARATION),uri(RV+"membershipCheckpoint"),Node.ANY);
            data.add(uri(STATE),uri(PREPARATION),uri(RV+"membershipCheckpoint"),NodeFactory.createLiteralString(CommandService.jsonObject(next).toString()));
            data.add(uri(STATE),turn,uri(RV+"requestDigest"),NodeFactory.createLiteralString(digest));
            data.add(uri(STATE),turn,uri(RV+"membershipResult"),NodeFactory.createLiteralString(CommandService.jsonObject(result).toString()));
            membershipDeadline(deadline);
            CommandWork.timed("commit",data::commit);CommandWork.count("durable_commits",1);committed=true;
            return result;
        } catch (MembershipDeadline expired) {
            return Map.of("status","deadline");
        } catch (MembershipInvalid invalid) {
            return invalid.result;
        } catch (IllegalArgumentException invalid) {
            return CommandService.invalid(invalid.getMessage());
        } finally {
            try { if (!committed) data.abort(); } finally { data.end(); }
        }
    }
    private static Map<String,Object> membershipMap(JsonObject row) {
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("status",ProfileRegistry.required(row,"status"));
        result.put("complete",row.get("complete").getAsBoolean().value());
        result.put("placements",row.get("placements").getAsNumber().value().intValue());
        List<String> receipts=new ArrayList<>();row.get("receipts").getAsArray().forEach(value->receipts.add(value.getAsString().value()));
        result.put("receipts",receipts);
        for(String key:List.of("examined","phase")) result.put(key,row.get(key).getAsNumber().value().intValue());
        result.put("after",row.get("after").getAsString().value());
        result.put("restarted",row.get("restarted").getAsBoolean().value());
        return result;
    }
    private static void incrementMembershipKey(byte[] bytes) {
        for (int i=bytes.length-1;i>=0;i--) if (++bytes[i]!=0) return;
        throw new IllegalArgumentException("membership checkpoint overflow");
    }
    private static boolean membershipPlacement(DatasetGraph data, Node placement, boolean live, ProfileRegistry profiles) {
        membershipUri(placement);
        Node generation=membershipOne(data,CURRENT,placement,RV+"generation",true),occurrence=membershipOne(data,CURRENT,placement,RV+"occurrence",true);
        membershipUri(generation);membershipUri(occurrence);
        Node structure=membershipOne(data,CURRENT,generation,RV+"structure",true);
        membershipUri(structure);membershipOwnerProfile(data,structure,profiles);
        Node item=membershipOne(data,CURRENT,placement,SCHEMA+"item",false),legacy=membershipOne(data,CURRENT,placement,RV+"target",false),
            qualifier=membershipOne(data,CURRENT,placement,RV+"qualifier",false);
        if (item!=null && legacy!=null && !item.equals(legacy)) throw new IllegalArgumentException("conflicting membership item predicates");
        if (qualifier!=null) membershipUri(qualifier);
        Node target=item!=null?item:legacy!=null?legacy:qualifier!=null?qualifier:occurrence;
        membershipUri(target);
        boolean changed=legacy!=null;
        if (legacy!=null) data.delete(uri(CURRENT),placement,uri(RV+"target"),legacy);
        if (item==null && (live || legacy!=null)) { data.add(uri(CURRENT),placement,uri(SCHEMA+"item"),target);changed=true; }
        if (!live) return changed;
        Node segment=membershipOne(data,CURRENT,placement,RV+"orderSegment",true);
        membershipUri(segment);
        Node parent=membershipOne(data,CURRENT,segment,RV+"parent",true);membershipUri(parent);
        String segmentKey=membershipText(membershipOne(data,CURRENT,segment,RV+"segmentKey",true)),
            orderKey=membershipText(membershipOne(data,CURRENT,placement,RV+"orderKey",true));
        if (!segmentKey.matches("[a-z0-9]+(-[a-z0-9]+)*") || segmentKey.length()>32 || !orderKey.matches("[a-z0-9]+(-[a-z0-9]+)*") || orderKey.length()>32)
            throw new IllegalArgumentException("invalid parent-local membership order key");
        Node position=membershipOne(data,CURRENT,placement,SCHEMA+"position",false),wanted=NodeFactory.createLiteralString(segmentKey+"-"+orderKey);
        if (!wanted.equals(position)) { if(position!=null) data.delete(uri(CURRENT),placement,uri(SCHEMA+"position"),position);data.add(uri(CURRENT),placement,uri(SCHEMA+"position"),wanted);changed=true; }
        if (!data.contains(uri(CURRENT),placement,RDF.type.asNode(),uri(SCHEMA+"ListItem"))) {
            data.add(uri(CURRENT),placement,RDF.type.asNode(),uri(SCHEMA+"ListItem"));changed=true;
        }
        if (membershipOne(data,CURRENT,placement,RV+"removedBy",false)==null) {
            Node list=uri("urn:rezics:item-list:"+membershipHash(generation.getURI()+"\0"+parent.getURI()));
            for(var entry:Map.of(RDF.type.asNode(),uri(SCHEMA+"ItemList"),uri(RV+"generation"),generation,uri(RV+"parent"),parent).entrySet()) {
                if (!data.contains(uri(CURRENT),list,entry.getKey(),entry.getValue())) { data.add(uri(CURRENT),list,entry.getKey(),entry.getValue());changed=true; }
            }
            if (!data.contains(uri(CURRENT),list,uri(SCHEMA+"itemListElement"),placement)) {
                data.add(uri(CURRENT),list,uri(SCHEMA+"itemListElement"),placement);changed=true;
            }
            // Parent-list validation never opens its full adjacency.
            Map<String,Object> invalid=membershipValidateList(data,list,placement,profiles);
            if (invalid!=null) throw new MembershipInvalid(invalid);
        }
        return changed;
    }
    private static class MembershipDeadline extends RuntimeException {}
    private static class MembershipInvalid extends RuntimeException {
        final Map<String,Object> result;
        MembershipInvalid(Map<String,Object> result) { this.result=result; }
    }
    private static void membershipCopy(DatasetGraph source, DatasetGraph target, String graph, Node subject, Node predicate, int bound) {
        var iter=source.find(uri(graph),subject,predicate,Node.ANY);int count=0;
        try {
            while(iter.hasNext()) {
                if (++count>bound) throw new IllegalArgumentException("membership validation field exceeds physical bound");
                var quad=iter.next();
                if (quad.getObject().isLiteral() && quad.getObject().getLiteralLexicalForm().length()>2048)
                    throw new IllegalArgumentException("membership validation literal exceeds bound");
                target.add(quad);
            }
        } finally { Iter.close(iter); }
    }
    private static void membershipTypes(DatasetGraph source, DatasetGraph target, Node subject) {
        membershipCopy(source,target,CURRENT,subject,RDF.type.asNode(),16);
        membershipCopy(source,target,REVISIONS,subject,RDF.type.asNode(),16);
    }
    private static String membershipOwnerProfile(DatasetGraph data, Node structure, ProfileRegistry profiles) {
        Node graphProfile=membershipOne(data,CURRENT,structure,RV+"structureProfile",true);membershipUri(graphProfile);
        var focus=org.apache.jena.sparql.core.DatasetGraphFactory.create();
        try {
            membershipCopy(data,focus,CURRENT,structure,RDF.type.asNode(),16);
            focus.add(uri(CURRENT),structure,uri(RV+"structureProfile"),graphProfile);
            var selection=CanonicalPolicy.select(profiles,focus,membershipUri(structure),false);
            if (selection==null || !selection.type().equals(RV+"Structure")) throw new IllegalArgumentException("unknown membership owner profile");
            var route=selection.route(); var model=profiles.get(route.profile()).shapes();
            var properties=model.listObjectsOfProperty(model.createResource(route.shape()),model.createProperty("http://www.w3.org/ns/shacl#property"));
            try {
                while(properties.hasNext()) {
                    var property=properties.next().asResource();
                    var path=property.getProperty(model.createProperty("http://www.w3.org/ns/shacl#path"));
                    if (path==null || !path.getObject().asNode().equals(uri(RV+"structureProfile"))) continue;
                    var allowed=property.getProperty(model.createProperty("http://www.w3.org/ns/shacl#in"));
                    if (allowed!=null && allowed.getObject().as(org.apache.jena.rdf.model.RDFList.class).asJavaList().stream().anyMatch(value->value.asNode().equals(graphProfile)))
                        return route.profile();
                }
            } finally { properties.close(); }
            throw new IllegalArgumentException("unknown membership owner profile");
        } finally { focus.close(); }
    }
    static Map<String,Object> membershipValidatePlacement(DatasetGraph data, Node subject, ProfileRegistry profiles) {
        var focused=org.apache.jena.sparql.core.DatasetGraphFactory.create();
        try {
            // The Structure protocol admits at most 16 translated labels. Read
            // only authored placement fields; unrelated extension properties on
            // this subject must not inflate validation work or be rewritten.
            for (Node predicate:List.of(RDF.type.asNode(),uri(SCHEMA+"position"),uri(SCHEMA+"item")))
                membershipCopy(data,focused,CURRENT,subject,predicate,16);
            for (String predicate:List.of("occurrence","generation","orderSegment","orderKey","occurrenceRole","occurrenceLabel",
                "qualifier","sourceKey","selectionMode","selectionRealm","pinnedRevision","lastParent","removedBy"))
                membershipCopy(data,focused,CURRENT,subject,uri(RV+predicate),16);
            for (String predicate:List.of("occurrence","generation","orderSegment","removedBy","selectionRealm")) {
                Node reference=membershipOne(data,CURRENT,subject,RV+predicate,false);
                if(reference!=null) membershipTypes(data,focused,reference);
            }
            Map<String,Object> invalid=CanonicalPolicy.validate(profiles,focused,subject.getURI(),false);
            if (invalid!=null) return invalid;
            Node generation=membershipOne(data,CURRENT,subject,RV+"generation",true);
            Node structure=membershipOne(data,CURRENT,generation,RV+"structure",true);
            String ownerProfile=membershipOwnerProfile(data,structure,profiles);
            String shape=data.contains(uri(CURRENT),subject,RDF.type.asNode(),uri(RV+"OccurrencePlacement"))?"placement":"removed-placement";
            return CommandService.validateOne(focused,new CommandService.Validation(ownerProfile,profiles.get(ownerProfile),
                "https://rezics.com/definition/"+ownerProfile+"/"+shape+"-shape",List.of(subject.getURI()),List.of(CURRENT,REVISIONS),Map.of()));
        } finally { focused.close(); }
    }
    static Map<String,Object> membershipValidateList(DatasetGraph data, Node list, Node member, ProfileRegistry profiles) {
        membershipUri(list);
        var focused=org.apache.jena.sparql.core.DatasetGraphFactory.create();
        try {
            for (Node predicate:List.of(RDF.type.asNode(),uri(RV+"generation"),uri(RV+"parent"))) membershipCopy(data,focused,CURRENT,list,predicate,16);
            Node generation=membershipOne(data,CURRENT,list,RV+"generation",true);membershipTypes(data,focused,generation);
            if(member!=null) { focused.add(uri(CURRENT),list,uri(SCHEMA+"itemListElement"),member);membershipTypes(data,focused,member); }
            return CommandService.validateFocused(focused,new CommandService.Validation("structure-composition-v1",profiles.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/item-list-shape",List.of(list.getURI()),List.of(CURRENT,REVISIONS),Map.of()));
        } finally { focused.close(); }
    }
    private static void membershipReceipt(DatasetGraph data, CommandInvariant.Control before, String receipt, String digest, int placements) {
        Node own=uri(receipt),product=uri("urn:rezics:dataset:product"),receipts=uri(CommandPolicy.RECEIPTS),outbox=uri(CommandPolicy.OUTBOX);
        var next=before.sequence().add(java.math.BigInteger.ONE);
        Node number=NodeFactory.createLiteralByValue(next,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger);
        data.deleteAny(uri(CommandPolicy.CONTROL),product,uri(RV+"sequence"),Node.ANY);
        data.add(uri(CommandPolicy.CONTROL),product,uri(RV+"sequence"),number);
        Map<Node,Node> fields=Map.of(RDF.type.asNode(),uri(RV+"OperationReceipt"),uri(RV+"requestDigest"),NodeFactory.createLiteralString(digest),uri(RV+"outcome"),uri(RV+"Succeeded"),
            uri(RV+"action"),NodeFactory.createLiteralString("structure.membership.normalize"),uri(RV+"placementCount"),NodeFactory.createLiteralByValue(placements,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger),
            uri(RV+"datasetId"),product,uri(RV+"dataEpoch"),before.epoch(),uri(RV+"sequence"),number);
        fields.forEach((predicate,value)->data.add(receipts,own,predicate,value));
        Node batch=uri("urn:rezics:outbox:"+membershipHash(receipt)),event=uri("urn:rezics:event:"+membershipHash(receipt));
        Map<Node,Node> batchFields=Map.of(RDF.type.asNode(),uri(RV+"OutboxBatch"),uri(RV+"dataEpoch"),before.epoch(),uri(RV+"sequence"),number,
            uri(RV+"eventCount"),NodeFactory.createLiteralByValue(1,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger),uri(RV+"event"),event);
        batchFields.forEach((predicate,value)->data.add(outbox,batch,predicate,value));
        data.add(outbox,event,RDF.type.asNode(),uri(RV+"MembershipNormalizedEvent"));
        data.add(outbox,event,uri(RV+"ordinal"),NodeFactory.createLiteralByValue(0,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        data.add(outbox,event,uri(RV+"action"),NodeFactory.createLiteralString("structure.membership.normalize"));data.add(outbox,event,uri(RV+"receipt"),own);
        // Parse only a fixed internal footprint to reuse the existing stream stamp.
        var plan=CommandPolicy.parse("INSERT { GRAPH <"+CommandPolicy.OUTBOX+"> { <"+batch.getURI()+"> a <"+RV+"OutboxBatch> } GRAPH <"+CommandPolicy.RECEIPTS+"> { <"+receipt+"> a <"+RV+"OperationReceipt> } } WHERE {}",receipt);
        String failure=CommandInvariant.advanceRelayStream(data,receipt,plan,before);
        if (failure!=null) throw new IllegalArgumentException(failure);
    }

    /** Only isolated fixture assemblers expose SPARQL Update. Its existing
     * transaction must remove completion after the unsafe write, including an
     * imported/forged marker. The production assembler exposes no such route. */
    static final class RawMembershipUpdate extends org.apache.jena.fuseki.servlets.SPARQL_Update {
        @Override protected void execute(org.apache.jena.fuseki.servlets.HttpAction action, java.io.InputStream input) {
            try {
                if(action.getRequestParameter("using-graph-uri")!=null || action.getRequestParameter("using-named-graph-uri")!=null)
                    throw new IllegalArgumentException("raw USING dataset cannot certify membership invalidation");
                byte[] bytes=input.readNBytes(2_000_001);
                if(bytes.length>2_000_000) throw new IllegalArgumentException("raw maintenance update exceeds byte bound");
                var request=org.apache.jena.update.UpdateFactory.create(new String(bytes,StandardCharsets.UTF_8));
                for(var operation:request.getOperations()) {
                    List<org.apache.jena.sparql.core.Quad> insert;
                    if(operation instanceof org.apache.jena.sparql.modify.request.UpdateModify modify) {
                        if(modify.getWithIRI()!=null || !modify.getUsing().isEmpty() || !modify.getUsingNamed().isEmpty())
                            throw new IllegalArgumentException("raw WITH/USING cannot certify membership invalidation");
                        insert=modify.getInsertQuads();
                    }
                    else if(operation instanceof org.apache.jena.sparql.modify.request.UpdateDataInsert data) insert=data.getQuads();
                    else if(operation instanceof org.apache.jena.sparql.modify.request.UpdateDataDelete
                        || operation instanceof org.apache.jena.sparql.modify.request.UpdateDeleteWhere
                        || operation instanceof org.apache.jena.sparql.modify.request.UpdateClear
                        || operation instanceof org.apache.jena.sparql.modify.request.UpdateDrop) continue;
                    else throw new IllegalArgumentException("raw maintenance operation cannot certify membership invalidation");
                    if(insert.stream().anyMatch(quad->!quad.getGraph().isURI() || org.apache.jena.sparql.core.Quad.isDefaultGraph(quad.getGraph()) || quad.getGraph().getURI().equals(STATE)))
                        throw new IllegalArgumentException("raw update requires an explicit named graph and cannot write the server-owned membership proof graph");
                }
                // Appending through Jena's parser keeps trailing separators and
                // comments valid; super executes all operations in one write txn.
                request.add(org.apache.jena.update.UpdateFactory.create("DELETE WHERE { GRAPH <"+STATE+"> { <"+PREPARATION+"> <"+COMPLETED+"> ?membershipProof } }")
                    .getOperations().getFirst());
                super.execute(action,new java.io.ByteArrayInputStream(request.toString().getBytes(StandardCharsets.UTF_8)));
            } catch(java.io.IOException | IllegalArgumentException | org.apache.jena.query.QueryException | org.apache.jena.update.UpdateException invalid) {
                org.apache.jena.fuseki.servlets.ServletOps.errorBadRequest(invalid.getMessage());
            }
        }
    }
    /** Other bypass mutation protocols have no transactional membership fence. */
    static final class RefuseRawMembershipWrite extends org.apache.jena.fuseki.servlets.ActionService {
        @Override public void validate(org.apache.jena.fuseki.servlets.HttpAction action) {}
        @Override public void execute(org.apache.jena.fuseki.servlets.HttpAction action) {
            org.apache.jena.fuseki.servlets.ServletOps.errorForbidden("raw graph mutation requires a fenced maintenance operation");
        }
    }

    private TemplateIndexService() {}
}
