/**
 * The complete de-duplicated carrier set offered by AeroConnections' program
 * filters. Keep this catalog aligned with `aero-connections` so the two
 * products expose the same airline preference choices.
 */
export const SUPPORTED_AIRLINES = [
  { code: "AC", name: "Air Canada" },
  { code: "AF", name: "Air France" },
  { code: "AA", name: "American" },
  { code: "NH", name: "ANA" },
  { code: "AV", name: "Avianca" },
  { code: "AS", name: "Alaska" },
  { code: "AM", name: "Aeromexico" },
  { code: "BA", name: "British Airways" },
  { code: "CX", name: "Cathay Pacific" },
  { code: "CI", name: "China Airlines" },
  { code: "DL", name: "Delta" },
  { code: "EK", name: "Emirates" },
  { code: "ET", name: "Ethiopian" },
  { code: "EY", name: "Etihad" },
  { code: "BR", name: "EVA Air" },
  { code: "AY", name: "Finnair" },
  { code: "FJ", name: "Fiji Airways" },
  { code: "GA", name: "Garuda" },
  { code: "IB", name: "Iberia" },
  { code: "JL", name: "Japan Airlines" },
  { code: "KE", name: "Korean Air" },
  { code: "KL", name: "KLM" },
  { code: "LH", name: "Lufthansa" },
  { code: "LO", name: "LOT Polish" },
  { code: "MH", name: "Malaysia" },
  { code: "QF", name: "Qantas" },
  { code: "QR", name: "Qatar" },
  { code: "SQ", name: "Singapore" },
  { code: "TP", name: "TAP" },
  { code: "TK", name: "Turkish" },
  { code: "UA", name: "United" },
  { code: "VS", name: "Virgin Atlantic" },
].sort((left, right) => left.name.localeCompare(right.name)) satisfies ReadonlyArray<{ code: string; name: string }>;
