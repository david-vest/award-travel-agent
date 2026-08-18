# Graph

Generated from the real compiled graph (`buildGraphWithoutCheckpointer().getGraph().drawMermaid()`)

```mermaid
%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
	__start__([<p>__start__</p>]):::first
	guard_input(guard_input)
	refuse(refuse)
	triage(triage)
	resolve_ui_locations(resolve_ui_locations)
	prepare_ui_search(prepare_ui_search)
	plan_search(plan_search)
	plan_discovery(plan_discovery)
	search_awards(search_awards)
	search_positioning(search_positioning)
	enrich_trips(enrich_trips)
	retrieve_knowledge(retrieve_knowledge)
	rank_recommendations(rank_recommendations)
	synthesize(synthesize)
	refresh_availability(refresh_availability)
	verify_groundedness(verify_groundedness)
	degrade(degrade)
	emit(emit)
	__end__([<p>__end__</p>]):::last
	__start__ --> guard_input;
	degrade --> emit;
	emit --> __end__;
	plan_discovery --> search_awards;
	plan_search --> search_awards;
	prepare_ui_search --> search_awards;
	rank_recommendations --> synthesize;
	refresh_availability --> enrich_trips;
	refuse --> emit;
	resolve_ui_locations --> prepare_ui_search;
	retrieve_knowledge --> rank_recommendations;
	search_positioning --> enrich_trips;
	synthesize --> verify_groundedness;
	guard_input -.-> triage;
	guard_input -.-> resolve_ui_locations;
	guard_input -.-> refuse;
	triage -.-> plan_search;
	triage -.-> plan_discovery;
	triage -.-> retrieve_knowledge;
	search_awards -.-> refresh_availability;
	search_awards -.-> enrich_trips;
	enrich_trips -.-> search_positioning;
	enrich_trips -.-> retrieve_knowledge;
	verify_groundedness -.-> synthesize;
	verify_groundedness -.-> degrade;
	verify_groundedness -.-> emit;
	classDef default fill:#f2f0ff,line-height:1.2;
	classDef first fill-opacity:0;
	classDef last fill:#bfb6fc;
```
