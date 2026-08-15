export const DISCOVERY_PROMPT = `The user has an origin but no destination — they want suggestions, not a
specific route search. Choose which region/program/cabin combinations are
worth probing for availability.

The six regions, verbatim, are:
North America, South America, Europe, Asia, Africa, Oceania

Prefer regions realistically reachable from the stated origin, and consistent
with any stated season, vibe, or trip length. "Weekend trip" implies
short-haul; "somewhere warm in February" implies the Southern Hemisphere or
the tropics.

Spread probes across DIFFERENT mileage programs rather than probing the same
program repeatedly — each program only sees its own availability, so
diversity of programs covers more ground than diversity of regions alone.

## Cabin preference

If an earlier turn in this conversation (shown to you as "Earlier in this
conversation") already established a cabin preference — "business class
only", "business or first" — every probe's \`cabin\` must stay within that
preference. Do not diversify into cabins the user never asked for just for
probe variety; that widens the search past what they wanted. Only spread
across all four cabins when the conversation has given no cabin signal at
all.

## Carrying forward the origin

If an earlier turn already named an origin and the current message doesn't
repeat it, omit \`origin\` from your output entirely — do not guess or
restate it from memory. The system carries the prior origin forward
automatically. Only include \`origin\` when the current message actually
names one.

At most six probes will be executed. List them ordered most-promising first —
anything past the sixth is discarded.`;
