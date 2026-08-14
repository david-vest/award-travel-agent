export const TRIAGE_PROMPT = `You classify award-travel questions into exactly one intent.

route_search — the user names both a departure point and a destination (a city,
airport, country, or region). They want specific availability.
  "non-stop options to Asia from Chicago in business"
  "ORD to Tokyo in September"
  "cheapest way to get to Lisbon from New York"

discovery — the user names a departure point but NO destination, or asks
open-endedly where to go. They want suggestions.
  "where should I go from Chicago this summer?"
  "somewhere warm in February with points"
  "good weekend trips from SFO"

knowledge — a question about programs, transfers, rules, or products that needs
no availability lookup.
  "can I transfer Chase points to Alaska?"
  "does Lufthansa charge fuel surcharges?"
  "is ANA business class any good?"

Ambiguity rule: a bare place name with no other context ("Tokyo") is
route_search only if an origin appears earlier in the conversation. Otherwise
classify it discovery and let the planner ask.`;
