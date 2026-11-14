// Financial dates are date-only strings "YYYY-MM-DD" (no time zone, no Date objects stored),
// so a transaction can never shift days between phone and computer.

const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) throw new Error(`Invalid date (want YYYY-MM-DD): ${s}`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date: ${s}`);
  }
  return { y, m: mo, d };
}

export const formatDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addMonthsYM(y, m, n) {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

/** "YYYY-MM" key for a date string. */
export function monthKey(date) {
  const { y, m } = parseDate(date);
  return `${y}-${pad(m)}`;
}
const parseKey = (key) => {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Invalid month key: ${key}`);
  return { y: +m[1], m: +m[2] };
};
export const monthStart = (key) => { const { y, m } = parseKey(key); return formatDate(y, m, 1); };
export const monthEnd = (key) => { const { y, m } = parseKey(key); return formatDate(y, m, daysInMonth(y, m)); };
export function addMonthsKey(key, n) {
  const { y, m } = parseKey(key);
  const r = addMonthsYM(y, m, n);
  return `${r.y}-${pad(r.m)}`;
}
export const inRange = (date, start, end) => date >= start && date <= end;

export function formatRange(start, end) {
  const a = parseDate(start), b = parseDate(end);
  const left = `${MON[a.m - 1]} ${a.d}`;
  const right = `${MON[b.m - 1]} ${b.d}, ${b.y}`;
  return a.y === b.y ? `${left} – ${right}` : `${left}, ${a.y} – ${right}`;
}

/** Calendar month containing `date` (personal budgets and reports). */
export function calendarMonthOf(date) {
  const key = monthKey(date);
  const start = monthStart(key), end = monthEnd(key);
  return { key, start, end, label: formatRange(start, end) };
}

/**
 * Work-expense period containing `date`: startDay of one month through (startDay-1) of the next, inclusive.
 * Default 21st..20th. The 20th belongs to the ending period; the 21st starts the next.
 */
export function expensePeriodFor(date, { startDay = 21 } = {}) {
  const { y, m, d } = parseDate(date);
  let start, end;
  if (startDay === 1) {
    start = formatDate(y, m, 1);
    end = formatDate(y, m, daysInMonth(y, m));
  } else {
    const s = d >= startDay ? { y, m } : addMonthsYM(y, m, -1);
    const e = addMonthsYM(s.y, s.m, 1);
    start = formatDate(s.y, s.m, startDay);
    end = formatDate(e.y, e.m, startDay - 1);
  }
  return { start, end, label: formatRange(start, end) };
}

/** First reimbursement pay date (default the 1st) strictly after the period ends. */
export function expectedReimbursementDate(period, { payDay = 1 } = {}) {
  const { y, m } = parseDate(period.end);
  const same = formatDate(y, m, payDay);
  if (same > period.end) return same;
  const n = addMonthsYM(y, m, 1);
  return formatDate(n.y, n.m, payDay);
}

/** Today's date on THIS device as YYYY-MM-DD (local calendar date, never UTC-shifted). */
export function todayLocal() {
  const n = new Date();
  return formatDate(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
