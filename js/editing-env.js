/**
 * editing-env.js — the environment the EDITOR binds to.
 *
 * The editor reads derived dates (phase markers, asset finish dates) on
 * objects that never pass through a Portfolio, so it needs its own config with
 * a `birthYear`. It must be the same anchor the run uses — derived from the
 * plan's earliest asset, as Portfolio does — or a saved plan's markers would be
 * drawn a year (or more) away from the engine's regime changes.
 *
 * The clock is used only when there is no plan yet; Quick Start then creates
 * assets starting this month, so the two agree.
 */

import { firstDateInt } from './portfolio.js';
import { simConfigFromGlobals } from './globals.js';
import { withSimConfig } from './sim-config.js';
import { DateInt } from './utils/date-int.js';

/**
 * The current settings, anchored to a plan.
 *
 * @param {ModelAsset[]} [assets] the plan being edited; empty for a new one
 * @returns {Readonly<object>} a SimConfig carrying `birthYear`
 */
export function editingConfigFor(assets) {
    const config = simConfigFromGlobals();
    // `startDateInt` is absolute, so this reads nothing derived and is safe on
    // assets that are not bound yet — which, at the first call, they are not.
    const first = firstDateInt(assets ?? []);
    const anchorYear = first ? first.year : DateInt.today().year;
    return withSimConfig(config, { birthYear: anchorYear - config.startAge });
}
