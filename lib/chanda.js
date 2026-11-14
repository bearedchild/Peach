import { addMonthsKey, daysInMonth, formatDate, monthKey, monthStart, formatRange } from './dates.js';
import { percentOf, sum } from './money.js';

// Editable defaults (stored per user in the database in later stages).
export const DEFAULT_FUNDS = [
  { id: 'wasiyyat', name: 'Wasiyyat', kind: 'percent', percentBps: 1000, cycleStartMonth: 7 },
  { id: 'jalsa_salana', name: 'Jalsa Salana', kind: 'percent', percentBps: 100, cycleStartMonth: 7 },
  { id: 'khuddam_membership', name: 'Khuddam Membership', kind: 'percent', percentBps: 100, cycleStartMonth: 11 },
  { id: 'khuddam_ijtema', name: 'Khuddam Ijtema', kind: 'annual', annualCents: 4800, cycleStartMonth: 11 },
  { id: 'tahrik_e_jadid', name: 'Tahrik e Jadid', kind: 'annual', annualCents: 5000, cycleStartMonth: 11 },
];

/** Annual cycle containing `date` for a fund whose cycle starts on the 1st of `startMonth`. */
export function cycleFor(date, startMonth) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const startKey = `${startYear}-${String(startMonth).padStart(2, '0')}`;
  const months = Array.from({ length: 12 }, (_, i) => addMonthsKey(startKey, i));
  const endKey = months[11];
  const [ey, em] = endKey.split('-').map(Number);
  const start = monthStart(startKey);
  const end = formatDate(ey, em, daysInMonth(ey, em));
  return { start, end, startKey, months, label: formatRange(start, end) };
}

/** Allowance in effect on a date, from an effective-dated schedule [{effectiveFrom, cents}]. null if none yet. */
export function allowanceOn(schedule, date) {
  const hit = [...schedule].filter((s) => s.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return hit ? hit.cents : null;
}

function allocationsFrom(payments) {
  const byMonth = {};
  for (const p of payments) {
    if (p.monthAmounts) {
      for (const [mk, c] of Object.entries(p.monthAmounts)) byMonth[mk] = (byMonth[mk] ?? 0) + c;
    }
  }
  return byMonth;
}

/**
 * Status of one fund in one cycle.
 * payments: [{id, paidOn, cycleStart, amountCents, monthAmounts?:{'YYYY-MM':cents}, kind:'payment'|'opening'|'prepaid'|'adjustment', note}]
 * setup (for cycles that began before trackingStart): { confirmed: true, priorObligationCents? }
 * A monthly set-aside is never a payment: only entries in `payments` reduce what is owed.
 */
export function cycleStatus({ fund, cycleStart, asOf, allowanceSchedule, payments, trackingStart, setup }) {
  const cycle = cycleFor(cycleStart, fund.cycleStartMonth);
  const mine = payments.filter((p) => p.cycleStart === cycle.start);
  const paidCents = sum(mine.map((p) => p.amountCents));
  const asOfMonth = monthKey(asOf);
  const trackingMonth = monthKey(trackingStart);
  const startedBeforeTracking = cycle.start < trackingStart;

  const base = { fund: fund.id, name: fund.name, cycle, paidCents,
    payments: [...mine].sort((a, b) => a.paidOn.localeCompare(b.paidOn)) };

  // Never assume nothing was owed or paid before the tracking start.
  if (startedBeforeTracking && !setup?.confirmed) {
    return { ...base, needsSetup: true, obligationCents: null, remainingCents: null };
  }

  const alloc = allocationsFrom(mine);
  let obligationCents, accruedCents = null, rows = null;

  if (fund.kind === 'percent') {
    rows = cycle.months.map((mk) => {
      const prior = mk < trackingMonth;
      const a = allowanceOn(allowanceSchedule, `${mk}-01`);
      const dueCents = prior ? null : (a == null ? null : percentOf(a, fund.percentBps));
      const allocatedCents = alloc[mk] ?? 0;
      return { month: mk, dueCents, allocatedCents,
        balanceCents: dueCents == null ? null : dueCents - allocatedCents, priorToTracking: prior };
    });
    const priorMonths = cycle.months.filter((mk) => mk < trackingMonth);
    let prior = 0;
    if (priorMonths.length) {
      if (setup?.priorObligationCents != null) prior = setup.priorObligationCents;
      else {
        const computed = priorMonths.map((mk) => allowanceOn(allowanceSchedule, `${mk}-01`));
        if (computed.some((c) => c == null)) return { ...base, needsSetup: true, obligationCents: null, remainingCents: null };
        prior = sum(computed.map((a) => percentOf(a, fund.percentBps)));
      }
    }
    if (rows.some((r) => !r.priorToTracking && r.dueCents == null)) {
      return { ...base, needsSetup: true, obligationCents: null, remainingCents: null }; // no allowance rate on file
    }
    obligationCents = prior + sum(rows.filter((r) => !r.priorToTracking).map((r) => r.dueCents));
    const dueThrough = sum(rows.filter((r) => !r.priorToTracking && r.month <= asOfMonth).map((r) => r.dueCents));
    accruedCents = prior + dueThrough;
  } else {
    obligationCents = setup?.annualOverrideCents ?? fund.annualCents; // lump sum; accrual not applicable
  }

  const remainingCents = Math.max(0, obligationCents - paidCents);
  const overpaidCents = Math.max(0, paidCents - obligationCents);
  const paidAheadCents = sum(Object.entries(alloc).filter(([mk]) => mk > asOfMonth).map(([, c]) => c));

  // Suggestions only; they are not payments and never reduce what is owed.
  let suggestedMonthlyCents, suggestionKind;
  if (fund.kind === 'percent') {
    const cur = rows.find((r) => r.month === asOfMonth);
    suggestedMonthlyCents = cur && cur.balanceCents != null ? Math.max(0, cur.balanceCents) : 0;
    suggestionKind = 'monthly_amount';
  } else {
    const monthsLeft = Math.max(1, cycle.months.filter((mk) => mk >= asOfMonth).length);
    suggestedMonthlyCents = Math.ceil(remainingCents / monthsLeft);
    suggestionKind = 'budgeting_suggestion'; // NOT a mandatory monthly payment
  }

  return {
    ...base,
    needsSetup: false,
    obligationCents,
    accruedCents,
    dueNowCents: accruedCents == null ? null : Math.max(0, accruedCents - paidCents),
    remainingCents,
    paidAheadCents,
    overpaidCents,
    overpaymentNeedsConfirmation: overpaidCents > 0, // never auto-carried into another cycle
    suggestedMonthlyCents,
    suggestionKind,
    rows,
  };
}
