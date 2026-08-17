import type { AwardOption } from "./tools";

export const AERO_CONNECTIONS_BASE =
  process.env.NEXT_PUBLIC_AERO_CONNECTIONS_URL ?? "https://localhost:3001";

/**
 * AeroConnections stores its full search state in the URL via nuqs, so this
 * handoff requires no changes to that project. The `flight` param pins one
 * specific trip, which is what turns a generic link into "open the map focused
 * on exactly the option I just recommended".
 */
export function aeroConnectionsUrl(
  option: AwardOption,
  opts: { flightId?: string } = {},
): string {
  const url = new URL(AERO_CONNECTIONS_BASE);

  url.searchParams.set("origin", option.origin);
  url.searchParams.set("dest", option.destination);
  url.searchParams.set("start", option.date);
  url.searchParams.set("end", option.date);
  url.searchParams.set("cabins", option.cabin);
  url.searchParams.set("program", option.program);

  // AeroConnections treats an absent `direct` as its own default; only set it
  // when we actually mean to constrain the view.
  if (option.direct) url.searchParams.set("direct", "true");
  if (opts.flightId) url.searchParams.set("flight", opts.flightId);

  return url.toString();
}
