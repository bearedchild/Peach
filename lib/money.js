// All money is integer cents (CAD). Never use floating-point dollars for arithmetic.

/** Parse user input ("1,918.50", "$600", 12.5, "-20") into integer cents. Rejects >2 decimals. */
export function toCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Invalid amount');
    return Math.round(input * 100 + (input < 0 ? -1e-9 : 1e-9));
  }
  if (typeof input !== 'string') throw new Error('Invalid amount');
  let s = input.trim().replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (m[1] === '' && m[2] === undefined)) throw new Error(`Invalid amount: "${input}"`);
  const cents = Number(m[1] || 0) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return neg ? -cents : cents;
}

/** Format cents as CAD, e.g. 191800 -> "$1,918.00". */
export function fmtCad(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-CA');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Split a non-negative total into n parts that sum exactly (largest-remainder, earlier parts get extra cent). */
export function allocateEvenly(totalCents, n) {
  if (n <= 0) return [];
  const base = Math.trunc(totalCents / n);
  let rem = totalCents - base * n;
  return Array.from({ length: n }, () => base + (rem-- > 0 ? 1 : 0));
}

/** Percentage in basis points (1000 = 10%), rounded half-up, integer-only. Non-negative input. */
export function percentOf(cents, bps) {
  return Math.floor((cents * bps + 5000) / 10000);
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
