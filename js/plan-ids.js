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
 */

/**
 * Give every asset and life event that lacks an id one, in place.
 *
 * Idempotent: an id already unique within its list is kept. An item with no id,
 * or with one an earlier item in the list already has, gets the next number
 * after the highest in use. Call it wherever a plan comes in from outside (a
 * saved scenario, a shared link, an MCP spec, a quick-start profile) and before
 * a plan is saved; Portfolio's constructor calls it too, for plans built
 * straight from JSON.
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
 * Number the items that need an id, starting after the highest `<prefix><n>`
 * already in use. An id that does not have that form (an MCP caller can write
 * its own) is kept if it is unique, and can never collide with a numbered one.
 */
function assignIds(items, prefix) {
    const numbered = new RegExp(`^${prefix}([1-9]\\d*)$`);
    const taken = new Set();
    const needIds = [];
    let highest = 0;
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
