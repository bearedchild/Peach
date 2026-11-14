import { expensePeriodFor, expectedReimbursementDate, inRange } from './dates.js';
import { sum } from './money.js';

// Editable defaults (stored in the database settings in later stages).
export const DEFAULT_RULES = {
  startDay: 21,            // period runs 21st .. 20th
  payDay: 1,               // reimbursed on the 1st after the period ends
  carryOverUnused: false,  // unused cap expires at period end by default
  budgets: {
    communications: { label: 'Communications', capCents: 17500 },
    fuel: { label: 'Car fuel', capCents: 33000 },
  },
};

/*
 * An "expense line" is one reimbursement-relevant slice of a transaction:
 * { id, date, amountCents (>0 = spend), budget: 'communications'|'fuel', eligible: bool,
 *   exception?: { approved: bool, reimbursableCents, note } }
 * The category (e.g. Subscriptions) lives separately on the line; eligibility is independent of it.
 */

const isException = (l) => !!(l.exception && l.exception.approved === true);

/**
 * Chronologically fill the regular cap with eligible lines. Approved work-trip exceptions sit
 * outside the cap and never consume or inflate it. Returns { [lineId]: { reimbursableCents, kind } }.
 */
export function allocateReimbursable(lines, capCents, carryInCents = 0) {
  const cap = capCents + carryInCents;
  let used = 0;
  const out = {};
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  for (const l of sorted) {
    if (isException(l)) {
      if (!l.exception.note || !String(l.exception.note).trim()) {
        throw new Error(`Work-trip exception on ${l.id} needs a note`);
      }
      const r = Math.min(Math.max(l.exception.reimbursableCents ?? 0, 0), Math.max(l.amountCents, 0));
      out[l.id] = { reimbursableCents: r, kind: 'exception' };
    } else if (l.eligible) {
      const room = Math.max(0, cap - used);
      const r = Math.min(room, Math.max(l.amountCents, 0));
      used += r;
      out[l.id] = { reimbursableCents: r, kind: 'regular' };
    } else {
      out[l.id] = { reimbursableCents: 0, kind: 'ineligible' };
    }
  }
  return out;
}

/** Summary for one reimbursement budget within one period (lines already filtered to that budget+period). */
export function summarizeBudget(lines, capCents, carryInCents = 0) {
  const alloc = allocateReimbursable(lines, capCents, carryInCents);
  const of = (kind) => lines.filter((l) => alloc[l.id].kind === kind);
  const regular = of('regular'), exc = of('exception'), inel = of('ineligible');
  const eligibleSpendCents = sum(regular.map((l) => l.amountCents));
  const regularReimbursableCents = sum(regular.map((l) => alloc[l.id].reimbursableCents));
  const exceptionSpendCents = sum(exc.map((l) => l.amountCents));
  const exceptionReimbursableCents = sum(exc.map((l) => alloc[l.id].reimbursableCents));
  const ineligibleSpendCents = sum(inel.map((l) => l.amountCents));
  const effectiveCapCents = capCents + carryInCents;
  const totalSpendCents = eligibleSpendCents + exceptionSpendCents + ineligibleSpendCents;
  const totalReimbursableCents = regularReimbursableCents + exceptionReimbursableCents;
  const remainingLimitCents = Math.max(0, effectiveCapCents - regularReimbursableCents);
  return {
    capCents, effectiveCapCents,
    eligibleSpendCents,
    regularReimbursableCents,
    remainingLimitCents,
    personalExcessCents: eligibleSpendCents - regularReimbursableCents,
    exceptionSpendCents,
    exceptionReimbursableCents,
    exceptionPersonalCents: exceptionSpendCents - exceptionReimbursableCents,
    ineligibleSpendCents,
    totalSpendCents,
    totalReimbursableCents,
    totalPersonalCents: totalSpendCents - totalReimbursableCents,
    carryOutCents: remainingLimitCents, // only used when rules.carryOverUnused is true
    lineAllocations: alloc,
  };
}

/** Summarize every reimbursement budget for the period that contains `anyDateInPeriod`. */
export function summarizePeriod(lines, anyDateInPeriod, rules = DEFAULT_RULES, carryIn = {}) {
  const period = expensePeriodFor(anyDateInPeriod, { startDay: rules.startDay });
  const inPeriod = lines.filter((l) => inRange(l.date, period.start, period.end));
  const budgets = {};
  for (const [key, cfg] of Object.entries(rules.budgets)) {
    budgets[key] = summarizeBudget(inPeriod.filter((l) => l.budget === key), cfg.capCents, carryIn[key] ?? 0);
  }
  return {
    period,
    expectedReimbursementDate: expectedReimbursementDate(period, { payDay: rules.payDay }),
    budgets,
    totalReimbursableCents: sum(Object.values(budgets).map((b) => b.totalReimbursableCents)),
    totalPersonalCents: sum(Object.values(budgets).map((b) => b.totalPersonalCents)),
  };
}

/** Group a period's eligible lines into one submission, keeping per-budget subtotals. */
export function buildSubmission(lines, anyDateInPeriod, rules = DEFAULT_RULES, { submittedOn = null } = {}) {
  const s = summarizePeriod(lines, anyDateInPeriod, rules);
  const subtotals = {};
  for (const [k, b] of Object.entries(s.budgets)) {
    subtotals[k] = {
      regularCents: b.regularReimbursableCents,
      exceptionCents: b.exceptionReimbursableCents,
      totalCents: b.totalReimbursableCents,
    };
  }
  const lineIds = lines
    .filter((l) => inRange(l.date, s.period.start, s.period.end))
    .filter((l) => (l.eligible || isException(l)))
    .map((l) => l.id);
  return {
    periodStart: s.period.start,
    periodEnd: s.period.end,
    periodLabel: s.period.label,
    submittedOn,
    expectedOn: s.expectedReimbursementDate,
    requestedCents: s.totalReimbursableCents,
    subtotals,
    lineIds,
    status: submittedOn ? 'submitted' : 'not_submitted',
  };
}

// ---------- Claims (submission -> payment) ----------

export const CLAIM_STATUSES = ['not_submitted', 'submitted', 'approved', 'paid', 'adjusted'];

/**
 * claim: { requestedCents, approvedCents|null, receipts:[{date, amountCents}], status, isOpening? }
 * Opening claims (from before the tracking start) need no underlying transactions.
 */
export function claimSummary(claim) {
  const received = sum((claim.receipts ?? []).map((r) => r.amountCents));
  const base = claim.approvedCents ?? claim.requestedCents;
  const outstanding = Math.max(0, base - received);
  const adjusted = claim.approvedCents != null && claim.approvedCents < claim.requestedCents;
  return {
    requestedCents: claim.requestedCents,
    approvedCents: claim.approvedCents ?? null,
    receivedCents: received,
    outstandingCents: outstanding,
    overReceivedCents: Math.max(0, received - base),
    // The part the employer will not pay becomes a personal cost.
    shortfallToPersonalCents: adjusted ? claim.requestedCents - claim.approvedCents : 0,
    suggestedStatus: adjusted && outstanding === 0 && received > 0 ? 'adjusted'
      : outstanding === 0 && received > 0 ? 'paid'
      : claim.approvedCents != null ? 'approved'
      : claim.status,
  };
}

/**
 * Record money received against a claim. This settles the claim; it is NOT new income:
 * it adds cash to an account but nothing to "available to budget".
 */
export function applyReceipt(claim, { date, amountCents }) {
  const next = { ...claim, receipts: [...(claim.receipts ?? []), { date, amountCents }] };
  return {
    claim: next,
    accounting: {
      cashInCents: amountCents,
      settlesClaimCents: amountCents,
      addsToAvailableToBudgetCents: 0,
      countsAsIncomeSource: 'reimbursement', // tagged for annual reporting only
    },
  };
}

export const pendingReimbursementCents = (claims) =>
  sum(claims.map((c) => claimSummary(c).outstandingCents));
