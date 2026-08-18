import { MILEAGE_PROGRAMS, type MileageProgram } from "./tools/seats-aero/types";

/** Official booking sites for every mileage program seats.aero can search. */
const PROGRAM_BOOKING_URLS = {
  aeromexico: "https://www.aeromexico.com/",
  aeroplan: "https://www.aircanada.com/",
  alaska: "https://www.alaskaair.com/",
  american: "https://www.aa.com/",
  azul: "https://www.voeazul.com.br/",
  connectmiles: "https://www.copaair.com/",
  delta: "https://www.delta.com/",
  emirates: "https://www.emirates.com/",
  ethiopian: "https://www.ethiopianairlines.com/",
  etihad: "https://www.etihad.com/",
  eurobonus: "https://www.flysas.com/",
  finnair: "https://www.finnair.com/",
  flyingblue: "https://www.flyingblue.com/",
  jetblue: "https://www.jetblue.com/",
  lifemiles: "https://www.lifemiles.com/",
  lufthansa: "https://www.miles-and-more.com/",
  qantas: "https://www.qantas.com/",
  qatar: "https://www.qatarairways.com/",
  saudia: "https://www.saudia.com/",
  singapore: "https://www.singaporeair.com/",
  smiles: "https://www.smiles.com.br/",
  turkish: "https://www.turkishairlines.com/",
  united: "https://www.united.com/",
  velocity: "https://www.velocityfrequentflyer.com/",
  virginatlantic: "https://www.virginatlantic.com/",
} satisfies Record<MileageProgram, string>;

const PROGRAM_BOOKING_NAMES = {
  aeromexico: "AeroMexico Rewards",
  aeroplan: "Air Canada Aeroplan",
  alaska: "Alaska Mileage Plan",
  american: "American AAdvantage",
  azul: "Azul Fidelidade",
  connectmiles: "ConnectMiles",
  delta: "Delta SkyMiles",
  emirates: "Emirates Skywards",
  ethiopian: "Ethiopian ShebaMiles",
  etihad: "Etihad Guest",
  eurobonus: "SAS EuroBonus",
  finnair: "Finnair Plus",
  flyingblue: "Air France/KLM Flying Blue",
  jetblue: "JetBlue TrueBlue",
  lifemiles: "LifeMiles",
  lufthansa: "Miles & More",
  qantas: "Qantas Frequent Flyer",
  qatar: "Qatar Privilege Club",
  saudia: "Saudia AlFursan",
  singapore: "Singapore KrisFlyer",
  smiles: "GOL Smiles",
  turkish: "Turkish Miles&Smiles",
  united: "United MileagePlus",
  velocity: "Virgin Australia Velocity",
  virginatlantic: "Virgin Atlantic Flying Club",
} satisfies Record<MileageProgram, string>;

const PROGRAM_ALIASES: Record<string, string> = {
  british: "https://www.britishairways.com/",
  british_airways: "https://www.britishairways.com/",
  iberia: "https://www.iberia.com/",
};

const PROGRAM_ALIAS_NAMES: Record<string, string> = {
  british: "British Airways Club",
  british_airways: "British Airways Club",
  iberia: "Iberia Plus",
};

export type BookingLinkFlight = {
  program: string;
  origin: string;
  destination: string;
  date: string;
  cabin: string;
};

/**
 * Sends known programs to their official booking site. A future or unknown
 * source falls back to an exact seats.aero search rather than a dead link.
 */
export function bookingUrlForFlight(flight: BookingLinkFlight): string {
  const source = flight.program.trim().toLowerCase();
  if ((MILEAGE_PROGRAMS as readonly string[]).includes(source)) {
    return PROGRAM_BOOKING_URLS[source as MileageProgram];
  }
  if (PROGRAM_ALIASES[source]) return PROGRAM_ALIASES[source];

  const url = new URL("https://seats.aero/search");
  url.searchParams.set("origins", flight.origin);
  url.searchParams.set("destinations", flight.destination);
  url.searchParams.set("date", flight.date);
  url.searchParams.set("applicable_cabin", flight.cabin);
  url.searchParams.set("show_individual", "true");
  return url.toString();
}

export function bookingProgramName(source: string, fallback?: string): string {
  const normalized = source.trim().toLowerCase();
  if ((MILEAGE_PROGRAMS as readonly string[]).includes(normalized)) {
    return PROGRAM_BOOKING_NAMES[normalized as MileageProgram];
  }
  return PROGRAM_ALIAS_NAMES[normalized] ?? fallback ?? source;
}
