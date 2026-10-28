/**
 * retirement-move.js — what moves when the retirement age changes on a
 * loaded plan.
 *
 * The Retire phase is age-relative, but asset dates are absolute: a salary
 * that ends at retirement stores the month it ends. Changing only the phase
 * would leave that salary paying into retirement and Social Security starting
 * at the old age, while the simulations retire at the new one.
 *
 * So the phase moves, and with it the income dated exactly at the old
 * retirement month: working income that ENDS there, Social Security and
 * pensions that START there. Nothing else moves, even if it happens to share
 * the month; a mortgage or an expense ending then is left alone. Because the
 * match is on the phase's own month, changing the age back moves the same
 * dates back.
 *
 * Social Security cannot be claimed before 62 (plan-dates.js), so a retirement
 * earlier than that moves it to 62 instead. A benefit held at 62 that way still
 * counts as dated at retirement, so changing the age back takes it with it.
 *
 * A date is never moved to before the plan's first month or past the other end
 * of its asset. The plan's first month is its anchor (the birth year every
 * age-relative date is derived from), so moving an asset's start ahead of it
 * would re-date the whole plan. Those dates are reported as skipped.
 *
 * Editing dates in response to the user's own setting is allowed; creating or
 * deleting assets is not (see the asset-ownership rule).
 */

import { Instrument } from './instruments/instrument.js';
import { LifeEvent } from './life-event.js';
import { earliestSocialSecurityDateIntFor, SOCIAL_SECURITY_EARLIEST_AGE } from './plan-dates.js';
import { DateInt, MONTH_NAMES } from './utils/date-int.js';

const ENDS_AT_RETIREMENT = new Set([Instrument.WORKING_INCOME]);
const STARTS_AT_RETIREMENT = new Set([Instrument.RETIREMENT_INCOME, Instrument.PENSION]);

/**
 * Move the plan's retirement to `toAge`, in place.
 *
 * @param {ModelAsset[]} modelAssets        the editor's assets (dates are edited)
 * @param {ModelLifeEvent[]} lifeEvents     bound to the editing config
 * @returns {{ from: DateInt|null, to: DateInt|null,
 *             moved: {asset: ModelAsset, edge: 'start'|'finish', to: DateInt}[],
 *             skipped: {asset: ModelAsset, edge: 'start'|'finish', to: DateInt}[] }}
 *          `from`/`to` are null when the plan has no Retire phase. Each entry's
 *          `to` is where that date went, or would have: the new retirement, or
 *          62 for Social Security.
 */
export function moveRetirement(modelAssets, lifeEvents, toAge) {
    const retire = lifeEvents.find((e) => e.type === LifeEvent.RETIRE);
    if (!retire) return { from: null, to: null, moved: [], skipped: [] };

    const from = retire.triggerDateInt;
    retire.triggerAge = toAge;
    const to = retire.triggerDateInt;

    const moved = [], skipped = [];
    if (from.toInt() === to.toInt()) return { from, to, moved, skipped };

    // Read before any date changes: moving a start could otherwise change it.
    const planFirst = Math.min(...modelAssets.map((a) => a.startDateInt.toInt()));
    const target = to.toInt();

    // Where an income that starts at retirement starts, for a given retirement.
    const earliestClaim = earliestSocialSecurityDateIntFor(retire.env);
    const startFor = (asset, retirement) =>
        asset.instrument === Instrument.RETIREMENT_INCOME && retirement.isBefore(earliestClaim)
            ? earliestClaim : retirement;

    for (const asset of modelAssets) {
        if (ENDS_AT_RETIREMENT.has(asset.instrument)
            && asset.finishDateInt?.toInt() === from.toInt()) {
            // After its own start, which is on or after the plan's first month.
            const ok = target > asset.startDateInt.toInt();
            if (ok) asset.finishDateInt = new DateInt(target);
            (ok ? moved : skipped).push({ asset, edge: 'finish', to });
        }
        if (STARTS_AT_RETIREMENT.has(asset.instrument)
            && asset.startDateInt.toInt() === startFor(asset, from).toInt()) {
            const start = startFor(asset, to);
            // Held at 62 by both retirements: nothing to move.
            if (start.toInt() === asset.startDateInt.toInt()) continue;
            // A retirement before the plan starts moves no income, even where 62
            // would be in range: the salary stays too.
            const ok = target >= planFirst && start.toInt() >= planFirst
                && (!asset.finishDateInt || start.toInt() < asset.finishDateInt.toInt());
            if (ok) asset.startDateInt = new DateInt(start.toInt());
            (ok ? moved : skipped).push({ asset, edge: 'start', to: start });
        }
    }
    return { from, to, moved, skipped };
}

/** One sentence for the user naming what moved, or null when nothing did. */
export function describeRetirementMove({ to, moved, skipped }) {
    if (!moved.length && !skipped.length) return null;
    const label = (d) => `${MONTH_NAMES[d.month - 1]} ${d.year}`;
    const month = label(to);
    const names = (list) => {
        const parts = list.map(({ asset, edge }) =>
            `${asset.displayName}'s ${edge === 'finish' ? 'end' : 'start'}`);
        return parts.length <= 1 ? parts.join('')
            : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    };
    const sentences = [];
    const withRetirement = moved.filter((m) => m.to.toInt() === to.toInt());
    const atEarliestClaim = moved.filter((m) => m.to.toInt() !== to.toInt());
    if (withRetirement.length) {
        sentences.push(`Moved ${names(withRetirement)} to ${month} with your retirement.`);
    }
    if (atEarliestClaim.length) {
        sentences.push(`Moved ${names(atEarliestClaim)} to ${label(atEarliestClaim[0].to)}, `
            + `at ${SOCIAL_SECURITY_EARLIEST_AGE}: Social Security can't be claimed earlier.`);
    }
    if (skipped.length) {
        sentences.push(`Left ${names(skipped)} where ${skipped.length === 1 ? 'it was' : 'they were'}: `
            + `${month} is outside ${skipped.length === 1 ? 'its' : 'their'} dates or before the plan starts.`);
    }
    return sentences.join(' ');
}
