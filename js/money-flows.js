/**
 * money-flows.js — where a month's or a year's money went, read from the
 * ledger, for the Flows view.
 *
 * One bar per source of money: each paycheck, pension or benefit, each account
 * that paid for something or sent money on, and the dividends, interest,
 * refunds and windfalls that came in. A bar's parts are where its money went,
 * each one of three kinds: into the household's accounts, spent, or paid in
 * tax.
 *
 * ── Why the ledger ───────────────────────────────────────────────────
 *
 * A rule's percentage applied to a balance is not what moves. A paycheck's
 * 401(k) percentage is of gross pay, its Roth percentage of what is left after
 * that, and the backstop receives whatever remains, whatever its own rule says.
 * The ledger records what each account paid, so the bars are what happened.
 *
 * ── Reading each event ───────────────────────────────────────────────
 *
 * FLOW_TREATMENT declares every EventType and moneyFlows() throws on an
 * unknown one, as annual-expenditure.js does, so a new kind of movement cannot
 * quietly drop out of the bars. A movement counts once, from the account that
 * paid it: its debit. The credit on the other side is the same money. An event
 * counts in the month its causal chain began (bookedMonthIndex in trace.js),
 * which is the month the figures book it in.
 *
 * ── Agreement with Month & Year Details ──────────────────────────────
 *
 * The tiles restate that section's figures for what moved: Income received,
 * less income that had no account to go to; Expenses, less bills that could not
 * be paid; Taxes, less property tax accrued but not yet drawn (the escrow draws
 * a month's property tax in the month after). So where nothing needs
 * explaining the two sections show the same dollars. The bars add up to the
 * same totals before rounding, and tests/money-flows.mjs holds them to it
 * across the corpus.
 *
 * A gross-up draws a bill plus the capital-gains tax the draw will owe, in one
 * debit; TAX_PROVISION names the tax part. The debit is split: the bill is
 * spent, the provision is tax, as the section books it.
 *
 * Each bar's total is rounded once, and its parts are rounded to add up to it.
 */

import { EventType, EventKind } from './sim-event.js';
import { TraceKind, chainFor, bookedMonthIndex } from './trace.js';
import { InstrumentType } from './instruments/instrument.js';
import { AssetGroup, classifyAssetGroup } from './asset-groups.js';
import { Metric } from './metric.js';
import { wholeDollars, lastHistoryIndex, flowsOver, headlineAsShown } from './month-summary.js';
import { DateInt } from './utils/date-int.js';

/** What a part of a bar did with its money. */
export const FlowKind = Object.freeze({
    ACCOUNTS: 'accounts',
    SPENT:    'spent',
    TAX:      'tax',
});

/** What could not be paid, or placed. None of it is in the bars. */
export const UnpaidKind = Object.freeze({
    SPENT:  'spent',
    TAX:    'tax',
    /** Pay or a benefit with no account to deposit it in. */
    INCOME: 'income',
    /** A move between accounts, or sale proceeds, that had nowhere to go. */
    MOVE:   'move',
});

/** What a bar's money is. */
export const SourceRole = Object.freeze({
    /** A paycheck, pension or benefit. */
    INCOME:   'income',
    /** Dividends and interest paid into the household's accounts. */
    YIELD:    'yield',
    /** Tax coming back. */
    REFUND:   'refund',
    /** A one-time windfall, such as an inheritance. Not income. */
    ONE_TIME: 'oneTime',
    /** One of the household's accounts paying out. */
    ACCOUNT:  'account',
});

/**
 * How a part's money moved. The Rules in force list claims the parts a rule
 * made; the rest it shows as automatic.
 */
export const FlowVia = Object.freeze({
    RULE:       'rule',        // a transfer a rule made each month
    RULE_AT_CLOSE: 'ruleAtClose', // a rule's close percentage, moving a closing account's balance
    SETTLEMENT: 'settlement',  // a mortgage payment or property cost, from the account its rule names
    BACKSTOP:   'backstop',    // a bill no rule covers, drawn from the everyday accounts
    LEFTOVER:   'leftover',    // take-home pay no rule claimed
    RMD:        'rmd',
    CLOSE:      'close',       // a closing account's balance no rule claimed, or sale proceeds
    OPENING:    'opening',     // paying for an asset as it starts, such as a down payment
    SPILLOVER:  'spillover',   // an account ran short and the next one paid
    PROVISION:  'provision',   // the capital-gains tax part of a gross-up
    FICA:       'fica',
    WITHHELD:   'withheld',    // income tax withheld from pay, a pension, or a withdrawal
    ESTIMATED:  'estimated',   // income tax paid from an account as the year goes
    CAPITAL_GAINS_TAX: 'capitalGainsTax',
    TRUE_UP:    'trueUp',
    NIIT:       'niit',
    ONE_TIME:   'oneTime',
    YIELD:      'yield',
    REFUND:     'refund',
});

/**
 * How each EventType is read. Every type in the enum is listed; see the
 * header for why.
 *
 *   'move'      — a debit is money sent somewhere: the event names where.
 *   'spillover' — the part of a draw a fallback account paid, because the
 *                 first ran short. It pays whatever that draw was paying.
 *   'provision' — no money moves: it names the tax part of a gross-up.
 *   'tax'       — a debit is tax paid; a credit is a refund.
 *   'yield'     — a credit is a dividend or interest paid into the account.
 *   'oneTime'   — a credit is a windfall; a debit, a one-off purchase.
 *   'unpaid'    — what the plan could not pay. No money moved; counted
 *                 beside the bars, never in them.
 *   'excluded'  — growth, accruals, recognition: nothing left one account
 *                 for another. A mortgage's or a property's costs are drawn
 *                 by a SETTLEMENT, which is counted; these only name them.
 */
export const FLOW_TREATMENT = Object.freeze({
    [EventType.TRANSFER]:                'move',
    [EventType.SETTLEMENT]:              'move',
    [EventType.GROSS_UP]:                'move',
    [EventType.SPILLOVER]:               'spillover',
    [EventType.TAX_PROVISION]:           'provision',

    [EventType.FICA_WITHHOLDING]:        'tax',
    [EventType.INCOME_TAX_WITHHOLDING]:  'tax',
    [EventType.CAPITAL_GAINS_TAX]:       'tax',
    [EventType.TAX_TRUE_UP]:             'tax',
    [EventType.NIIT_ASSESSED]:           'tax',

    [EventType.DIVIDEND]:                'yield',
    [EventType.INTEREST_INCOME]:         'yield',
    [EventType.ONE_TIME]:                'oneTime',
    [EventType.UNFUNDED]:                'unpaid',

    [EventType.ASSET_GROWTH]:            'excluded',
    [EventType.EXPENSE_INFLATION]:       'excluded',
    [EventType.INCOME_GROWTH]:           'excluded',
    [EventType.MORTGAGE_PRINCIPAL]:      'excluded',
    [EventType.MORTGAGE_INTEREST]:       'excluded',
    [EventType.PROPERTY_TAX]:            'excluded',
    [EventType.PROPERTY_TAX_ESCROW]:     'excluded',
    [EventType.MAINTENANCE]:             'excluded',
    [EventType.INSURANCE]:               'excluded',
    [EventType.CAPITAL_GAIN_RECOGNIZED]: 'excluded',
    [EventType.CAPITAL_GAIN_EXCLUDED]:   'excluded',
    [EventType.CONTRIBUTION_CAPPED]:     'excluded',
    [EventType.SOCIAL_SECURITY_DEFERRED]: 'excluded',
});

/** Where a tax event's money went, and how. */
const TAX_PART = Object.freeze({
    [EventType.FICA_WITHHOLDING]:       { to: 'FICA',                       via: FlowVia.FICA },
    [EventType.INCOME_TAX_WITHHOLDING]: { to: 'Income tax',                 via: FlowVia.WITHHELD },
    [EventType.CAPITAL_GAINS_TAX]:      { to: 'Capital gains tax',          via: FlowVia.CAPITAL_GAINS_TAX },
    [EventType.TAX_TRUE_UP]:            { to: 'Annual tax settlement',      via: FlowVia.TRUE_UP },
    [EventType.NIIT_ASSESSED]:          { to: 'Net investment income tax',  via: FlowVia.NIIT },
});

const PROVISION_TO = 'Capital gains tax on the draw';
const YIELD_SOURCE = 'Dividends and interest';
const REFUND_SOURCE = 'Tax refund';

/** Scopes that mean "this draw was paying an obligation". */
const OBLIGATION_SCOPES = new Set([TraceKind.EXPENSE, TraceKind.MORTGAGE, TraceKind.CARRYING_COST]);

const ROLE_ORDER = [SourceRole.INCOME, SourceRole.YIELD, SourceRole.REFUND, SourceRole.ONE_TIME, SourceRole.ACCOUNT];
const KIND_ORDER = [FlowKind.TAX, FlowKind.SPENT, FlowKind.ACCOUNTS];

// ── The bars ─────────────────────────────────────────────────────────

/**
 * Where the money went over an inclusive window of month indexes, where 0 is
 * the plan's first month.
 *
 * @param {Portfolio} portfolio  a portfolio that has been through chronometer_run
 * @param {number}    from
 * @param {number}    to
 * @returns {{from: number, to: number,
 *            sources: Array<{name: string, role: string, group: string, total: number,
 *                            parts: Array<{id: string, to: string, toGroup: string, kind: string,
 *                                          via: string, detail: string|null, amount: number}>}>,
 *            unpaid: Array<{label: string, kind: string, amount: number}>,
 *            totals: {income: number, spent: number, taxes: number, intoAccounts: number,
 *                     refunds: number, oneTimeIn: number, oneTimeOut: number,
 *                     unpaidSpent: number, unpaidTax: number, unplacedIncome: number,
 *                     propertyTaxLag: number}}}
 *          Amounts in whole dollars, positive. The tiles' figures are
 *          `income`, `spent`, `taxes` and `intoAccounts`; see the header.
 */
export function moneyFlows(portfolio, from, to) {
    const first = portfolio.firstDateInt;
    const scopes = portfolio.traceScopes ?? [];
    const assets = new Map(portfolio.modelAssets.map((a) => [a.displayName, a]));

    const sources = new Map();        // role|name → { name, role, group, parts: Map }
    const spills = [];                // resolved once every draw is seen
    const unpaids = [];               // likewise
    const draws = new Map();          // traceId → the part a draw in that scope paid

    const groupOf = (name) => {
        const asset = assets.get(name);
        return asset ? classifyAssetGroup(asset.instrument) : AssetGroup.CAPITAL;
    };
    const source = (name, role, group) => {
        const key = `${role}|${name}`;
        if (!sources.has(key)) sources.set(key, { name, role, group, parts: new Map() });
        return sources.get(key);
    };
    const add = (src, part, amount) => {
        const key = `${part.to}|${part.kind}|${part.via}|${part.detail ?? ''}`;
        const existing = src.parts.get(key);
        if (existing) existing.amount += amount;
        else src.parts.set(key, { ...part, amount });
    };

    for (const asset of portfolio.modelAssets) {
        const name = asset.displayName;
        for (const e of asset.events) {
            const treatment = FLOW_TREATMENT[e.type];
            if (!treatment) {
                throw new Error(
                    `money-flows: EventType "${e.type}" has no flow treatment. Add it to ` +
                    `FLOW_TREATMENT — say whether it moves money, and where to. Leaving it ` +
                    `out would drop money from bars that claim to be complete.`);
            }
            if (treatment === 'excluded') continue;
            if (e.kind !== EventKind.CASH && treatment !== 'unpaid') continue;
            const amount = e.amount.amount;
            // A $0 draw still names what its scope was paying: an account
            // drained to nothing leaves one, and a spillover pays the rest.
            if (amount === 0 && treatment !== 'move' && treatment !== 'tax') continue;

            // An event counts at most a month after its own date (see
            // bookedMonthIndex); the cheap test first.
            const own = (e.dateInt.year - first.year) * 12 + (e.dateInt.month - first.month);
            if (own < from - 1 || own > to) continue;
            const idx = bookedMonthIndex(e, first, scopes);
            if (idx < from || idx > to) continue;
            const chain = e.traceId != null ? chainFor(e.traceId, scopes) : [];

            const d = e.data ?? {};
            switch (treatment) {
                case 'move': {
                    if (amount > 0) break;
                    const part = moveTarget(e, name, chain, assets, groupOf);
                    if (amount < 0) add(source(name, roleOf(asset), groupOf(name)), part, -amount);
                    if (e.traceId != null) draws.set(e.traceId, part);
                    break;
                }
                case 'spillover':
                    if (amount < 0) spills.push({ name, asset, e, amount: -amount });
                    break;
                case 'provision': {
                    // The tax part of the gross-up drawn for d.forAsset: moved
                    // out of what was spent and into tax.
                    const src = source(name, roleOf(asset), groupOf(name));
                    add(src, { to: d.forAsset, toGroup: groupOf(d.forAsset), kind: FlowKind.SPENT,
                               via: FlowVia.BACKSTOP, detail: null }, amount);
                    add(src, { to: PROVISION_TO, toGroup: AssetGroup.TAXES, kind: FlowKind.TAX,
                               via: FlowVia.PROVISION, detail: null }, -amount);
                    break;
                }
                case 'tax': {
                    if (amount > 0) {
                        add(source(REFUND_SOURCE, SourceRole.REFUND, AssetGroup.TAXES),
                            { to: name, toGroup: groupOf(name), kind: FlowKind.ACCOUNTS,
                              via: FlowVia.REFUND, detail: null }, amount);
                        break;
                    }
                    const part = taxPart(e, asset);
                    if (amount < 0) add(source(name, roleOf(asset), groupOf(name)), part, -amount);
                    if (e.traceId != null) draws.set(e.traceId, part);
                    break;
                }
                case 'yield':
                    add(source(YIELD_SOURCE, SourceRole.YIELD, AssetGroup.CAPITAL),
                        { to: name, toGroup: groupOf(name), kind: FlowKind.ACCOUNTS, via: FlowVia.YIELD,
                          detail: e.type === EventType.DIVIDEND ? 'dividends' : 'interest' }, amount);
                    break;
                case 'oneTime':
                    if (amount > 0) {
                        add(source(d.note || 'One-time', SourceRole.ONE_TIME, groupOf(name)),
                            { to: name, toGroup: groupOf(name), kind: FlowKind.ACCOUNTS,
                              via: FlowVia.ONE_TIME, detail: null }, amount);
                    } else {
                        add(source(name, roleOf(asset), groupOf(name)),
                            { to: d.note || 'One-time purchase', toGroup: AssetGroup.EXPENSES,
                              kind: FlowKind.SPENT, via: FlowVia.ONE_TIME, detail: null }, -amount);
                    }
                    break;
                case 'unpaid':
                    unpaids.push({ e, asset, chain, amount: -amount });
                    break;
            }
        }
    }

    // A spillover pays what the draw it continues was paying: the draw in the
    // same scope, which a fallback account finished.
    for (const { name, asset, e, amount } of spills) {
        const draw = draws.get(e.traceId);
        if (!draw) {
            throw new Error(`money-flows: a spillover from ${name} has no draw in its scope ` +
                `to say what it paid (trace ${e.traceId}).`);
        }
        add(source(name, roleOf(asset), groupOf(name)), { ...draw, via: FlowVia.SPILLOVER }, amount);
    }

    const unpaid = new Map();         // label|kind → { label, kind, amount }
    for (const { e, asset, chain, amount } of unpaids) {
        const kind = unpaidKind(e, chain, asset, draws);
        const label = e.data?.cause ?? 'unpaid';
        const key = `${label}|${kind}`;
        if (!unpaid.has(key)) unpaid.set(key, { label, kind, amount: 0 });
        unpaid.get(key).amount += amount;
    }

    return asShown(portfolio, sources, unpaid, from, to);
}

/** A bar's role, from the account it is drawn from. */
function roleOf(asset) {
    return InstrumentType.isMonthlyIncome(asset.instrument) ? SourceRole.INCOME : SourceRole.ACCOUNT;
}

/**
 * Where a move's debit went: the account or obligation on its other side, and
 * what kind of thing that was.
 */
function moveTarget(e, payer, chain, assets, groupOf) {
    const d = e.data ?? {};
    const to = e.type === EventType.GROSS_UP ? d.forAsset : (d.from === payer ? d.to : d.from);

    let obligation = null;
    for (const s of chain) if (OBLIGATION_SCOPES.has(s.kind)) obligation = s;
    const propertyTax = d.label === 'property tax'
        || (obligation?.kind === TraceKind.CARRYING_COST && / property tax$/.test(obligation.label));
    // Paying an obligation is spending. Anything else moves money into one of
    // the household's own accounts, including paying a mortgage off, which the
    // section counts the same way.
    const kind = propertyTax ? FlowKind.TAX
               : obligation ? FlowKind.SPENT
               : FlowKind.ACCOUNTS;

    let via;
    if (e.type === EventType.GROSS_UP) via = FlowVia.BACKSTOP;
    else if (e.type === EventType.SETTLEMENT) via = d.backstop ? FlowVia.BACKSTOP : FlowVia.SETTLEMENT;
    else if (d.system) {
        const payerAsset = assets.get(payer);
        via = chain.some((s) => s.kind === TraceKind.RMD) ? FlowVia.RMD
            : payerAsset && InstrumentType.isMonthlyIncome(payerAsset.instrument) ? FlowVia.LEFTOVER
            : FlowVia.CLOSE;
    }
    else if (d.cadence === 'funding') via = FlowVia.OPENING;
    else if (d.cadence === 'on close') via = FlowVia.RULE_AT_CLOSE;
    else via = FlowVia.RULE;

    const detail = e.type === EventType.SETTLEMENT && d.label && d.label !== 'monthly' ? d.label : null;
    return { to, toGroup: propertyTax ? AssetGroup.REAL_ESTATE : groupOf(to), kind, via, detail };
}

/**
 * Where a tax debit went. Income tax drawn from an account, rather than
 * withheld from pay or from a withdrawal, is the year's estimated tax.
 */
function taxPart(e, asset) {
    const { to, via } = TAX_PART[e.type];
    const estimated = e.type === EventType.INCOME_TAX_WITHHOLDING
        && !InstrumentType.isMonthlyIncome(asset.instrument)
        && e.data?.source !== 'distribution';
    return { to, toGroup: AssetGroup.TAXES, kind: FlowKind.TAX, via: estimated ? FlowVia.ESTIMATED : via, detail: null };
}

/**
 * What an unpaid amount was: a bill, a tax, income with no account to go to,
 * or a move between the household's own accounts that did not happen. Read
 * from the chain and the draw it fell short of, never from the memo's words.
 */
function unpaidKind(e, chain, asset, draws) {
    if (chain.some((s) => s.kind === TraceKind.TAX_TRUE_UP)) return UnpaidKind.TAX;
    const draw = draws.get(e.traceId);
    if (draw) {
        return draw.kind === FlowKind.TAX ? UnpaidKind.TAX
             : draw.kind === FlowKind.SPENT ? UnpaidKind.SPENT
             : UnpaidKind.MOVE;
    }
    if (chain.some((s) => OBLIGATION_SCOPES.has(s.kind))) {
        return chain.some((s) => s.kind === TraceKind.CARRYING_COST && / property tax$/.test(s.label))
            ? UnpaidKind.TAX : UnpaidKind.SPENT;
    }
    return InstrumentType.isMonthlyIncome(asset.instrument) ? UnpaidKind.INCOME : UnpaidKind.MOVE;
}

/**
 * Whole dollars for amounts that must add up to `total`: each rounded down,
 * then the dollars left over given to the largest remainders.
 */
export function apportion(amounts, total) {
    const out = amounts.map((a) => Math.floor(a));
    let left = total - out.reduce((t, a) => t + a, 0);
    const order = amounts.map((a, i) => [a - out[i], i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
    return out;
}

/** Round each bar once, total what was rounded, order it all, and restate the section's figures. */
function asShown(portfolio, sourceMap, unpaidMap, from, to) {
    const sources = [];
    let propertyTaxDrawn = 0;
    for (const src of sourceMap.values()) {
        const raw = [...src.parts.values()];
        for (const p of raw) if (p.detail === 'property tax') propertyTaxDrawn += p.amount;
        const total = wholeDollars(raw.reduce((t, p) => t + p.amount, 0));
        const whole = apportion(raw.map((p) => p.amount), total);
        const parts = raw
            .map((p, i) => ({ ...p, amount: whole[i],
                              id: `${src.role}|${src.name}|${p.to}|${p.kind}|${p.via}|${p.detail ?? ''}` }))
            .filter((p) => p.amount !== 0)
            .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.amount - a.amount);
        if (!parts.length) continue;
        sources.push({ name: src.name, role: src.role, group: src.group, total, parts });
    }
    sources.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.total - a.total);

    const unpaid = [...unpaidMap.values()]
        .map((u) => ({ ...u, amount: wholeDollars(u.amount) }))
        .filter((u) => u.amount !== 0);
    const unpaidOf = (kind) => unpaid.filter((u) => u.kind === kind).reduce((t, u) => t + u.amount, 0);
    const partsOf = (pred) => sources.reduce((t, s) => t + s.parts.reduce((u, p) => u + (pred(s, p) ? p.amount : 0), 0), 0);

    // The section's figures, as it shows them, restated for what moved.
    const summary = flowsOver(portfolio, from, to);
    const shown = headlineAsShown(summary);
    const accrued = -summary.taxItems
        .filter((x) => x.metric === Metric.PROPERTY_TAX)
        .reduce((t, x) => t + x.amount, 0);
    const propertyTaxLag = wholeDollars(accrued - propertyTaxDrawn);
    const unplacedIncome = unpaidOf(UnpaidKind.INCOME);
    const unpaidSpent = unpaidOf(UnpaidKind.SPENT);
    const income = shown.income - unplacedIncome;
    const spent = -shown.expense - unpaidSpent;
    const taxes = -shown.taxes - propertyTaxLag;

    return {
        from, to, sources, unpaid,
        totals: {
            income, spent, taxes,
            // Money from outside the household's accounts, less what it spent
            // and paid in tax: the section's cash flow, as moved. Moves
            // between its own accounts cancel; one-time items are apart.
            intoAccounts: income - spent - taxes,
            refunds: sources.filter((s) => s.role === SourceRole.REFUND).reduce((t, s) => t + s.total, 0),
            oneTimeIn: sources.filter((s) => s.role === SourceRole.ONE_TIME).reduce((t, s) => t + s.total, 0),
            oneTimeOut: partsOf((s, p) => p.via === FlowVia.ONE_TIME && s.role !== SourceRole.ONE_TIME),
            unpaidSpent,
            unpaidTax: unpaidOf(UnpaidKind.TAX),
            unplacedIncome,
            propertyTaxLag,
        },
    };
}

/** The window of one calendar month, or null when it is outside the run. */
export function monthWindow(portfolio, year, month) {
    if (!portfolio?.firstDateInt) return null;
    const idx = DateInt.diffMonths(portfolio.firstDateInt, DateInt.from(year, month));
    if (idx < 0 || idx > lastHistoryIndex(portfolio)) return null;
    return { from: idx, to: idx };
}

/** The window of one calendar year's months inside the run, or null. */
export function yearWindow(portfolio, year) {
    if (!portfolio?.firstDateInt) return null;
    const first = portfolio.firstDateInt;
    const from = Math.max(0, DateInt.diffMonths(first, DateInt.from(year, 1)));
    const to = Math.min(lastHistoryIndex(portfolio), DateInt.diffMonths(first, DateInt.from(year, 12)));
    return to < from ? null : { from, to };
}

// ── The rules in force ───────────────────────────────────────────────

/** Bar parts no rule made, grouped by what made them. The first match wins. */
const AUTOMATIC = Object.freeze([
    { key: 'incomeTax',  label: 'Tax withheld from income',
      test: (s, p) => s.role === SourceRole.INCOME && (p.via === FlowVia.FICA || p.via === FlowVia.WITHHELD) },
    { key: 'drawTax',    label: 'Tax withheld from withdrawals', test: (s, p) => p.via === FlowVia.WITHHELD },
    { key: 'estimated',  label: 'Estimated tax',                  test: (s, p) => p.via === FlowVia.ESTIMATED },
    { key: 'gainsTax',   label: 'Tax on capital gains',
      test: (s, p) => p.via === FlowVia.CAPITAL_GAINS_TAX || p.via === FlowVia.PROVISION },
    { key: 'settlement', label: 'Last year’s tax settlement',
      test: (s, p) => p.via === FlowVia.TRUE_UP || p.via === FlowVia.NIIT },
    { key: 'refund',     label: 'Tax refund',                     test: (s, p) => p.via === FlowVia.REFUND },
    { key: 'rmd',        label: 'Required minimum distributions', test: (s, p) => p.via === FlowVia.RMD },
    { key: 'leftover',   label: 'Take-home pay no rule claims',   test: (s, p) => p.via === FlowVia.LEFTOVER },
    { key: 'uncovered',  label: 'Bills no rule covers',           test: (s, p) => p.via === FlowVia.BACKSTOP },
    { key: 'spillover',  label: 'An account ran short, the next one paid',
      test: (s, p) => p.via === FlowVia.SPILLOVER },
    { key: 'close',      label: 'Closing balances and sale proceeds', test: (s, p) => p.via === FlowVia.CLOSE },
    { key: 'opening',    label: 'Paid as an asset opened',        test: (s, p) => p.via === FlowVia.OPENING },
    { key: 'yield',      label: 'Dividends and interest',         test: (s, p) => p.via === FlowVia.YIELD },
    { key: 'oneTime',    label: 'One-time items',                 test: (s, p) => p.via === FlowVia.ONE_TIME },
    // A rule's part that no rule in force claims. Should not happen; shown
    // rather than dropped if it does.
    { key: 'other',      label: 'Other transfers',                test: () => true },
]);

/** Whether a rule's owner is paid INTO: its monthly rule names the account that pays it. */
function paidInto(instrument) {
    return InstrumentType.isMonthlyExpense(instrument)
        || InstrumentType.isMortgage(instrument)
        || InstrumentType.isRealEstate(instrument);
}

const percent = (v) => `${Math.round(v * 100) / 100}%`;

/** A monthly rule's setting in words: what its percentage is a percentage of. */
export function settingText(owner, target, ft) {
    const p = percent(ft.monthlyMoveValue);
    const i = owner.instrument;
    if (InstrumentType.isMonthlyIncome(i)) {
        return target && InstrumentType.isTaxDeferred(target.instrument) ? `${p} of gross pay` : `${p} of take-home pay`;
    }
    if (InstrumentType.isMonthlyExpense(i)) return `${p} of the bill`;
    if (InstrumentType.isMortgage(i)) return `${p} of the payment`;
    if (InstrumentType.isRealEstate(i)) return `${p} of property costs`;
    return `${p} of the balance, monthly`;
}

/**
 * The rules in force over a window, each beside what it moved, and the money
 * that moved by itself.
 *
 * A rule's monthly half and its close half are separate rows: they move money
 * different ways. The monthly half of a bill's, a mortgage's or a property's
 * rule names the account that pays it, so its money runs from that account in;
 * the close half moves a closing account's balance, so it runs out. A row
 * claims the bar parts its half made between its two accounts: the monthly
 * half claims what paid the owner's bill or moved by the rule, the close half
 * what moved at close. Whatever no rule claims is automatic: tax withheld,
 * required distributions, the take-home pay the backstop receives, bills no
 * rule covers. Every part of every bar lands in exactly one row.
 *
 * A window that spans a phase change (a year a life event falls in) shows
 * every phase's rules; each row says which phases it belongs to.
 *
 * Rules are read from the portfolio's phase record (Portfolio.phaseRules), not
 * the assets: after a run each asset holds the last phase's rules.
 *
 * @param {Portfolio} portfolio
 * @param {ReturnType<typeof moneyFlows>} flows
 * @returns {{phases: Array<{phase: string, fromIndex: number, inWindow: boolean}>,
 *            rules: Array<{key: string, owner: string, payer: string, payee: string, half: string,
 *                          payerGroup: string, payeeGroup: string, kind: string,
 *                          setting: string, phases: string[], moved: number, partIds: string[]}>,
 *            automatic: Array<{key: string, label: string, amount: number, partIds: string[],
 *                              items: Array<{source: string, to: string, kind: string, amount: number}>}>}}
 *          `rules` holds every rule in force, $0 ones included, those that
 *          moved money first.
 */
export function rulesInForce(portfolio, flows) {
    const assets = new Map(portfolio.modelAssets.map((a) => [a.displayName, a]));
    const groupOf = (name) => {
        const asset = assets.get(name);
        return asset ? classifyAssetGroup(asset.instrument) : AssetGroup.CAPITAL;
    };

    const records = portfolio.phaseRules ?? [];
    const phases = records.map((r, i) => ({
        phase: r.phase,
        fromIndex: r.fromIndex,
        inWindow: r.fromIndex <= flows.to && (records[i + 1]?.fromIndex ?? Infinity) > flows.from,
    }));
    // A plan with no life events has no record: its assets' rules are the only ones.
    const ruleSets = records.length
        ? records.filter((r, i) => phases[i].inWindow)
        : [{ phase: null, transfers: Object.fromEntries(portfolio.modelAssets.map((a) => [a.displayName, a.fundTransfers ?? []])) }];

    const rows = new Map();
    const rowFor = (key, init) => {
        if (!rows.has(key)) {
            rows.set(key, { key, ...init, payerGroup: groupOf(init.payer), payeeGroup: groupOf(init.payee),
                            settings: [], phases: [], moved: 0, partIds: [], byKind: {} });
        }
        return rows.get(key);
    };
    const note = (row, text, phase) => {
        if (!row.settings.includes(text)) row.settings.push(text);
        if (phase && !row.phases.includes(phase)) row.phases.push(phase);
    };
    for (const set of ruleSets) {
        for (const [owner, transfers] of Object.entries(set.transfers)) {
            const ownerAsset = assets.get(owner);
            if (!ownerAsset) continue;
            for (const ft of transfers) {
                const target = ft.toDisplayName;
                if (ft.monthlyMoveValue > 0) {
                    const pays = paidInto(ownerAsset.instrument);
                    const row = rowFor(`monthly|${owner}|${target}`, {
                        owner, half: 'monthly', pays,
                        payer: pays ? target : owner, payee: pays ? owner : target });
                    note(row, settingText(ownerAsset, assets.get(target), ft), set.phase);
                }
                if (ft.closeMoveValue > 0) {
                    const row = rowFor(`close|${owner}|${target}`, {
                        owner, half: 'close', pays: false, payer: owner, payee: target });
                    note(row, `${percent(ft.closeMoveValue)} at close`, set.phase);
                }
            }
        }
    }

    // Each part to the row that made it, or to an automatic group. A monthly
    // row's money runs payer → payee, paying the owner's bill or moving into
    // an account; a close row's runs either way, as the closing balance's sign
    // has it.
    const monthly = new Map(), close = new Map();
    const pairOf = (a, b) => [a, b].sort().join('|');
    for (const row of rows.values()) {
        if (row.half === 'close') {
            if (!close.has(pairOf(row.owner, row.payee))) close.set(pairOf(row.owner, row.payee), row);
        } else {
            const key = `${row.payer}→${row.payee}|${row.pays}`;
            if (!monthly.has(key)) monthly.set(key, row);
        }
    }
    const automatic = new Map();
    for (const src of flows.sources) {
        const own = src.role === SourceRole.INCOME || src.role === SourceRole.ACCOUNT;
        for (const part of src.parts) {
            let row = null;
            if (own && (part.via === FlowVia.RULE || part.via === FlowVia.SETTLEMENT)) {
                row = monthly.get(`${src.name}→${part.to}|${part.kind !== FlowKind.ACCOUNTS}`);
            } else if (own && part.via === FlowVia.RULE_AT_CLOSE) {
                row = close.get(pairOf(src.name, part.to));
                // Drawn as the money ran: a closing mortgage is paid off INTO.
                if (row && !row.moved) { row.payer = src.name; row.payee = part.to;
                    row.payerGroup = groupOf(src.name); row.payeeGroup = groupOf(part.to); }
            }
            if (row) {
                row.moved += part.amount;
                row.partIds.push(part.id);
                row.byKind[part.kind] = (row.byKind[part.kind] ?? 0) + part.amount;
                continue;
            }
            const group = AUTOMATIC.find((g) => g.test(src, part));
            if (!automatic.has(group.key)) automatic.set(group.key, { key: group.key, label: group.label, amount: 0, partIds: [], items: [] });
            const auto = automatic.get(group.key);
            auto.amount += part.amount;
            auto.partIds.push(part.id);
            auto.items.push({ source: src.name, to: part.to, kind: part.kind, amount: part.amount });
        }
    }

    const incomeFirst = (name) => (InstrumentType.isMonthlyIncome(assets.get(name)?.instrument) ? 0 : 1);
    const rules = [...rows.values()]
        .map(({ settings, byKind, pays, ...row }) => ({
            ...row,
            // Colored by what most of its money did, or by what it pays.
            kind: Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0]
               ?? (pays ? FlowKind.SPENT : FlowKind.ACCOUNTS),
            setting: settings.join('; '),
        }))
        .sort((a, b) => (b.moved > 0) - (a.moved > 0) || incomeFirst(a.payer) - incomeFirst(b.payer)
                     || a.payer.localeCompare(b.payer) || b.moved - a.moved);

    return {
        phases,
        rules,
        automatic: AUTOMATIC.map((g) => automatic.get(g.key)).filter(Boolean),
    };
}
