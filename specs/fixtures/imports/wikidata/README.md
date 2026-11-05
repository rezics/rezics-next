These small synthetic fixtures follow the [Wikibase entity JSON format](https://doc.wikimedia.org/Wikibase/master/php/docs_topics_json.html).
The entity ID and revision are test identities, not a claim about a real Wikidata revision.
The entity has deliberately hostile extra post/account fields; the separate page/account records test exclusion.
Source claims use the catalogue's existing P50, P1545, P577 and P856 mappings; P31 identifies a book work.
P854 supplies a reference URL. P999999 is deliberately unsupported, and Q999999999 is initially unresolved.
No Wikipedia article body is included or fetched from the sitelink.

Wikidata's [copyright policy](https://www.wikidata.org/wiki/Wikidata:Copyright) distinguishes CC0 structured data
from other namespaces' text. The tests require CC0-1.0 source citations with the exact entity revision;
user/talk text and private account fields never receive that structured-data treatment.

`Q76-2565156187.jsonl` is a bounded slice of [Wikidata revision 2565156187](https://www.wikidata.org/w/index.php?title=Q76&oldid=2565156187),
retrieved through `Special:EntityData/Q76.json` on 2026-11-05. It retains the item identity, revision, modified time,
English label and complete P31, P569, P2048 and P22 claim arrays, including claim IDs, ranks, qualifiers and references.
The birth date preserves explicit zero timezone and uncertainty; both height claims retain their original units,
measurement-date qualifiers and citations. Other properties, language terms and sitelinks were omitted to fit one
bounded import record. These are CC0 structured data; the controlled fixtures remain separate and make no claim to
be genuine source revisions.
