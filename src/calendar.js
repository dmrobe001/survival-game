// The year: a fixed temperate climate with a real winter. The player never
// sees a date; they feel it in the temperature, the length of the days and
// what is ripe. Every game starts in mid-July.
//
//   temperature   warmest in mid-July; mid-January is 16 °C colder
//   daylight      15.5 h at midsummer, 8.5 h at midwinter (solar noon 13:00)
//   seasons       the planner's four blocks: Dec-Feb, Mar-May, Jun-Aug, Sep-Nov

export const START_DOY = 200; // 19 July
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START = MONTH_DAYS.reduce((a, d, i) => (a.push(i ? a[i - 1] + MONTH_DAYS[i - 1] : 0), a), []);
export const monthOf = (doy) => { let m = 11; while (MONTH_START[m] > doy) m--; return m; };

export const dayOfYear = (s) => ((s.doy0 ?? START_DOY) + Math.floor(s.t / 1440)) % 365;
export const seasonalT = (doy) => 8 * (Math.cos((2 * Math.PI * (doy - 200)) / 365) - 1);
export const daylight = (doy) => 12 + 3.5 * Math.cos((2 * Math.PI * (doy - 172)) / 365);

export const SEASONS = [
  { name: 'winter', months: [11, 0, 1] },
  { name: 'spring', months: [2, 3, 4] },
  { name: 'summer', months: [5, 6, 7] },
  { name: 'autumn', months: [8, 9, 10] },
].map((S) => Object.assign(S, { days: S.months.reduce((a, m) => a + MONTH_DAYS[m], 0), mid: (MONTH_START[S.months[1]] + 15) % 365 }));
export const seasonOf = (doy) => SEASONS.findIndex((S) => S.months.includes(monthOf(doy)));
// Days left in the season `doy` falls in.
export function daysLeftInSeason(doy) {
  const S = SEASONS[seasonOf(doy)], last = S.months[2];
  const end = (MONTH_START[last] + MONTH_DAYS[last]) % 365;
  return ((end - doy + 365) % 365) || 365;
}

// Standing stock of a seasonal resource through the year, as a fraction of
// a full place: grows by perYear x grow[month] spread over the month, and
// loses `loss` of itself a day to animals and rot. Settles after a few
// simulated years; returns one value per day of the year.
export function stockProfile(grow, loss, perYear) {
  const out = new Array(365).fill(0);
  let x = 0;
  for (let y = 0; y < 4; y++) for (let d = 0; d < 365; d++) {
    const m = monthOf(d);
    x = Math.max(0, x + (perYear * grow[m]) / MONTH_DAYS[m] - loss * x);
    if (y === 3) out[d] = x;
  }
  return out;
}
