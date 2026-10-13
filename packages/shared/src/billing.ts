// The billing month the dashboard's /analytics page counts in (decision
// record: #81). Anthropic grants the monthly credit on the 5th, so spend is
// summed from the 5th to the 4th of the next month instead of over a calendar
// month. Dates are UTC, like the cost report the figures come from (#48).

/** Day of the month the credit is granted, and so the first day of a billing month. */
export const BILLING_START_DAY = 5;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const startDay = pad(BILLING_START_DAY, 2);

/** The billing month a `YYYY-MM-DD` date falls in, named `YYYY-MM` after the calendar month it starts in. */
export function billingMonth(date: string): string {
  const month = date.slice(0, 7);
  // Same-width digits, so the strings order like the dates.
  if (date.slice(8, 10) >= startDay) return month;
  const [year, mon] = month.split("-").map(Number);
  return mon === 1 ? `${pad(year - 1, 4)}-12` : `${pad(year, 4)}-${pad(mon - 1, 2)}`;
}

/** First day of a `YYYY-MM` billing month and the day after its last, as `YYYY-MM-DD`. */
export function billingBounds(month: string): { start: string; end: string } {
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${pad(year + 1, 4)}-01` : `${pad(year, 4)}-${pad(mon + 1, 2)}`;
  return { start: `${month}-${startDay}`, end: `${next}-${startDay}` };
}
