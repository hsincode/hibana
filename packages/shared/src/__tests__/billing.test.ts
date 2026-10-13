import { describe, expect, test } from "bun:test";
import { BILLING_START_DAY, billingBounds, billingMonth } from "../billing";

describe("billing month", () => {
  test("starts on the 5th", () => {
    expect(BILLING_START_DAY).toBe(5);
  });

  test("a date belongs to the month whose 5th came last", () => {
    expect(billingMonth("2026-10-05")).toBe("2026-10");
    expect(billingMonth("2026-10-31")).toBe("2026-10");
    expect(billingMonth("2026-11-04")).toBe("2026-10");
    expect(billingMonth("2026-11-05")).toBe("2026-11");
    expect(billingMonth("2026-10-04")).toBe("2026-09");
    // Across the year.
    expect(billingMonth("2027-01-01")).toBe("2026-12");
    expect(billingMonth("2027-01-05")).toBe("2027-01");
  });

  test("runs from the 5th to the next 5th, which is not part of it", () => {
    expect(billingBounds("2026-10")).toEqual({ start: "2026-10-05", end: "2026-11-05" });
    expect(billingBounds("2026-12")).toEqual({ start: "2026-12-05", end: "2027-01-05" });
    expect(billingBounds("2026-02")).toEqual({ start: "2026-02-05", end: "2026-03-05" });
  });
});
