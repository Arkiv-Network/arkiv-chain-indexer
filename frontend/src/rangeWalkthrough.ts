/** A small teaching model, independent of the live API and cryptographic verifier. */
export const WALKTHROUGH_PRICES = [9, 10, 15, 20, 21] as const;
export type ExampleBoundary = "inclusive" | "exclusive" | "unbounded";
export interface ExampleBounds {
  lower: string;
  upper: string;
  lowerBoundary: ExampleBoundary;
  upperBoundary: ExampleBoundary;
}
export function evaluateExample(bounds: ExampleBounds) {
  const parse = (value: string, boundary: ExampleBoundary) => {
    if (boundary === "unbounded") return null;
    if (!/^-?\d+$/.test(value)) throw new Error("Use whole numbers for this example.");
    return BigInt(value);
  };
  try {
    const lower = parse(bounds.lower, bounds.lowerBoundary);
    const upper = parse(bounds.upper, bounds.upperBoundary);
    if (lower === null && upper === null) throw new Error("Keep at least one bound, as the range API requires.");
    const values = WALKTHROUGH_PRICES.map(value => {
      const n = BigInt(value);
      const below = lower !== null && (n < lower || (n === lower && bounds.lowerBoundary === "exclusive"));
      const above = upper !== null && (n > upper || (n === upper && bounds.upperBoundary === "exclusive"));
      return { value, matches: !below && !above, reason: below ? "Outside lower bound" : above ? "Outside upper bound" : "Included" };
    });
    return { values, error: "" };
  } catch (error) {
    return { values: [], error: error instanceof Error ? error.message : "Invalid bounds" };
  }
}
