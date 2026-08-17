export type CreditCardProgramId = "chase" | "amex" | "capitalone" | "citi" | "bilt";
export type AwardProgramId =
  | "aeromexico" | "aeroplan" | "alaska" | "american" | "british" | "delta"
  | "emirates" | "etihad" | "flyingblue" | "iberia" | "jetblue" | "qatar"
  | "singapore" | "turkish" | "united" | "virgin";

export type CreditCardProgram = {
  id: CreditCardProgramId;
  name: string;
  balance?: string;
  programs: AwardProgramId[];
};

export type AwardProgram = {
  id: AwardProgramId;
  name: string;
  carrier: string;
  /** seats.aero's source parameter. */
  source: string;
};

export const CREDIT_CARD_PROGRAMS: CreditCardProgram[] = [
  { id: "chase", name: "Chase", balance: "120k", programs: ["aeroplan", "british", "emirates", "flyingblue", "iberia", "jetblue", "singapore", "united", "virgin"] },
  { id: "amex", name: "Amex", balance: "85k", programs: ["aeromexico", "aeroplan", "delta", "emirates", "etihad", "flyingblue", "jetblue", "qatar", "singapore", "virgin"] },
  { id: "capitalone", name: "Capital One", programs: ["aeromexico", "aeroplan", "emirates", "etihad", "flyingblue", "jetblue", "qatar", "singapore", "turkish", "virgin"] },
  { id: "citi", name: "Citi", programs: ["aeromexico", "american", "emirates", "etihad", "flyingblue", "jetblue", "qatar", "singapore", "turkish", "virgin"] },
  { id: "bilt", name: "Bilt", programs: ["aeroplan", "alaska", "emirates", "etihad", "flyingblue", "qatar", "turkish", "united", "virgin"] },
];

export const AWARD_PROGRAMS: AwardProgram[] = [
  { id: "aeromexico", name: "AeroMexico Rewards", carrier: "AM", source: "aeromexico" },
  { id: "aeroplan", name: "Air Canada Aeroplan", carrier: "AC", source: "aeroplan" },
  { id: "alaska", name: "Alaska Mileage Plan", carrier: "AS", source: "alaska" },
  { id: "american", name: "American AAdvantage", carrier: "AA", source: "american" },
  { id: "british", name: "British Airways Club", carrier: "BA", source: "british" },
  { id: "delta", name: "Delta SkyMiles", carrier: "DL", source: "delta" },
  { id: "emirates", name: "Emirates Skywards", carrier: "EK", source: "emirates" },
  { id: "etihad", name: "Etihad Guest", carrier: "EY", source: "etihad" },
  { id: "flyingblue", name: "Air France/KLM Flying Blue", carrier: "AF", source: "flyingblue" },
  { id: "iberia", name: "Iberia Plus", carrier: "IB", source: "iberia" },
  { id: "jetblue", name: "JetBlue TrueBlue", carrier: "B6", source: "jetblue" },
  { id: "qatar", name: "Qatar Privilege Club", carrier: "QR", source: "qatar" },
  { id: "singapore", name: "Singapore KrisFlyer", carrier: "SQ", source: "singapore" },
  { id: "turkish", name: "Turkish Miles&Smiles", carrier: "TK", source: "turkish" },
  { id: "united", name: "United MileagePlus", carrier: "UA", source: "united" },
  { id: "virgin", name: "Virgin Atlantic Flying Club", carrier: "VS", source: "virginatlantic" },
];

export function awardProgramForSource(source: string): AwardProgram | undefined {
  return AWARD_PROGRAMS.find((program) => program.source === source);
}

export function sourcesForAwardPrograms(ids: string[]): string[] {
  return ids.flatMap((id) => AWARD_PROGRAMS.filter((program) => program.id === id).map((program) => program.source));
}
