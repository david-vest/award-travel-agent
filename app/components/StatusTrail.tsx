// app/components/StatusTrail.tsx

export type StatusEntry = { node: string; label: string };

/**
 * Live node-progress labels for the in-flight turn, most recent last. Earlier
 * entries dim as later ones arrive — this is what makes the graph legible
 * during a demo without narrating it out loud.
 */
export function StatusTrail({ trail }: { trail: StatusEntry[] }) {
  if (trail.length === 0) return null;

  return (
    <ol className="status-trail" aria-live="polite">
      {trail.map((entry, i) => (
        <li
          key={`${entry.node}-${i}`}
          className={i === trail.length - 1 ? "status-active" : "status-done"}
        >
          {entry.label}
        </li>
      ))}
    </ol>
  );
}
