/** Cents-per-point used to convert a cash fee into a points-equivalent cost for ranking. */
export const POINTS_VALUE_CPP = 1.5;

/**
 * Approximate USD value per unit, for ranking only — never shown to the
 * user as a converted amount. Limited to currencies seats.aero actually
 * returns; a currency missing here is treated as unconvertible rather than
 * guessed, since a wrong rate would misrank options more than not scoring
 * the fee at all.
 */
const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  CAD: 0.73,
  MXN: 0.05,
  JPY: 0.0067,
  KRW: 0.00073,
};

/**
 * Blends miles and cash fees into one points-equivalent score so ranking
 * reflects total cost, not just points spent — a lower-mileage option with
 * a large fee should not automatically outrank a higher-mileage option with
 * a small one.
 */
export function blendedCost(
  miles: number,
  fees?: number,
  currency = "USD",
): number {
  if (fees == null || fees <= 0) return miles;
  const rate = USD_PER_UNIT[currency.toUpperCase()];
  if (rate == null) return miles;
  const feesUsd = fees * rate;
  return miles + (feesUsd * 100) / POINTS_VALUE_CPP;
}
