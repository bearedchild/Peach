import { addMonthsYM, daysBetween, formatDate, lastDueDate, nextDueDate, parseDate } from './dates.js';
import { sum } from './money.js';

const priorMonthSame = (date, day) => { const { y, m } = parseDate(date); const p = addMonthsYM(y, m, -1); return formatDate(p.y, p.m, day); };

/**
 * Credit-card payment reminders.
 * accounts: [{id,name,type,archivedAt,dueDay,minPaymentCents,remindDays}]
 * txns: [{accountId,kind,amountCents,date}]  (a payment is a transfer INTO the card)
 * A card is treated as paid for a due date once transfers into it since the prior due date reach the minimum
 * (any payment counts if no minimum is set). Overdue cards stay flagged for 10 days after the due date.
 */
export function dueReminders(accounts, txns, today) {
  const out = [];
  for (const a of accounts) {
    if (a.type !== 'credit_card' || a.archivedAt || !a.dueDay) continue;
    const need = Math.max(a.minPaymentCents ?? 0, 1);
    const paidSince = (afterExclusive) => sum(txns
      .filter((t) => t.accountId === a.id && t.kind === 'transfer' && t.amountCents > 0 && t.date > afterExclusive && t.date <= today)
      .map((t) => t.amountCents));

    const last = lastDueDate(a.dueDay, today);
    const sinceLast = daysBetween(last, today);
    if (sinceLast > 0 && sinceLast <= 10 && paidSince(priorMonthSame(last, a.dueDay)) < need) {
      out.push({ account: a, dueOn: last, daysAway: -sinceLast, level: 'overdue', minCents: a.minPaymentCents ?? null });
      continue;
    }
    const dueOn = nextDueDate(a.dueDay, today);
    const daysAway = daysBetween(today, dueOn);
    if (daysAway > (a.remindDays ?? 3)) continue;
    if (paidSince(priorMonthSame(dueOn, a.dueDay)) >= need) continue;
    out.push({ account: a, dueOn, daysAway, level: daysAway === 0 ? 'today' : 'soon', minCents: a.minPaymentCents ?? null });
  }
  return out.sort((x, y) => x.daysAway - y.daysAway);
}

export function dueLabel(r) {
  if (r.level === 'overdue') return `Was due ${-r.daysAway} day${r.daysAway === -1 ? '' : 's'} ago`;
  if (r.daysAway === 0) return 'Due today';
  if (r.daysAway === 1) return 'Due tomorrow';
  return `Due in ${r.daysAway} days`;
}

/** Calendar file (.ics) with a monthly repeating all-day event and an alert at 9am, `remindDays` before. */
export function buildCardIcs(a, today, nowStamp) {
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const next = nextDueDate(a.dueDay, today).replaceAll('-', '');
  const n = a.remindDays ?? 3;
  const hours = n * 24 - 9;
  const trigger = hours >= 0 ? `-PT${hours}H` : `PT${-hours}H`;
  const min = a.minPaymentCents != null ? ` Minimum payment: $${(a.minPaymentCents / 100).toFixed(2)}.` : '';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Peach//Budget//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:peach-card-${a.id}@peach`, `DTSTAMP:${nowStamp}`,
    `DTSTART;VALUE=DATE:${next}`, `RRULE:FREQ=MONTHLY;BYMONTHDAY=${a.dueDay}`,
    `SUMMARY:${esc(`Credit card due: ${a.name}`)}`, `DESCRIPTION:${esc(`Pay ${a.name}.${min}`)}`,
    'BEGIN:VALARM', `TRIGGER:${trigger}`, 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${a.name} payment due soon`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}
