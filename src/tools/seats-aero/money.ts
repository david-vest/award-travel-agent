const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND"]);

/** seats.aero reports taxes in the currency's minor unit (for example cents). */
export function normalizeTaxes(
  amount: number | undefined,
  currency: string | undefined,
): number | undefined {
  // Cached-search records frequently use 0 when tax data was not populated;
  // treating that sentinel as a real $0 fee produces materially false advice.
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  return ZERO_DECIMAL_CURRENCIES.has((currency ?? "").toUpperCase())
    ? amount
    : amount / 100;
}
