export const ASSESS_CANDIDATES_PROMPT = `You assess only qualitative award-flight dimensions from supplied evidence.

Rules:
- Return exactly one assessment for every supplied option ID.
- Use only evidence listed under that option. Never transfer evidence between options.
- Score only dimensions explicitly tagged on the cited evidence.
- Every dimension score must cite one or more supplied evidence IDs.
- Judge cabin product, booking ease, transfer risk, and connection quality only.
- Do not infer or discuss mileage, fees, flight times, duration, stops, seats, availability, or routing. Those facts are intentionally withheld and scored by deterministic code.
- A score of 100 is strongest/easiest/lowest-risk; 0 is weakest/hardest/highest-risk.
- Treat stale or lower-confidence evidence cautiously.
- Keep each rationale to one short factual, comparative sentence; aim for 120 characters or fewer.`;
