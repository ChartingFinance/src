/**
 * explain.js — "why did the engine do that?", answered as a chain.
 *
 * ── What this is for ─────────────────────────────────────────────────
 *
 * Running a projection is commodity. What this engine has that a spreadsheet
 * does not is a RECORD OF ITS OWN REASONING: every event carries the causal
 * scope it happened inside (trace.js), so a brokerage debit can be walked back
 * to the expense that caused it. An LLM client is the ideal consumer of that —
 * it can read a chain and turn it into a sentence — which is why this is the
 * tool worth having and not another table of numbers.
 *
 * ── Two ways in, because there are two questions ─────────────────────
 *
 *   explainIssue()  — "why did THIS finding happen?" The guided path. Issues
 *                     already name an asset and a date, so the agent does not
 *                     have to guess where to look.
 *
 *   explainAt()     — "what happened here?" The exploratory path, for a month
 *                     the agent got curious about from the projection table.
 *
 * ── Not every finding has a cause on record ──────────────────────────
 *
 * Some detectors fire on an absence rather than an event. `rmd-unsatisfied`
 * is the clearest: the site that gives up when no account can receive the
 * distribution returns without recording anything, so there is no event and
 * therefore no chain. `no-funding-accounts` is a statement about the plan's
 * configuration, not about a moment in it.
 *
 * Those return `{ chains: [], why: '...' }` and SAY SO. Inventing a plausible
 * chain for a finding whose cause was never recorded would be worse than the
 * silence — it would be a false causal claim, which is the one thing the trace
 * machinery exists to avoid.
 *
 * ── Reads take the scope list explicitly ─────────────────────────────
 *
 * Every call here threads `portfolio.traceScopes` into chainFor/explainEvent.
 * Never the ambient module state: `resetTraces()` runs at the top of every
 * chronometer_run, so a second plan in the same process wipes the first one's
 * scopes and every chain resolved afterwards would silently come back empty.
 * That is exactly why runPlan hands back the live Portfolio.
 */

import { chainFor, chainLabel, explainEvent } from '../trace.js';
import { EventType, renderNote } from '../sim-event.js';
import { DateInt, monthLabel } from '../utils/date-int.js';
import { formatCurrency } from '../utils/html.js';

/**
 * Which recorded event a finding is ABOUT.
 *
 * Keyed on EventType rather than on the memo prose that portfolio-issues.js
 * matches. The detectors have to read memos — that is the known seam documented
 * there — but nothing forces this file to inherit the fragility, and an
 * EventType cannot be broken by a copy edit.
 *
 * `null` means the finding has no event behind it. That is a fact about the
 * engine, not a gap in this table — see the module comment.
 */
const ISSUE_EVENT_TYPE = Object.freeze({
    'plan-exhaustion':      EventType.UNFUNDED,
    'unfunded-obligation':  EventType.UNFUNDED,
    'funding-ran-dry':      EventType.SPILLOVER,
    'contribution-capped':  EventType.CONTRIBUTION_CAPPED,
    'rmd-unsatisfied':      null,
    'no-funding-accounts':  null,
});

/**
 * `funding-ran-dry` attributes to the DEPLETED account, but the spillover event
 * is recorded on the account that COVERED it (portfolio-issues.js flips this
 * deliberately, because the issue belongs to the account that ran out). So the
 * event cannot be found by matching assetName — it is found by the depleted
 * name inside the event's own data.
 */
function matchesDepleted(event, name) {
    return event.data?.depleted === name;
}

const dateIntOf = (d) => (d == null ? null : (d.year * 100 + d.month));

/** Parse 'YYYY-MM' | 'YYYY-M' | {year,month} into a comparable integer. */
export function parseDate(value) {
    if (value == null) return null;
    if (typeof value === 'object' && value.year) return dateIntOf(value);
    const m = /^(\d{4})-(\d{1,2})$/.exec(String(value).trim());
    if (!m) throw new Error(`Date must look like "2051-11", got "${value}"`);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new Error(`Month out of range in "${value}"`);
    return Number(m[1]) * 100 + month;
}

/** Every event in the run, tagged with the asset that recorded it. */
function allEvents(portfolio) {
    const out = [];
    for (const asset of portfolio.modelAssets ?? []) {
        for (const event of asset.events ?? []) out.push({ asset, event });
    }
    return out;
}

/**
 * One event, rendered with its chain and everything that happened alongside it.
 *
 * The siblings are not padding. A brokerage debit on its own looks arbitrary;
 * seen next to the clamped transfer and the realized gain from the same scope,
 * it is obviously the third step of one story. That is the whole point.
 */
function describe(entry, portfolio) {
    const { asset, event } = entry;
    const scopes = portfolio.traceScopes;
    const { chain, siblings } = explainEvent(event, portfolio.modelAssets, scopes);

    return {
        asset: asset.displayName,
        date: event.dateInt ? monthLabel(event.dateInt) : null,
        type: event.type,
        note: renderNote(event),
        amount: event.amount?.amount ?? 0,
        traceId: event.traceId,
        chain: chain.map(s => ({ kind: s.kind, label: s.label, depth: s.depth })),
        chainLabel: event.traceId != null ? chainLabel(event.traceId, scopes) : null,
        siblings: siblings
            .filter(s => s.event !== event)
            .map(s => ({
                asset: s.asset,
                note: renderNote(s.event),
                type: s.event.type,
                amount: s.event.amount?.amount ?? 0,
            })),
    };
}

/**
 * Explain one finding from detectIssues().
 *
 * @param {object} run    { portfolio, issues } from runPlan
 * @param {string} issueId
 * @param {object} [opts]
 * @param {string} [opts.assetName] disambiguates when several assets share an id
 * @param {number} [opts.limit]     how many occurrences to explain (default 3)
 */
export function explainIssue(run, issueId, { assetName = null, limit = 3 } = {}) {
    const { portfolio, issues } = run;

    const candidates = issues.filter(i =>
        i.id === issueId && (assetName == null || i.assetName === assetName));

    if (candidates.length === 0) {
        const known = [...new Set(issues.map(i => i.id))];
        throw new Error(
            `No finding "${issueId}"${assetName ? ` on "${assetName}"` : ''} in this run. `
            + `Findings present: ${known.length ? known.join(', ') : '(none — the plan is clean)'}`);
    }

    const issue = candidates[0];
    const eventType = ISSUE_EVENT_TYPE[issueId];

    if (eventType === undefined) {
        // An id this file has never heard of. Louder than returning nothing:
        // a new detector should be a deliberate addition here, not a silent
        // hole that reports "no cause recorded" for something that has one.
        throw new Error(`Finding "${issueId}" is not mapped in ISSUE_EVENT_TYPE — `
            + `add it there (or map it to null if it has no recorded event).`);
    }

    if (eventType === null) {
        return {
            issue,
            chains: [],
            why: `This finding is not anchored on a recorded event, so there is no causal chain `
               + `to show. ${issueId === 'rmd-unsatisfied'
                    ? 'The engine gives up on an unsatisfiable required distribution without '
                    + 'recording why, so the shortfall is known but its cause is not.'
                    : 'It describes the shape of the plan rather than a moment in it.'}`,
        };
    }

    const wantsDepleted = issueId === 'funding-ran-dry';
    const target = issue.assetName;

    const matches = allEvents(portfolio).filter(({ asset, event }) => {
        if (event.type !== eventType) return false;
        if (issue.scope === 'plan') return true;
        return wantsDepleted ? matchesDepleted(event, target) : asset.displayName === target;
    });

    matches.sort((a, b) => (dateIntOf(a.event.dateInt) ?? 0) - (dateIntOf(b.event.dateInt) ?? 0));

    return {
        issue,
        totalOccurrences: matches.length,
        chains: matches.slice(0, limit).map(e => describe(e, portfolio)),
        why: null,
    };
}

/**
 * Explain what happened at a point in the plan.
 *
 * @param {object} run
 * @param {object} query
 * @param {string} [query.date]      'YYYY-MM'
 * @param {string} [query.assetName]
 * @param {string} [query.eventType] an EventType value
 * @param {number} [query.limit]
 */
export function explainAt(run, { date = null, assetName = null, eventType = null, limit = 10 } = {}) {
    const { portfolio } = run;
    const wanted = parseDate(date);

    if (eventType && !Object.values(EventType).includes(eventType)) {
        throw new Error(`Unknown event type "${eventType}". One of: ${Object.values(EventType).join(', ')}`);
    }
    if (assetName) {
        const names = portfolio.modelAssets.map(a => a.displayName);
        if (!names.includes(assetName)) {
            throw new Error(`No asset "${assetName}" in this plan. Assets: ${names.join(', ')}`);
        }
    }

    let matches = allEvents(portfolio).filter(({ asset, event }) => {
        if (wanted != null && dateIntOf(event.dateInt) !== wanted) return false;
        if (assetName && asset.displayName !== assetName) return false;
        if (eventType && event.type !== eventType) return false;
        return true;
    });

    matches.sort((a, b) => (a.event.seq ?? 0) - (b.event.seq ?? 0));

    return {
        query: { date, assetName, eventType },
        totalMatches: matches.length,
        chains: matches.slice(0, limit).map(e => describe(e, portfolio)),
    };
}

// ── Rendering ────────────────────────────────────────────────────────

function chainMarkdown(c) {
    const lines = [];
    lines.push(`### ${c.note} — ${c.asset}, ${c.date ?? 'undated'}`);
    lines.push('');
    lines.push(`**Amount:** ${formatCurrency(c.amount)}`);
    lines.push('');

    if (c.chainLabel) {
        lines.push(`**Why it happened:**`);
        lines.push('');
        lines.push('```');
        lines.push(c.chainLabel);
        lines.push('```');
    } else {
        // Every event should carry a scope; trace-scopes.mjs asserts it. Saying
        // so plainly beats printing an empty chain as if that were an answer.
        lines.push('**Why it happened:** _no causal scope recorded for this event._');
    }
    lines.push('');

    if (c.siblings.length) {
        lines.push(`**Everything else in the same step:**`);
        lines.push('');
        lines.push('| Asset | What | Amount |');
        lines.push('| :--- | :--- | ---: |');
        for (const s of c.siblings) {
            lines.push(`| ${s.asset} | ${s.note} | ${formatCurrency(s.amount)} |`);
        }
    } else {
        lines.push('_Nothing else happened in that step._');
    }
    lines.push('');
    return lines.join('\n');
}

export function explainIssueMarkdown(result) {
    const { issue, chains, why, totalOccurrences } = result;
    const lines = [`# Why: ${issue.headline}`, ''];
    if (issue.assetName) lines.push(`**Asset:** ${issue.assetName}  `);
    lines.push(`**Finding:** ${issue.detail}`, '');

    if (why) {
        lines.push(`> ${why}`, '');
        return lines.join('\n');
    }

    if (!chains.length) {
        lines.push('> No matching event was found in the run for this finding.', '');
        return lines.join('\n');
    }

    if (totalOccurrences > chains.length) {
        lines.push(`Showing the first ${chains.length} of ${totalOccurrences} occurrences, earliest first.`, '');
    }

    lines.push(...chains.map(chainMarkdown));
    return lines.join('\n');
}

export function explainAtMarkdown(result) {
    const { query, chains, totalMatches } = result;
    const scope = [
        query.date ? `in ${query.date}` : null,
        query.assetName ? `on ${query.assetName}` : null,
        query.eventType ? `of type ${query.eventType}` : null,
    ].filter(Boolean).join(', ') || 'across the whole plan';

    const lines = [`# What happened ${scope}`, ''];

    if (!chains.length) {
        lines.push('No events matched. Widen the query — drop the asset or the event type, '
                 + 'or pick a different month.', '');
        return lines.join('\n');
    }

    if (totalMatches > chains.length) {
        lines.push(`Showing ${chains.length} of ${totalMatches} events, in the order the engine recorded them.`, '');
    }

    lines.push(...chains.map(chainMarkdown));
    return lines.join('\n');
}

export { ISSUE_EVENT_TYPE };
