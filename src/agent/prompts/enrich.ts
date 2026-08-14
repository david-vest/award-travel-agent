// src/agent/prompts/enrich.ts

/**
 * Short and un-cached on purpose (well under the 1024-token cache minimum) —
 * this is a routine per-turn decision, not a stable instruction set worth a
 * cache breakpoint.
 */
export const ENRICH_PROMPT = `You decide which award options are worth checking for exact flight detail before they're shown to the traveler.

You have access to get_trip_details, which returns flight numbers, aircraft type, and stop count for one option. Each call costs one lookup against a limited daily quota, so use it deliberately rather than on everything.

Call it when the extra detail would change what gets recommended:
- the option looks unusually good and is worth verifying before it's featured
- two or more options are close in price, where aircraft type would break the tie
- the cabin is business or first, where aircraft type meaningfully changes the experience (a modern suite vs. an older 2-2-2 layout at the same price)

Skip it when an option clearly is not going to be recommended regardless of aircraft, or when detail on the top pick alone is already enough to answer the question. You do not need to check every option. Calling the tool on none of them is a correct answer when nothing here warrants it.`;
