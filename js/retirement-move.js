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
import { DateInt, MONTH_NAMES } from './utils/date-int.js';

const ENDS_AT_RETIREMENT = new Set([Instrument.WORKING_INCOME]);
const STARTS_AT_RETIREMENT = new Set([Instrument.RETIREMENT_INCOME, Instrument.PENSION]);

/**
 * Move the plan's retirement to `toAge`, in place.
 *
 * @param {ModelAsset[]} modelAssets        the editor's assets (dates are edited)
 * @param {ModelLifeEvent[]} lifeEvents     bound to the editing config
 * @returns {{ from: DateInt|null, to: DateInt|null,
 *             moved: {asset: ModelAsset, edge: 'start'|'finish'}[],
 *             skipped: {asset: ModelAsset, edge: 'start'|'finish'}[] }}
 *          `from`/`to` are null when the plan has no Retire phase.
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

    for (const asset of modelAssets) {
        if (ENDS_AT_RETIREMENT.has(asset.instrument)
            && asset.finishDateInt?.toInt() === from.toInt()) {
            // After its own start, which is on or after the plan's first month.
            const ok = target > asset.startDateInt.toInt();
            if (ok) asset.finishDateInt = new DateInt(target);
            (ok ? moved : skipped).push({ asset, edge: 'finish' });
        }
        if (STARTS_AT_RETIREMENT.has(asset.instrument)
            && asset.startDateInt.toInt() === from.toInt()) {
            const ok = target >= planFirst
                && (!asset.finishDateInt || target < asset.finishDateInt.toInt());
            if (ok) asset.startDateInt = new DateInt(target);
            (ok ? moved : skipped).push({ asset, edge: 'start' });
        }
    }
    return { from, to, moved, skipped };
}

/** One sentence for the user naming what moved, or null when nothing did. */
export function describeRetirementMove({ to, moved, skipped }) {
    if (!moved.length && !skipped.length) return null;
    const month = `${MONTH_NAMES[to.month - 1]} ${to.year}`;
    const names = (list) => {
        const parts = list.map(({ asset, edge }) =>
            `${asset.displayName}'s ${edge === 'finish' ? 'end' : 'start'}`);
        return parts.length <= 1 ? parts.join('')
            : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    };
    const sentences = [];
    if (moved.length) sentences.push(`Moved ${names(moved)} to ${month} with your retirement.`);
    if (skipped.length) {
        sentences.push(`Left ${names(skipped)} where ${skipped.length === 1 ? 'it was' : 'they were'}: `
            + `${month} is outside ${skipped.length === 1 ? 'its' : 'their'} dates or before the plan starts.`);
    }
    return sentences.join(' ');
}
