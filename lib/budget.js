import { allocateReimbursable, DEFAULT_RULES } from './reimbursement.js';
import { expensePeriodFor, monthKey } from './dates.js';
import { sum } from './money.js';

/**
 * Personal spending by category for one calendar month (YYYY-MM).
 * Each expense line: { id, date, amountCents, categoryId, budget?, eligible?, exception? }.
 * The reimbursable part of a reimbursement-eligible line is NOT permanent personal spending,
 * so it is removed here and tracked as a receivable instead. Reimbursement caps are applied
 * per 21st-20th period (across the whole period, even when it straddles two calendar months).
 * Categories listed in earmarkedCategoryIds (e.g. Rent) are funded by rent funding, not the allowance,
 * so they are reported separately and do not reduce personal budget.
 */
/**
 * Reimbursable amount per expense line, applying each budget's cap within each 21st-20th period
 * (a period can straddle two calendar months). Returns { [lineId]: { reimbursableCents, kind } }.
 */
export function reimbursableByLine(lines, rules = DEFAULT_RULES) {
  const out = {};
  const groups = new Map();
  for (const l of lines) {
    if (!l.budget) continue;
    const p = expensePeriodFor(l.date, { startDay: rules.startDay });
    const key = `${l.budget}|${p.start}`;
    if (!groups.has(key)) groups.set(key, { budget: l.budget, lines: [] });
    groups.get(key).lines.push(l);
  }
  for (const g of groups.values()) {
    const cfg = rules.budgets[g.budget];
    const cap = cfg ? cfg.capCents : 0; // unknown budget = nothing reimbursable; null = uncapped
    Object.assign(out, allocateReimbursable(g.lines, cap));
  }
  return out;
}

/**
 * Personal spending by category for one calendar month (YYYY-MM).
 * The reimbursable part of a reimbursement-eligible line is NOT permanent personal spending,
 * so it is removed here and tracked as a receivable instead.
 * Categories in earmarkedCategoryIds (e.g. Rent) are funded by rent funding, not the allowance,
 * so they are reported separately and do not reduce personal budget.
 */
export function personalSpendByCategory(lines, month, rules = DEFAULT_RULES, { earmarkedCategoryIds = [] } = {}) {
  const alloc = reimbursableByLine(lines, rules);
  const byCategory = {};
  let earmarkedSpendCents = 0;
  for (const l of lines) {
    if (monthKey(l.date) !== month) continue;
    if (earmarkedCategoryIds.includes(l.categoryId)) { earmarkedSpendCents += l.amountCents; continue; }
    const reimb = alloc[l.id]?.reimbursableCents ?? 0;
    const c = (byCategory[l.categoryId] ??= { grossCents: 0, reimbursableCents: 0, personalCents: 0 });
    c.grossCents += l.amountCents;
    c.reimbursableCents += reimb;
    c.personalCents += l.amountCents - reimb;
  }
  return {
    byCategory,
    totalPersonalCents: sum(Object.values(byCategory).map((c) => c.personalCents)),
    totalGrossCents: sum(Object.values(byCategory).map((c) => c.grossCents)),
    earmarkedSpendCents,
  };
}

/**
 * Zero-based budgeting: only money meant for personal budgeting counts.
 * Rent funding and reimbursement receipts are deliberately NOT inputs here.
 */
export function moneyToBudget({ allowanceReceivedCents, carryoverCents = 0, otherBudgetableCents = 0, assignedCents }) {
  const available = allowanceReceivedCents + carryoverCents + otherBudgetableCents;
  const unassigned = available - assignedCents;
  return {
    availableToBudgetCents: available,
    unassignedCents: unassigned,
    state: unassigned === 0 ? 'zero_based' : unassigned > 0 ? 'unassigned' : 'over_assigned',
  };
}

/** Rent funding is held for rent until it settles the related credit-card balance. */
export function rentEarmark({ fundingReceivedCents, rentChargedToCardCents, settledCents }) {
  return {
    heldForRentCents: Math.max(0, fundingReceivedCents - settledCents),
    unsettledRentOnCardCents: Math.max(0, rentChargedToCardCents - settledCents),
    freelySpendableCents: 0, // never spendable on other things
  };
}

/** Progress state with text + icon, not just colour. Warning threshold is editable. */
export function categoryStatus(plannedCents, spentCents, { warnAt = 0.9 } = {}) {
  const remainingCents = plannedCents - spentCents;
  const ratio = plannedCents > 0 ? spentCents / plannedCents : spentCents > 0 ? Infinity : 0;
  if (remainingCents < 0) return { state: 'over', icon: '⚠', label: 'Overspent', remainingCents, ratio };
  if (ratio >= warnAt) return { state: 'warning', icon: '◐', label: 'Almost used', remainingCents, ratio };
  return { state: 'ok', icon: '✓', label: 'On track', remainingCents, ratio };
}
