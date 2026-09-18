import { BillingTerm } from '../catalog/catalog.constants';

/**
 * A metered add-on grants its allowance per month, whatever the billing term.
 * On a yearly term the customer therefore buys twelve allowances up front and
 * the meter has to start over at each month boundary *inside* the Stripe
 * period — Stripe itself only renews once a year and so cannot mark them.
 *
 * Both the meter's rollover and the count of untouched months ahead are read
 * from the same object, so the two can never disagree about where a boundary
 * falls. Boundaries follow calendar months anchored on the period start, since
 * the allowance is sold as a month rather than as 30.4 days.
 */
export interface AllowanceCycle {
  /** start of the month in progress, unix seconds */
  cycleStart: number;
  cycleEnd: number;
  /** 0-based position of that month inside the billing period */
  index: number;
  /** whole months that come after the one in progress */
  monthsAhead: number;
  monthsInPeriod: number;
}

/** Adds calendar months, clamping the day for shorter months (31 Jan → 28 Feb). */
export function addMonths(unixSeconds: number, months: number): number {
  const from = new Date(unixSeconds * 1000);
  const day = from.getUTCDate();
  const target = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
    ),
  );
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return Math.floor(target.getTime() / 1000);
}

export function allowanceCycle(
  periodStart: number,
  periodEnd: number,
  now: number,
  term: BillingTerm,
): AllowanceCycle {
  const monthsInPeriod = term === 'yearly' ? 12 : 1;

  // A monthly term has exactly one allowance and nothing lying ahead, so the
  // cycle is the billing period itself and every reading is unchanged.
  if (monthsInPeriod === 1) {
    return { cycleStart: periodStart, cycleEnd: periodEnd, index: 0, monthsAhead: 0, monthsInPeriod: 1 };
  }

  const bounds: number[] = [];
  for (let k = 0; k <= monthsInPeriod; k++) bounds.push(addMonths(periodStart, k));

  let index = 0;
  for (let k = monthsInPeriod - 1; k >= 0; k--) {
    if (now >= bounds[k]) {
      index = k;
      break;
    }
  }

  return {
    cycleStart: bounds[index],
    cycleEnd: Math.min(bounds[index + 1], periodEnd || bounds[index + 1]),
    index,
    monthsAhead: monthsInPeriod - 1 - index,
    monthsInPeriod,
  };
}
