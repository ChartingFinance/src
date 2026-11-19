/**
 * plan-ids.js — the ids a plan's assets and life events carry.
 *
 * A name is what the user sees, and it changes when they rename something. An
 * id does not change, so it is what one part of a plan can use to refer to
 * another: a transfer to its target account, a phase to the assets it closes.
 *
 * Ids are short and unique within one plan: assets are `a1`, `a2`, …, and life
 * events are `e1`, `e2`, …. They are not unique across plans. A copied scenario
 * keeps its ids, so the copy's `a3` is the same account as the original's.
 *
 * This file is the only place that gives out ids. They are never random: the
 * same plan, in the same order, always gets the same ids. MCP run handles are a
 * hash of the plan (mcp/run-plan.js), and build_plan has to produce the same
 * plan, and so the same handle, every time it is asked the same thing. Tests
 * that build plans without ids get the same ids on every run.
 *
 * ── References ──────────────────────────────────────────────────────────
 *
 * Four things in a plan refer to an asset. Each holds the asset's id and its
 * name, the name as a label:
 *
 *   a fund transfer        `toId`, labelled `toDisplayName`
 *   a phase's rules        `phaseTransfers`, keyed by the id of the asset whose
 *                          rules they are (a key has no label)
 *   a phase's closes       `closes`, a list of `{ assetId, displayName }`; an entry
 *                          can instead be a type of asset, `{ instrument }` (a
 *                          template, life-event.js assetsClosedBy), which refers
 *                          to no one asset
 *   a purchase's funding   `fundingConfig.sourceId`, labelled `sourceDisplayName`
 *
 * A reference is found by its id while that id names an asset in the plan, and
 * otherwise by its name. A reference whose name names no asset either WAITS:
 * it has no id, it keeps its name, it does nothing in a run, and the plan says
 * so (portfolio-issues.js, missing-asset-reference). An asset given that name
 * later picks it up. That is what deleting an asset does to the transfers,
 * closes and purchases that refer to it, and what re-adding an asset of the
 * same name undoes. (The rules an asset OWNS go with it: pruneDanglingRules.)
 *
 * A name is taken wherever an id is, because plans arrive that were written
 * before ids existed, or by hand: a saved scenario, an old share link, an MCP
 * spec, a test fixture. A name matches an asset's name exactly or, when only one
 * asset matches, ignoring case and outer spaces (the rule the asset form uses
 * for "another asset is already called that", asset-edit.js).
 */

import { LifeEvent, isCloseTemplate } from './life-event.js';
import { Instrument } from './instruments/instrument.js';

// ── The plan's format ───────────────────────────────────────────────────────

/**
 * The version of the plan format this code writes, carried beside a plan where
 * it is stored or sent (a saved scenario, a share link), never inside the spec,
 * so a run handle (a hash of the spec) does not depend on it.
 *
 *   absent  any plan written before formats were numbered: by names, or by ids
 *   2       closes are `{ assetId, displayName }`; a reference with no id waits
 *           for an asset of its name (the header)
 *
 * A reader refuses a plan written in a newer format than it knows: read by
 * older code, a newer plan's references can look like ones that name nothing,
 * and older code that saves it back loses them. That happened once, before
 * this number existed.
 */
export const PLAN_FORMAT = 2;

/** True when `format` is newer than this code reads. */
export function isNewerPlanFormat(format) {
    return Number.isFinite(Number(format)) && Number(format) > PLAN_FORMAT;
}

/** Why a newer plan is refused, as a sentence. */
export const NEWER_PLAN_FORMAT_REASON =
    'It was saved by a newer version of Charting Finance. Reload the page to open it.';

/**
 * Make a plan whole, in place: give each asset and life event an id, and find
 * every reference to an asset (see the header). In this order, and the order is
 * the point:
 *
 *   1. Forget every id a reference holds that names no asset in the plan,
 *      keeping the reference's name. A deleted asset's references become names.
 *   2. Number the assets and life events that have no id. A freed number can be
 *      given out again, and it is safe because of step 1: no reference holds it.
 *      Done the other way round, a rule left pointing at a deleted asset would
 *      start paying whichever new asset was numbered the same.
 *   3. Find by name each reference with no id, and write each found reference's
 *      label from its asset's name as it is now, so a renamed asset's transfers
 *      read its new name.
 *
 * Give it the whole plan: an id that names none of the assets it is given is
 * forgotten.
 *
 * Idempotent, and cheap enough to call before every run. Call it wherever a
 * plan comes in from outside (a saved scenario, a shared link, an MCP spec, a
 * quick-start profile) and before a plan is saved; Portfolio calls it too, for
 * plans built straight from JSON.
 *
 * Works on instances (ModelAsset, ModelLifeEvent, FundTransfer) and on their
 * JSON alike.
 *
 * @param {object[]} [modelAssets]
 * @param {object[]} [lifeEvents]
 * @returns {{ conflicts: string[] }} each reference whose id and name are two
 *   different assets, described. The id wins. planWithIds() refuses such a plan;
 *   the app cannot make one (it relabels every reference on every calculate).
 */
export function preparePlan(modelAssets = [], lifeEvents = []) {
    modelAssets ??= [];
    lifeEvents ??= [];
    forgetDeadIds(modelAssets, lifeEvents);
    assignIds(modelAssets, 'a', referencedAssetIds(modelAssets, lifeEvents));
    assignIds(lifeEvents, 'e');
    return resolveReferences(modelAssets, lifeEvents);
}

/**
 * Give every asset and life event that lacks an id one, in place, and nothing
 * else: preparePlan() is what a plan coming in needs.
 *
 * Idempotent: an id already unique within its list is kept. An item with no id,
 * or with one an earlier item in the list already has, gets the next number
 * after the highest in use.
 *
 * Works on ModelAsset and ModelLifeEvent instances and on their JSON alike: it
 * only reads and writes `id`.
 *
 * @param {Array<{id?: string|null}>} [modelAssets]
 * @param {Array<{id?: string|null}>} [lifeEvents]
 */
export function assignPlanIds(modelAssets = [], lifeEvents = []) {
    assignIds(modelAssets ?? [], 'a');
    assignIds(lifeEvents ?? [], 'e');
}

/**
 * A plan spec (the JSON that MCP tools, share links and run handles carry),
 * prepared: an id on every asset and life event, and every reference found
 * (preparePlan). The caller's spec is never changed: the result is a copy, its
 * assets and life events copied in full.
 *
 * The MCP tools call this as a spec comes in, so the ids are in the data from
 * then on. Without it, a spec written without ids (as Claude often writes one)
 * would be numbered again by every Portfolio built from it. The numbers would
 * agree, because each copy keeps the written order, but that is order standing
 * in for identity.
 *
 * A spec in which one reference names two different assets, one by id and one
 * by name, is refused: it is a spec edited by hand (a name changed and its id
 * left), and running either asset would be a guess at what was meant.
 *
 * @param {object|null|undefined} spec
 * @param {object} [options]
 * @param {boolean} [options.refuseConflicts=true]  false: the id wins, as in the app
 * @returns {object|null|undefined}
 * @throws {Error} on a reference whose id and name disagree, unless told not to
 */
export function planWithIds(spec, { refuseConflicts = true } = {}) {
    if (!spec) return spec;
    const copy = (list) => (Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : list);
    const out = { ...spec, modelAssets: copy(spec.modelAssets), lifeEvents: copy(spec.lifeEvents) };
    if (!('lifeEvents' in spec)) delete out.lifeEvents;
    if (!('modelAssets' in spec)) delete out.modelAssets;
    const { conflicts } = preparePlan(
        Array.isArray(out.modelAssets) ? out.modelAssets : [],
        Array.isArray(out.lifeEvents) ? out.lifeEvents : []);
    if (refuseConflicts && conflicts.length > 0) {
        throw new Error('This plan refers to two different assets in one place, one by id and one by '
            + `name: ${conflicts.join('; ')}. Drop the id or the name from each, so the plan says `
            + 'which asset is meant.');
    }
    return out;
}

/**
 * Number the items that need an id, starting after the highest `<prefix><n>`
 * already in use, by an item or in `reserved`. An id that does not have that
 * form (an MCP caller can write its own) is kept if it is unique, and can never
 * collide with a numbered one.
 */
function assignIds(items, prefix, reserved = []) {
    const numbered = new RegExp(`^${prefix}([1-9]\\d*)$`);
    const taken = new Set();
    const needIds = [];
    let highest = 0;
    for (const id of reserved) {
        const match = typeof id === 'string' ? numbered.exec(id) : null;
        if (match) highest = Math.max(highest, Number(match[1]));
    }
    for (const item of items) {
        const id = item.id;
        if (typeof id === 'string' && id.length > 0 && !taken.has(id)) {
            taken.add(id);
            const match = numbered.exec(id);
            if (match) highest = Math.max(highest, Number(match[1]));
        } else {
            needIds.push(item);
        }
    }
    for (const item of needIds) item.id = `${prefix}${++highest}`;
    return items;
}

// ── References ──────────────────────────────────────────────────────────────

const transfersOf = (asset) => (Array.isArray(asset.fundTransfers) ? asset.fundTransfers : []);
const rulesOf = (event) => (event.phaseTransfers && typeof event.phaseTransfers === 'object'
    ? event.phaseTransfers : {});
const closesOf = (event) => (Array.isArray(event.closes) ? event.closes : []);
const fundingOf = (asset) => (asset.fundingConfig && typeof asset.fundingConfig === 'object'
    ? asset.fundingConfig : null);

/** A `closes` entry that refers to one asset, by id, by name or both (not a template). */
export function isAssetClose(entry) {
    return !!entry && typeof entry === 'object' && !isCloseTemplate(entry)
        && (entry.assetId != null || typeof entry.displayName === 'string');
}

/** The shape of an id this file gives an asset. */
const ASSET_ID = /^a[1-9]\d*$/;

/** How two names are compared when they do not match exactly (asset-edit.js assetNameProblem). */
const nameKey = (name) => String(name ?? '').trim().toLowerCase();

/** Remove an id from a reference: null on an instance, gone from JSON. */
function forget(holder, key) {
    if (Object.getPrototypeOf(holder) === Object.prototype) delete holder[key];
    else holder[key] = null;
}

/**
 * Step 1 of preparePlan: every id a reference holds that names no asset is
 * forgotten, and the reference keeps its name. The assets' own ids are the ones
 * in force: an asset not yet numbered has none, and nothing can hold its id.
 */
function forgetDeadIds(modelAssets, lifeEvents) {
    const live = new Set();
    for (const asset of modelAssets) {
        if (typeof asset.id === 'string' && asset.id.length > 0) live.add(asset.id);
    }
    const unlessLive = (holder, key) => {
        if (holder && typeof holder === 'object' && holder[key] != null && !live.has(holder[key])) {
            forget(holder, key);
        }
    };
    for (const asset of modelAssets) {
        transfersOf(asset).forEach((ft) => unlessLive(ft, 'toId'));
        unlessLive(fundingOf(asset), 'sourceId');
    }
    for (const event of lifeEvents) {
        for (const list of Object.values(rulesOf(event))) {
            if (Array.isArray(list)) list.forEach((ft) => unlessLive(ft, 'toId'));
        }
        for (const entry of closesOf(event)) if (isAssetClose(entry)) unlessLive(entry, 'assetId');
    }
}

/**
 * The strings held where an asset id can be and that step 1 does not forget: a
 * phase's rule keys and a close written as a bare string, each an id or a name
 * (a key has no separate name field to fall back on). Numbering steps over the
 * ids among them, so a deleted asset's rules are not given to a new asset before
 * the app prunes them.
 */
function referencedAssetIds(modelAssets, lifeEvents) {
    const out = [];
    for (const event of lifeEvents) {
        out.push(...Object.keys(rulesOf(event)));
        for (const entry of closesOf(event)) if (typeof entry === 'string') out.push(entry);
    }
    return out;
}

/** Step 3 of preparePlan. */
function resolveReferences(modelAssets, lifeEvents) {
    const byId = new Map();
    const exact = new Map();
    const loose = new Map();   // nameKey → asset, or null when two share it
    for (const asset of modelAssets) {
        byId.set(asset.id, asset);
        if (typeof asset.displayName !== 'string') continue;
        if (!exact.has(asset.displayName)) exact.set(asset.displayName, asset);
        const key = nameKey(asset.displayName);
        if (key) loose.set(key, loose.has(key) ? null : asset);
    }
    const byName = (name) => (typeof name === 'string'
        ? exact.get(name) ?? loose.get(nameKey(name)) ?? null : null);
    // A phase's rule key, or a close written as a bare string, is an id or a
    // name; an id wins.
    const idOrName = (ref) => (typeof ref === 'string' ? byId.get(ref) ?? byName(ref) : null);

    const conflicts = [];
    /**
     * One reference: `idKey` holds its id (live, after step 1), `labelKey` its
     * name. Found by id, else by name; a found one is relabelled.
     */
    const resolve = (holder, idKey, labelKey, where) => {
        if (!holder || typeof holder !== 'object') return;
        if (holder[idKey] != null) {
            const asset = byId.get(holder[idKey]);
            const named = byName(holder[labelKey]);
            if (named && named !== asset) {
                conflicts.push(`${where} has ${idKey} "${holder[idKey]}", which is "${asset.displayName}", `
                    + `and ${labelKey} "${holder[labelKey]}", which is a different asset`);
            }
            holder[labelKey] = asset.displayName;
            return;
        }
        const asset = byName(holder[labelKey]);
        if (!asset) return;   // waits, by its name
        holder[idKey] = asset.id;
        holder[labelKey] = asset.displayName;
    };

    for (const asset of modelAssets) {
        transfersOf(asset).forEach((ft) => resolve(ft, 'toId', 'toDisplayName',
            `${asset.displayName}'s transfer`));
        resolve(fundingOf(asset), 'sourceId', 'sourceDisplayName', `${asset.displayName}'s funding`);
    }

    for (const event of lifeEvents) {
        const phase = event.displayName ?? event.type ?? 'a phase';
        const rules = rulesOf(event);
        const entries = Object.entries(rules);
        const rekeyed = [];
        for (const [key, list] of entries) {
            const owner = idOrName(key);
            if (Array.isArray(list)) {
                list.forEach((ft) => resolve(ft, 'toId', 'toDisplayName',
                    `${owner?.displayName ?? key}'s ${phase} rule`));
            }
            const newKey = owner ? owner.id : key;
            const at = rekeyed.findIndex(([k]) => k === newKey);
            if (at < 0) rekeyed.push([newKey, list]);
            // Rules under the id and under the old name: the id's were written
            // by code that knew the id, so they are the newer.
            else if (owner && key === owner.id) rekeyed[at] = [newKey, list];
        }
        // In place, so anything holding this phase's rules object still sees them.
        if (rekeyed.length !== entries.length || rekeyed.some(([k], i) => k !== entries[i][0])) {
            for (const [key] of entries) delete rules[key];
            for (const [key, list] of rekeyed) rules[key] = list;
        }

        resolveCloses(event, phase, { idOrName, resolve });
    }

    return { conflicts };
}

/**
 * A phase's closes, each made `{ assetId, displayName }` (or a template, left as
 * it is). A bare string is an id or a name, as plans before names were kept with
 * closes wrote it. In place.
 */
function resolveCloses(event, phase, { idOrName, resolve }) {
    const closes = closesOf(event);

    // Retire's default was once the name "Salary". In a plan whose salaries are
    // called something else ("Salary A", "Salary B") it closed nothing, and
    // what it meant is what the default now says: every working income.
    if (event.type === LifeEvent.RETIRE && closes.length === 1 && closes[0] === 'Salary'
        && !idOrName('Salary')) {
        closes[0] = { instrument: Instrument.WORKING_INCOME };
    }

    for (let i = closes.length - 1; i >= 0; i--) {
        const entry = closes[i];
        if (typeof entry === 'string') {
            const asset = idOrName(entry);
            if (asset) closes[i] = { assetId: asset.id, displayName: asset.displayName };
            // An id that names nothing, from a plan saved before closes kept a
            // name: there is no name to wait for, and it closed nothing.
            else if (ASSET_ID.test(entry)) closes.splice(i, 1);
            else closes[i] = { displayName: entry };
        } else if (isAssetClose(entry)) {
            resolve(entry, 'assetId', 'displayName', `${phase}'s close`);
            // Always the same keys in the same order: a run handle is a hash of
            // the plan's JSON, so a close found by name must read as one written
            // with its id.
            closes[i] = entry.assetId != null
                ? { assetId: entry.assetId, displayName: entry.displayName }
                : { displayName: entry.displayName };
        }
    }
}

/**
 * The rules a phase keeps for an asset the plan no longer has go: the rules of
 * an asset that was deleted. By id, after preparePlan(): a renamed asset keeps
 * its id, so its rules stay.
 *
 * Transfers TO a deleted asset stay, waiting by name (see the header), and so
 * do closes and purchase funding: an asset given that name picks them up.
 *
 * @param {object[]} modelAssets
 * @param {object[]} lifeEvents
 */
export function pruneDanglingRules(modelAssets = [], lifeEvents = []) {
    const ids = new Set((modelAssets ?? []).map((a) => a.id));
    for (const event of lifeEvents ?? []) {
        const rules = event.phaseTransfers;
        if (!rules || typeof rules !== 'object') continue;
        for (const owner of Object.keys(rules)) {
            if (!ids.has(owner)) delete rules[owner];
        }
    }
}

/**
 * Every reference in a prepared plan that waits: it names, by name only, an
 * asset the plan does not have. Grouped by that name, in the order found.
 *
 * Read by the "What needs attention" notice (portfolio-issues.js) and by the
 * page, which shows each one where it lives so it can be removed.
 *
 * @param {object[]} modelAssets
 * @param {object[]} lifeEvents
 * @returns {Array<{ name: string, refs: Array<
 *     { kind: 'transfer', ownerId: string, ownerName: string, phaseId: string|null, phaseName: string|null, monthly: number, onClose: number }
 *   | { kind: 'close', phaseId: string|null, phaseName: string }
 *   | { kind: 'funding', ownerId: string, ownerName: string }
 *   | { kind: 'rules', phaseId: string|null, phaseName: string } >}>}
 */
export function waitingReferences(modelAssets = [], lifeEvents = []) {
    const ids = new Set((modelAssets ?? []).map((a) => a.id));
    const nameOf = new Map((modelAssets ?? []).map((a) => [a.id, a.displayName]));
    const groups = new Map();
    const add = (name, ref) => {
        const label = typeof name === 'string' && name.trim() ? name : '(unnamed)';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(ref);
    };
    const waits = (ft) => ft && ft.toId == null;
    const inPhases = new Set();   // owner id + target name, for the dedupe below

    for (const event of lifeEvents ?? []) {
        const phaseName = event.displayName ?? event.type ?? null;
        for (const [owner, list] of Object.entries(rulesOf(event))) {
            // Rules for an asset the plan does not have (an MCP spec; the app
            // prunes them). Keyed by its name if it was written with one.
            if (!ids.has(owner)) {
                if (!ASSET_ID.test(owner)) add(owner, { kind: 'rules', phaseId: event.id ?? null, phaseName });
                continue;
            }
            for (const ft of Array.isArray(list) ? list : []) {
                if (waits(ft)) {
                    inPhases.add(`${owner}\u0000${ft.toDisplayName}`);
                    add(ft.toDisplayName, { kind: 'transfer', ownerId: owner, ownerName: nameOf.get(owner),
                        phaseId: event.id ?? null, phaseName, monthly: ft.monthlyMoveValue ?? 0, onClose: ft.closeMoveValue ?? 0 });
                }
            }
        }
        for (const entry of closesOf(event)) {
            if (isAssetClose(entry) && entry.assetId == null) {
                add(entry.displayName, { kind: 'close', phaseId: event.id ?? null, phaseName });
            }
        }
    }
    for (const asset of modelAssets ?? []) {
        // An asset's own transfers. After a run they hold the rules of the last
        // phase that set them (Portfolio.applyPhaseTransfers), already listed above.
        for (const ft of transfersOf(asset)) {
            if (waits(ft) && !inPhases.has(`${asset.id}\u0000${ft.toDisplayName}`)) {
                add(ft.toDisplayName, { kind: 'transfer', ownerId: asset.id, ownerName: asset.displayName,
                    phaseId: null, phaseName: null, monthly: ft.monthlyMoveValue ?? 0, onClose: ft.closeMoveValue ?? 0 });
            }
        }
        const funding = fundingOf(asset);
        if (funding && funding.sourceId == null) {
            add(funding.sourceDisplayName, { kind: 'funding', ownerId: asset.id, ownerName: asset.displayName });
        }
    }
    return [...groups].map(([name, refs]) => ({ name, refs }));
}
