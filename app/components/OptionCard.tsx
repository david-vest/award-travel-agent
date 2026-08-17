// app/components/OptionCard.tsx
import type { LinkedOption } from "@/src/agent/stream";

const CABIN_LABEL: Record<string, string> = {
  economy: "Economy",
  premium: "Premium Economy",
  business: "Business",
  first: "First",
};

/**
 * Anything newer than this is treated as "confirmed just now". LinkedOption
 * only carries the seats.aero record's own `updatedAt` timestamp — the wire
 * protocol's `done` event has no separate per-option "we just refreshed this"
 * flag (that state, `refreshedAt`, lives on the graph's turn-level state and
 * is never sent to the client). Recency of `updatedAt` is therefore the best
 * signal available for distinguishing a record this turn actually
 * re-confirmed from one served straight out of the cache.
 */
const JUST_CONFIRMED_WINDOW_MS = 10 * 60 * 1000;

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "an unknown time ago";

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diffMinutes = Math.round((then - Date.now()) / 60_000);

  if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  return rtf.format(diffDays, "day");
}

function freshnessLabel(updatedAt?: string): string {
  if (!updatedAt) return "freshness unknown";
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return "freshness unknown";

  const age = Date.now() - then;
  if (age >= 0 && age < JUST_CONFIRMED_WINDOW_MS) return "confirmed just now";
  return `cached, last updated ${relativeTime(updatedAt)}`;
}

/** One card per recommended award option from the last `done` event. */
export function OptionCard({ option }: { option: LinkedOption }) {
  return (
    <article className="option-card">
      <header className="option-card-header">
        <span className="option-route">
          {option.origin} → {option.destination}
        </span>
        {option.direct && <span className="badge badge-direct">Nonstop</span>}
      </header>

      <div className="option-meta">
        <span>{option.date}</span>
        <span>{CABIN_LABEL[option.cabin] ?? option.cabin}</span>
        <span>{option.program}</span>
      </div>

      <p className="option-miles">{option.miles.toLocaleString()} miles</p>

      <div className="option-detail">
        {option.airlines && <span>{option.airlines}</span>}
        {option.remainingSeats !== undefined && (
          <span>
            {option.remainingSeats} seat{option.remainingSeats === 1 ? "" : "s"} left
          </span>
        )}
      </div>

      <p className="option-freshness">{freshnessLabel(option.updatedAt)}</p>

      <a
        className="option-link"
        href={option.mapUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        View on AeroConnections →
      </a>
    </article>
  );
}
