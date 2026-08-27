# System Architecture

Roam is an agentic award-flight research platform engineered with a strict **deterministic-gate / agentic-reasoning** architecture. It pairs real-time award inventory search with a domain-curated knowledge base, providing travel advisors with grounded recommendations, accurate mileage pricing, and verifiable transfer paths.

---

## 1. High-Level System Architecture

The application is organized into four clean, decoupled tiers:

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#f8fafc',
    'primaryTextColor': '#0f172a',
    'primaryBorderColor': '#64748b',
    'lineColor': '#2563eb',
    'textColor': '#0f172a',
    'fontSize': '15px',
    'fontFamily': 'ui-sans-serif, system-ui, sans-serif'
  },
  'flowchart': {
    'nodeSpacing': 30,
    'rankSpacing': 45,
    'curve': 'basis'
  }
}}%%
flowchart TD
  subgraph Client ["1. Presentation Layer (Next.js 16 & React 19)"]
    UI["Booking Form & Controls<br/><code>app/page.tsx</code>"]
    Rail["Award Comparison Rail<br/><code>app/flight-results.ts</code>"]
    SSE["SSE Stream Listener<br/><code>app/useAgentRun.ts</code>"]
  end

  subgraph API ["2. API Gateway & Contracts"]
    Endpoint["Streaming Endpoint: <code>POST /api/agent/runs</code><br/><i>Typed Server-Sent Events (SSE)</i>"]
    Schema["Zod Contracts & Validation<br/><code>src/contracts/</code>"]
  end

  subgraph Agent ["3. Agent Orchestration Core (LangGraph & Anthropic)"]
    Guard["Input Guardrail<br/><i>(Screening & Safety)</i>"]
    Graph["LangGraph State Machine (15 Nodes)<br/><code>src/agent/graph.ts</code>"]
    LLM["Claude 3.5 Sonnet<br/><i>(Ephemeral Prompt Caching)</i>"]
    Verify["Groundedness Verifier<br/><i>(Deterministic Regex Fact-Check)</i>"]
  end

  subgraph Services ["4. Data Providers, RAG & Persistence"]
    Seats["Seats.aero Partner API & Replay Fixtures<br/><code>src/tools/seats-aero/</code>"]
    Airports["OpenFlights Engine (~6,000 Airports)<br/><code>src/tools/locations/</code>"]
    VectorDB["MongoDB Atlas Vector Search<br/><i>Voyage AI Embeddings + 5 Curated KB Collections</i>"]
    StateDB["MongoDB Atlas Checkpointer<br/><i>Thread & Conversation Persistence</i>"]
    Tracing["LangSmith Tracing<br/><i>Custom Child Spans per HTTP Call</i>"]
  end

  %% End-to-End Flow
  UI -->|"1. Submit Search / Follow-up"| Endpoint
  Endpoint -->|"2. Validate Payload"| Schema
  Schema -->|"3. Execute Graph"| Guard
  Guard -->|"4. Route & Plan"| Graph

  Graph <-->|"Reasoning & Synthesis"| LLM
  Graph -->|"Search Live Inventory"| Seats
  Graph -->|"Resolve Gateways"| Airports
  Graph -->|"Retrieve Program Rules"| VectorDB
  Graph -->|"Persist Thread State"| StateDB
  Graph -->|"Emit Child Spans"| Tracing

  Graph -->|"5. Verify Output"| Verify
  Verify -->|"6. Stream Result Events"| Endpoint
  Endpoint -->|"7. Typed SSE Stream"| SSE
  SSE -->|"8. Render Interactive Cards"| Rail
```

---

## 2. LangGraph Execution & State Machine

The orchestration graph contains **15 specialized nodes** designed to separate deterministic operations from bounded LLM reasoning.

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#ffffff',
    'primaryTextColor': '#0f172a',
    'primaryBorderColor': '#475569',
    'lineColor': '#2563eb',
    'textColor': '#0f172a',
    'fontSize': '14px',
    'fontFamily': 'ui-sans-serif, system-ui, sans-serif'
  },
  'flowchart': {
    'nodeSpacing': 25,
    'rankSpacing': 35,
    'curve': 'basis'
  }
}}%%
flowchart TD
  %% Node definitions
  Start(["__start__"]):::startNode
  Guard["guard_input<br/><i>(Screening & Safety)</i>"]:::guardNode
  Refuse["refuse<br/><i>(Off-Topic Fallback)</i>"]:::refuseNode
  Triage["triage<br/><i>(Intent Classification)</i>"]:::llmNode
  
  ResolveUI["resolve_ui_locations<br/><i>(OpenFlights Engine)</i>"]:::detNode
  PrepareUI["prepare_ui_search<br/><i>(Form Expansion)</i>"]:::detNode
  
  PlanSearch["plan_search<br/><i>(Structured Extraction)</i>"]:::llmNode
  PlanDisc["plan_discovery<br/><i>(Candidate Probing)</i>"]:::llmNode
  Preferences["interpret_preferences<br/><i>(Bounded Soft-Preference Parsing)</i>"]:::llmNode
  
  Search["search_awards<br/><i>(Seats.aero API / Replay)</i>"]:::toolNode
  Clarify["clarify_search_constraints<br/><i>(Checkpointed Human Decision)</i>"]:::detNode
  Refresh["refresh_availability<br/><i>(Deterministic Quota Gate)</i>"]:::toolNode
  Enrich["enrich_trips<br/><i>(Deterministic get_trip_details Tool)</i>"]:::toolNode
  Position["search_positioning<br/><i>(Broadened Gateway Ladder)</i>"]:::toolNode
  Shortlist["build_candidate_shortlist<br/><i>(Deterministic Coverage Selector)</i>"]:::detNode
  
  RAG["retrieve_knowledge<br/><i>(Atlas Vector Search)</i>"]:::ragNode
  Assess["assess_candidate_experience<br/><i>(Evidence-Bounded Qualitative Judge)</i>"]:::llmNode
  Rerank["update_rerank_preferences<br/><i>(Checkpoint Reuse)</i>"]:::llmNode
  Rank["rank_recommendations<br/><i>(Deterministic Hybrid Ranker)</i>"]:::detNode
  Synthesize["synthesize<br/><i>(Context-Grounded Writer)</i>"]:::llmNode
  Verify["verify_groundedness<br/><i>(Regex Fact Set-Membership)</i>"]:::guardNode
  Degrade["degrade<br/><i>(Grounded Summary Fallback)</i>"]:::refuseNode
  Emit["emit<br/><i>(Final AIMessage)</i>"]:::detNode
  End(["__end__"]):::startNode

  %% Control Flow & Routing
  Start --> Guard
  
  Guard -.->|"is_safe == true (form)"| ResolveUI
  Guard -.->|"is_safe == true (chat)"| Triage
  Guard -.->|"is_safe == false"| Refuse
  
  Refuse --> Emit
  
  Triage -.->|"intent == 'route_search'"| PlanSearch
  Triage -.->|"intent == 'discovery'"| PlanDisc
  Triage -.->|"intent == 'knowledge'"| RAG
  Triage -.->|"intent == 'rerank'"| Rerank
  
  ResolveUI --> PrepareUI
  PrepareUI --> Preferences
  PlanSearch --> Preferences
  PlanDisc --> Preferences
  Preferences --> Search
  
  Search -.->|"consequential ambiguity"| Clarify
  Clarify -.->|"relax constraint"| Search
  Clarify -.->|"keep exact brief"| Shortlist
  Search -.->|"requires_refresh"| Refresh
  Search -.->|"skip_refresh"| Shortlist
  Refresh --> Shortlist
  Shortlist --> Enrich
  
  Enrich -.->|"exact_weak"| Position
  Enrich -.->|"sufficient"| RAG
  Position --> Shortlist
  
  RAG --> Assess
  Assess --> Rank
  Rerank --> Rank
  Rank --> Synthesize
  Synthesize --> Verify
  
  Verify -.->|"clean"| Emit
  Verify -.->|"retry (violations)"| Synthesize
  Verify -.->|"exhausted"| Degrade
  
  Degrade --> Emit
  Emit --> End

  %% Class styles
  classDef startNode fill:#e2e8f0,stroke:#334155,stroke-width:2px,color:#0f172a;
  classDef guardNode fill:#fee2e2,stroke:#ef4444,stroke-width:2px,color:#7f1d1d;
  classDef refuseNode fill:#ffedd5,stroke:#f97316,stroke-width:2px,color:#7c2d12;
  classDef llmNode fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,color:#78350f;
  classDef detNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#0f172a;
  classDef toolNode fill:#dbeafe,stroke:#3b82f6,stroke-width:2px,color:#1e3a8a;
  classDef llmToolNode fill:#ede9fe,stroke:#8b5cf6,stroke-width:2px,color:#4c1d95;
  classDef ragNode fill:#ccfbf1,stroke:#14b8a6,stroke-width:2px,color:#134e4a;
```

---

## 3. Technology Stack Matrix

| Category | Technology | Purpose & Implementation | Key Files |
|---|---|---|---|
| **Framework & Fullstack** | **Next.js 16.3.0** (Turbopack) | App Router, Server Components, TypeScript compilation, API routes | `app/`, `next.config.ts` |
| **Frontend Runtime** | **React 19.2.8** | State hooks, responsive CSS modules, dynamic comparison rail, SSE event listener | `app/page.tsx`, `app/useAgentRun.ts` |
| **Styling & Typography** | **CSS Modules + Fontsource** | Bespoke dark/light themes, Manrope (sans) and Newsreader (editorial serif) | `app/page.module.css`, `app/globals.css` |
| **Icons & Visuals** | **Phosphor Icons React** | Accessible, consistent iconography for cabins, airlines, transfers, and controls | `app/AirlineLogo.tsx`, `app/page.tsx` |
| **Agent State Machine** | **@langchain/langgraph 1.4.9** | 22-node cyclic execution graph with conditional branching, checkpointed human interrupts, checkpoint reuse, and grounded retries | `src/agent/graph.ts`, `src/agent/state.ts` |
| **LLM Orchestration** | **@langchain/anthropic 1.5.4** | Claude 3.5 Sonnet integration with ephemeral prompt caching (`cache_control`) | `src/agent/models.ts`, `src/agent/cache.ts` |
| **Vector Search & DB** | **MongoDB Atlas & MongoDB Node SDK 6.21** | Vector search index for knowledge retrieval & conversation checkpointer (`MongoDBSaver`) | `src/rag/store.ts`, `src/rag/retriever.ts` |
| **Vector Embeddings** | **Voyage AI (`voyage-3-lite`)** | High-dimensional dense embeddings for award rules, reviews, and transfer policies | `src/rag/store.ts`, `src/rag/ingest.ts` |
| **Award Data Engine** | **Seats.aero Partner API** | Real-time availability, cached searches, route-ladder positioning, and replay fixtures | `src/tools/seats-aero/`, `fixtures/seats-aero/` |
| **Location Intelligence** | **OpenFlights Dataset (~6k airports)** | Deterministic IATA, metro-area, regional, and geo-coordinate resolution | `src/tools/locations/`, `scripts/ingest-airports.ts` |
| **Type Validation** | **Zod 4.4.3** | Strict schema validation for API payloads, tool arguments, frontmatter, and graph state | `src/contracts/`, `src/rag/frontmatter.ts` |
| **Observability & Tracing**| **LangSmith 0.8.10** | Graph tracing, external API child spans, preference feedback, failure annotation queues, and reviewed-run dataset promotion | `src/tools/seats-aero/traced.ts`, `src/observability/user-feedback.ts` |
| **Testing & Evals** | **Vitest 4.1.10 + LangSmith Evals** | 3-tier eval suite (Intent routing, Search planning F1, Groundedness judge) | `evals/`, `src/**/*.test.ts` |

---

## 4. Key Architectural Patterns & Guarantees

### 1. The Deterministic Search vs. Conversational Dual-Path
- **Structured Search Form**: Bypasses conversational parsing. User inputs (airports, dates, cabins, transfer programs) are directly mapped into `AgentState` via `resolve_ui_locations` and `prepare_ui_search`. An LLM is never asked to guess IATA codes or dates.
- **Conversational Follow-up**: Handled via `triage` which routes either to structured extraction (`plan_search`), exploratory candidate generation under a strict budget (`plan_discovery`), or pure informational knowledge retrieval (`retrieve_knowledge`).
- **Bounded Preference Interpretation**: `interpret_preferences` uses Haiku structured output only for soft language, merges it with explicit slider/chip inputs under code-owned bounds, and falls back to deterministic keywords. Hard search fields are absent from its schema.
- **Coverage Before Costly Enrichment**: `build_candidate_shortlist` applies hard eligibility and round-robin coverage quotas before any trip-detail calls, preventing a mileage-ordered provider response from excluding promising nonstop, preferred-carrier, program, date, or positioning alternatives.

### 2. Post-Search Grounded RAG
Rather than guessing knowledge queries before award space is found:
1. Seats.aero returns raw available flights.
2. The query and structural metadata filters (e.g. `programs: ["aeroplan", "lifemiles"]`, `targetCabin: "business"`) are dynamically constructed from the **actual returned inventory**.
3. Vector search executes against the 5 curated markdown collections (`knowledge/sweet-spots`, `knowledge/transfers`, `knowledge/products`, `knowledge/booking`, `knowledge/seasonality`).

### 3. Dual-Stage Safety & Zero-Hallucination Loop
- **Input Screening**: The `guard_input` node screens against prompt injection, malicious instructions, and off-topic questions.
- **Output Fact Verification**: The `verify_groundedness` node parses all mileage figures, airline codes, taxes/fees, and flight numbers from the synthesized draft using regex and strictly verifies their existence in the graph tool state.
- **Self-Correction & Fallback**: If an ungrounded claim is detected, the graph triggers a single self-correction revision. If it fails a second time, it automatically falls back to `degrade`, outputting a deterministic, factual list directly from raw tool state.

### 4. Cost Engineering & Prompt Caching
- **Ephemeral Prompt Caching**: System prompts over 1,024 tokens (the search planner and synthesizer) leverage Anthropic's `cache_control: { type: "ephemeral" }`.
- **Dynamic Clock Isolation**: Ephemeral time/date data is injected solely into user turns, ensuring system prompt prefixes remain byte-identical across runs for maximum cache-hit rates.
- **Quota Protection**: Expensive external API calls (e.g., live Seats.aero `/refresh`) are deterministic graph nodes with strict rate limits, rather than open tools given to the model. `get_trip_details` is a typed LangChain tool invoked by deterministic `enrich_trips` code across a capped candidate pool.

---

## 5. End-to-End Search & Chat Request Lifecycle

```mermaid
%%{init: {
  'theme': 'base',
  'themeVariables': {
    'primaryColor': '#ffffff',
    'primaryTextColor': '#0f172a',
    'primaryBorderColor': '#64748b',
    'lineColor': '#2563eb',
    'textColor': '#0f172a',
    'fontSize': '14px',
    'fontFamily': 'ui-sans-serif, system-ui, sans-serif',
    'actorBkg': '#f8fafc',
    'actorBorder': '#475569',
    'actorTextColor': '#0f172a',
    'signalColor': '#334155',
    'signalTextColor': '#0f172a'
  }
}}%%
sequenceDiagram
  autonumber
  actor User as Travel Advisor
  participant UI as Next.js React UI
  participant API as /api/agent/runs (SSE Route)
  participant Graph as LangGraph Engine
  participant Tool as Seats.aero / Fixtures
  participant RAG as Atlas Vector Search
  participant LLM as Claude 3.5 Sonnet (Cached)
  participant Mongo as MongoDB Atlas (State & Cache)

  User->>UI: Selects ORD -> TYO, Business, Amex/Chase
  UI->>API: POST /api/agent/runs { tripRequest, threadId }
  API->>Graph: Initialize graph with thread_id
  Graph->>Mongo: Load conversation history
  
  Note over Graph: Node: guard_input -> resolve_ui_locations -> prepare_ui_search -> interpret_preferences
  API-->>UI: SSE: event "stage" (Resolving locations & planning search)

  Graph->>Tool: search_awards (Seats.aero cached availability)
  Tool-->>Graph: Return flight itineraries (NH, JL, UA)
  API-->>UI: SSE: event "stage" (Found live award seats)

  Graph->>Graph: build_candidate_shortlist (Hard eligibility + diverse coverage)

  opt Enrich Itineraries
    Graph->>Tool: enrich_trips invokes get_trip_details for shortlisted candidates
    Tool-->>Graph: Return aircraft, schedule, stops, and segment data
  end

  Graph->>RAG: retrieve_knowledge (Query with real programs & cabins)
  RAG-->>Graph: Return global notes plus evidence linked to exact candidate IDs

  Graph->>LLM: assess_candidate_experience (One bounded listwise call, qualitative evidence only)
  LLM-->>Graph: Return validated dimension scores with evidence IDs

  Note over Graph: Node: rank_recommendations (Deterministic value/experience blend and tie-breakers)
  
  Graph->>LLM: synthesize (Generate advisor recommendations & citations)
  LLM-->>Graph: Returns draft narrative

  Graph->>Graph: verify_groundedness (Regex fact set-membership check)
  
  alt Facts Grounded
    Graph->>Mongo: Persist thread state checkpoint
    Graph->>API: Return final message & ranked options
  else Facts Hallucinated / Unverifiable
    Note over Graph: Retry synthesis or degrade to raw facts
  end

  API-->>UI: SSE: event "results" (Ranked flight cards)
  API-->>UI: SSE: event "answer_delta" (Progressive grounded narrative)
  API-->>UI: SSE: event "complete"
  UI->>User: Displays interactive flight cards & recommendation breakdown
```
