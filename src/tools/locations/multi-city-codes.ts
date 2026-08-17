/**
 * Seats.aero search-group tokens used by the positioning fallback ladder.
 * Synchronized from the definitions in the sibling aero-connections project.
 */
export type MultiCityCode = { code: string; name: string; airports: string[]; kind: "metro" | "country" | "region" };

export const MULTI_CITY_CODES: readonly MultiCityCode[] = [
  { code: "TYO", name: "Tokyo, Japan Metropolitan Area", airports: ["HND", "NRT"], kind: "metro" },
  { code: "OSA", name: "Osaka, Japan Metropolitan Area", airports: ["KIX", "ITM"], kind: "metro" },
  { code: "CHI", name: "Chicago Metropolitan Area", airports: ["ORD", "MDW"], kind: "metro" },
  { code: "NYC", name: "New York City Metropolitan Area", airports: ["JFK", "LGA", "EWR"], kind: "metro" },
  { code: "QBA", name: "San Francisco Bay Area", airports: ["SFO", "SJC", "OAK"], kind: "metro" },
  { code: "QLA", name: "Los Angeles Metropolitan Area", airports: ["LAX", "BUR", "SNA", "ONT", "LGB"], kind: "metro" },
  { code: "WAS", name: "Washington, DC Metropolitan Area", airports: ["IAD", "DCA", "BWI"], kind: "metro" },
  { code: "LON", name: "London, UK Metropolitan Area", airports: ["LHR", "LGW", "LCY", "STN", "LTN"], kind: "metro" },
  { code: "PAR", name: "Paris, France Metropolitan Area", airports: ["CDG", "ORY"], kind: "metro" },
  { code: "BJS", name: "Beijing, China Metropolitan Area", airports: ["PEK", "PKX"], kind: "metro" },
  { code: "SEL", name: "Seoul, South Korea Metropolitan Area", airports: ["ICN", "GMP"], kind: "metro" },
  { code: "SAO", name: "Sao Paulo, Brazil Metropolitan Area", airports: ["GRU", "CGH", "VCP"], kind: "metro" },
  { code: "RIO", name: "Rio de Janeiro, Brazil Metropolitan Area", airports: ["GIG", "SDU"], kind: "metro" },
  { code: "YTO", name: "Toronto, Canada Metropolitan Area", airports: ["YYZ", "YTZ"], kind: "metro" },

  { code: "USA", name: "United States - Large Airports", airports: ["SFO", "LAX", "JFK", "EWR", "ORD", "ATL", "IAD", "IAH", "DEN", "MIA", "SEA", "DFW", "BOS"], kind: "country" },
  { code: "JPN", name: "Japan - Large Airports", airports: ["HND", "NRT", "KIX", "ITM"], kind: "country" },
  { code: "CAD", name: "Canada - Large Airports", airports: ["YYZ", "YUL", "YVR", "YYC", "YEG", "YOW", "YHZ", "YWG", "YQB"], kind: "country" },
  { code: "AUL", name: "Australia - Large Airports", airports: ["SYD", "MEL", "BNE", "PER", "ADL"], kind: "country" },
  { code: "CNA", name: "Mainland China - Large Airports", airports: ["PEK", "PKX", "PVG", "CAN", "SZX", "CKG", "TFU"], kind: "country" },
  { code: "GER", name: "Germany - Large Airports", airports: ["MUC", "FRA", "BER"], kind: "country" },
  { code: "UKD", name: "United Kingdom - Large Airports", airports: ["LHR", "LGW", "EDI", "MAN"], kind: "country" },
  { code: "MXC", name: "Mexico - Large Airports", airports: ["MEX", "CUN", "GDL", "MTY", "SJD", "PVR"], kind: "country" },
  { code: "BRL", name: "Brazil - Large Airports", airports: ["GRU", "GIG", "CNF", "BSB", "CGH", "SSA", "REC", "POA"], kind: "country" },
  { code: "INDIA", name: "India - Large Airports", airports: ["BOM", "DEL", "HYD", "BLR", "MAA", "COK", "CCU"], kind: "country" },

  { code: "ASA", name: "Asia - Large Airports", airports: ["HND", "NRT", "SIN", "BKK", "ICN", "HKG", "KUL", "TPE", "PVG", "PEK", "PKX"], kind: "region" },
  { code: "EUR", name: "Europe - Large Airports", airports: ["AMS", "ATH", "BCN", "BER", "CDG", "DUB", "FRA", "IST", "LHR", "MUC", "MAD", "FCO", "MXP", "ZRH"], kind: "region" },
  { code: "ANZ", name: "Australia & New Zealand - Large Airports", airports: ["SYD", "MEL", "BNE", "PER", "AKL", "ADL"], kind: "region" },
  { code: "SAM", name: "South America - Large Airports", airports: ["EZE", "SCL", "LIM", "BOG", "GIG", "GRU", "BSB"], kind: "region" },
  { code: "QAF", name: "Africa - Large Airports", airports: ["CAI", "CMN", "ADD", "JNB", "CPT", "NBO"], kind: "region" },
  { code: "SAS", name: "Southeast Asia - Large Airports", airports: ["SIN", "KUL", "BKK", "SGN", "HAN", "MNL", "CGK", "DPS"], kind: "region" },
  { code: "MEA", name: "Middle East - Large Airports", airports: ["DXB", "AUH", "DOH"], kind: "region" },
] as const;

const COUNTRY_CODES: Record<string, string> = {
  "United States": "USA", Japan: "JPN", Canada: "CAD", Australia: "AUL",
  China: "CNA", Germany: "GER", "United Kingdom": "UKD", Mexico: "MXC",
  Brazil: "BRL", India: "INDIA",
};

const REGION_CODES: Record<string, string> = {
  Asia: "ASA", Europe: "EUR", Oceania: "ANZ", "South America": "SAM", Africa: "QAF",
};

export function multiCity(code: string): MultiCityCode | undefined {
  return MULTI_CITY_CODES.find((group) => group.code === code);
}

export function countryGroup(country: string | undefined): MultiCityCode | undefined {
  const code = country ? COUNTRY_CODES[country] : undefined;
  return code ? multiCity(code) : undefined;
}

export function regionGroup(region: string | undefined): MultiCityCode | undefined {
  const code = region ? REGION_CODES[region] : undefined;
  return code ? multiCity(code) : undefined;
}

export function primaryGatewayMetro(country: MultiCityCode | undefined): MultiCityCode | undefined {
  const primary = country?.airports[0];
  return primary ? MULTI_CITY_CODES.find((group) => group.kind === "metro" && group.airports.includes(primary)) : undefined;
}
