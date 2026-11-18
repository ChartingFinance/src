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
 * Four things in a plan refer to an asset, and each holds its id:
 *
 *   a fund transfer        `toId`, with `toDisplayName` as its label
 *   a phase's rules        `phaseTransfers`, keyed by the asset whose rules they are
 *   a phase's closes       `closes`, a list of the assets it closes
 *   a purchase's funding   `fundingConfig.sourceId`, with `sourceDisplayName` as its label
 *
 * A name is still taken wherever an id is, because plans arrive that were
 * written before ids existed, or by hand: a saved scenario, an old share link,
 * an MCP spec, a test fixture. preparePlan() turns each name it can resolve
 * into that asset's id, and writes each label from the asset's name as it is
 * now, so a renamed asset's transfers read its new name. The engine reads ids
 * only. A reference that names no asset is left as it is and refers to
 * nothing; the app prunes those when it recalculates.
 */

/**
 * Make a plan whole, in place: give each asset and life event an id, and turn
 * every reference to an asset into that asset's id (see the header).
 *
 * Idempotent, and cheap enough to call before every run. Call it wherever a
 * plan comes in from outside (a saved scenario, a shared link, an MCP spec, a
 * quick-start profile) and before a plan is saved; Portfolio calls it too, for
 * plans built straight from JSON.
 *
 * A new asset is never given an id a reference still holds. Otherwise a rule
 * left pointing at a deleted asset would start paying whichever new asset
 * happened to be numbered the same.
 *
 * Works on instances (ModelAsset, ModelLifeEvent, FundTransfer) and on their
 * JSON alike.
 *
 * @param {object[]} [modelAssets]
 * @param {object[]} [lifeEvents]
 */
export function preparePlan(modelAssets = [], lifeEvents = []) {
    modelAssets ??= [];
    lifeEvents ??= [];
    assignIds(modelAssets, 'a', referencedAssetIds(modelAssets, lifeEvents));
    assignIds(lifeEvents, 'e');
    resolveReferences(modelAssets, lifeEvents);
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
 * prepared: an id on every asset and life event, and every reference to an
 * asset by id (preparePlan). The caller's spec is never changed: the result is
 * a copy, its assets and life events copied in full.
 *
 * The MCP tools call this as a spec comes in, so the ids are in the data from
 * then on. Without it, a spec written without ids (as Claude often writes one)
 * would be numbered again by every Portfolio built from it. The numbers would
 * agree, because each copy keeps the written order, but that is order standing
 * in for identity.
 *
 * @param {object|null|undefined} spec
 * @returns {object|null|undefined}
 */
export function planWithIds(spec) {
    if (!spec) return spec;
    const copy = (list) => (Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : list);
    const out = { ...spec, modelAssets: copy(spec.modelAssets), lifeEvents: copy(spec.lifeEvents) };
    if (!('lifeEvents' in spec)) delete out.lifeEvents;
    if (!('modelAssets' in spec)) delete out.modelAssets;
    preparePlan(
        Array.isArray(out.modelAssets) ? out.modelAssets : [],
        Array.isArray(out.lifeEvents) ? out.lifeEvents : []);
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

/** Every string held where an asset id can be: an id, or a name not yet resolved. */
function referencedAssetIds(modelAssets, lifeEvents) {
    const out = [];
    for (const asset of modelAssets) {
        for (const ft of transfersOf(asset)) out.push(ft?.toId);
        out.push(asset.fundingConfig?.sourceId);
    }
    for (const event of lifeEvents) {
        for (const [owner, rules] of Object.entries(rulesOf(event))) {
            out.push(owner);
            if (Array.isArray(rules)) for (const ft of rules) out.push(ft?.toId);
        }
        for (const entry of closesOf(event)) out.push(entry);
    }
    return out;
}

function resolveReferences(modelAssets, lifeEvents) {
    const byId = new Map();
    const byName = new Map();
    for (const asset of modelAssets) {
        byId.set(asset.id, asset);
        if (typeof asset.displayName === 'string' && !byName.has(asset.displayName)) {
            byName.set(asset.displayName, asset);
        }
    }
    // A phase's rules and closes are keyed by an id or, in an older plan, a
    // name; an id wins. A transfer's target and a purchase's source each have a
    // field of their own for the id, so their name fields are only ever names.
    const idOrName = (ref) => (typeof ref === 'string' ? byId.get(ref) ?? byName.get(ref) ?? null : null);

    const resolveTransfer = (ft) => {
        if (!ft || typeof ft !== 'object') return;
        const target = ft.toId != null ? byId.get(ft.toId) : byName.get(ft.toDisplayName);
        if (!target) return;
        ft.toId = target.id;
        ft.toDisplayName = target.displayName;
    };

    for (const asset of modelAssets) {
        transfersOf(asset).forEach(resolveTransfer);
        const funding = asset.fundingConfig;
        if (funding && typeof funding === 'object') {
            const source = funding.sourceId != null
                ? byId.get(funding.sourceId) : byName.get(funding.sourceDisplayName);
            if (source) {
                funding.sourceId = source.id;
                funding.sourceDisplayName = source.displayName;
            }
        }
    }

    for (const event of lifeEvents) {
        const rules = rulesOf(event);
        const entries = Object.entries(rules);
        const rekeyed = [];
        for (const [key, list] of entries) {
            if (Array.isArray(list)) list.forEach(resolveTransfer);
            const owner = idOrName(key);
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

        const closes = closesOf(event);
        closes.forEach((entry, i) => {
            if (typeof entry === 'string') closes[i] = idOrName(entry)?.id ?? entry;
        });
    }
}

/**
 * Delete the phase rules that refer to an asset the plan no longer has: the
 * rules of an asset that was deleted, and transfers to one. By id, after
 * preparePlan(): a renamed asset keeps its id, so its rules stay. A rule whose
 * target nothing resolved goes too, as it always has.
 *
 * Closes are left alone. One that names no asset closes nothing, and its id is
 * not given to a new asset while it is held (preparePlan).
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
        for (const list of Object.values(rules)) {
            if (!Array.isArray(list)) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                if (!ids.has(list[i]?.toId)) list.splice(i, 1);
            }
        }
    }
}
