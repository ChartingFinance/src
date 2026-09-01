/**
 * editing-env.js — the environment the EDITOR binds to.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * Spec 10 step 0 took the wall clock out of `plan-dates.js`: a derived date is
 * now anchored to `config.birthYear`, which `Portfolio` attaches from the
 * plan's own first month. That fixed the run, and it broke the editor.
 *
 * The editor reads the same derived getters — `ModelLifeEvent.triggerDateInt`
 * for the phase markers on the projection charts, `ModelAsset`'s
 * `effectiveFinishDateInt` for the asset list — on objects that never pass
 * through a `Portfolio`. They are bound to a config built by
 * `simConfigFromGlobals()`, and that builder has no plan to read a first month
 * from, so it leaves `birthYear` null. `birthYearFor()` throws on null, by
 * design. Loading any quick-start profile took the app down on startup.
 *
 * ── The anchor has to be the SAME anchor ─────────────────────────────
 *
 * The cheap repair is to put `new Date().getFullYear() - startAge` back, here
 * in the UI where a clock is legal. It restores the pre-step-0 behaviour
 * exactly, including the divergence step 0 existed to remove.
 *
 * The projection chart plots `ev.triggerDateInt` against
 * `portfolio.firstDateInt`. The portfolio's events are anchored to the plan;
 * clock-anchored editor events are not. Replay a scenario saved last year and
 * the two disagree by twelve months: the engine changes regime in Jan 2042 and
 * the "Retire" marker is drawn on Jan 2043. Nothing errors, and the picture
 * asserts something false about the run beside it.
 *
 * So the editor derives its anchor the way `Portfolio` does — from the plan's
 * earliest asset — and the clock is consulted only when there is no plan yet
 * to ask. That case is a genuinely new portfolio, whose assets Quick Start is
 * about to create starting this month, so the two agree the moment there is
 * anything to disagree about.
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
