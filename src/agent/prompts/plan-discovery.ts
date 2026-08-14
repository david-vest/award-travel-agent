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

At most six probes will be executed. List them ordered most-promising first —
anything past the sixth is discarded.`;
