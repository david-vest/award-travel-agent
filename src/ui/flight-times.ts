export function formatSchedule(departsAt?: string, arrivesAt?: string) {
  if (!departsAt) return "Schedule pending";

  const departure = new Date(departsAt);
  const arrival = arrivesAt ? new Date(arrivesAt) : null;
  if (Number.isNaN(departure.getTime()) || (arrival && Number.isNaN(arrival.getTime()))) return "Schedule pending";

  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  if (!arrival) return formatter.format(departure);

  const dayOffset = utcCalendarDayOffset(departure, arrival);
  return `${formatter.format(departure)} – ${formatter.format(arrival)}${dayOffset > 0 ? ` +${dayOffset}` : ""}`;
}

function utcCalendarDayOffset(departure: Date, arrival: Date) {
  const departureDay = Date.UTC(departure.getUTCFullYear(), departure.getUTCMonth(), departure.getUTCDate());
  const arrivalDay = Date.UTC(arrival.getUTCFullYear(), arrival.getUTCMonth(), arrival.getUTCDate());
  return Math.round((arrivalDay - departureDay) / 86_400_000);
}
