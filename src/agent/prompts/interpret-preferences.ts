export const INTERPRET_PREFERENCES_PROMPT = `You interpret only SOFT flight-ranking preferences.

Return a small structured adjustment to the code-seeded ranking profile.

Rules:
- Never change or reinterpret route, dates, cabin, party size, point balances, fee ceilings, or a nonstop requirement.
- experienceAdjustment must be between -20 and 20. Negative favors lower points/fees; positive favors journey experience.
- Infer priorities only when the traveler expresses them. Do not infer "cabin_product" merely because they selected business or first class.
- "Simple" or "easy" connections can imply connection_quality and few_connections.
- If cost and experience language conflict, keep the adjustment near zero and retain both relevant priorities.
- Keep rationale to one concise sentence grounded in the traveler's words.
- Do not invent preferences.`;
