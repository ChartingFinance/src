/**
 * scenario-store.mjs — a shared plan opened with Open writes nothing, and each
 * scenario keeps its own settings.
 *
 * ── What is at stake ──────────────────────────────────────────────────
 *
 * A share link's import dialog offers Open and Open & Save, and the plugin
 * tells people the first "views the plan without writing it into their saved
 * scenarios". Every path from Open to storage breaks that: the setters store
 * whatever they are given, and the calculate() that draws the plan ends by
 * saving it as the active scenario, which is the viewer's own: its assets, life
 * events, the menu's preview curve and the month's snapshot, the one copy that
 * could bring it back.
 *
 * Settings are the other half. A scenario that keeps no settings of its own
 * runs on whatever is in force, so putting a link's settings in force, even to
 * save it as a new scenario, reruns every other scenario as someone else: a
 * different age, filing status and inflation rate, and a different answer, with
 * nothing in its storage changed.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 * Storage is compared byte for byte, before and after, because "nothing is
 * written" is the promise, and a comparison of a few chosen keys would pass
 * with the snapshot or the preview curve overwritten. The settings in force are
 * compared too: a fix that wrote nothing by not applying the link at all would
 * show the viewer's plan on the link's assets and pass a storage-only check.
 *
 * finplan-app.js needs a browser, so its half (it saves only through
 * scenario-store.js, holds the settings before it applies them, stamps the
 * scenarios before it reads a link) is asserted from its source, the way
 * share-link.mjs does.
 *
 * Run: node tests/scenario-store.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const S = await import('../js/scenario-store.js');
const U = await import('../js/ui/util.js');
const { readSharedPlan, applySharedSettings } = await import('../js/shared-plan.js');
const { shareUrlFromPlan, sharePayloadParamFrom, decodeSharePayload, sharePayloadFromPlan } =
  await import('../js/share-link.js');
const { planFromProfile } = await import('../js/mcp/run-plan.js');
const { SIM_CONFIG_DEFAULTS } = await import('../js/sim-config.js');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
  finally { S.closeUnsaved(); }   // one check's unsaved plan never leaks into the next
}

const ARC = 'default';

/** All of storage, in a form two states can be compared by. */
const storage = () => JSON.stringify(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));

/** A link's payload, decoded the way the app decodes its own address. */
const arrive = (url) => {
  const u = new URL(url);
  return decodeSharePayload(sharePayloadParamFrom(u.search, u.hash));
};

// The link the bug was found with: Pre-Retirement, Single, 55/65/90, 3.1%.
const link = shareUrlFromPlan(planFromProfile('preRetirement'), { origin: 'http://localhost:5173/' }).url;
const LINK_SETTINGS = {
  inflationRate: 0.031, filingAs: 'Single', startAge: 55, retirementAge: 65, finishAge: 90,
  backtestYear: SIM_CONFIG_DEFAULTS.backtestYear,
};

// The viewer's two scenarios. No setting matches the link's or a default, so a
// setting that fails to move, or moves when it should not, shows.
const MINE = {
  settings: { inflationRate: 0.025, filingAs: 'MFJ', startAge: 35, retirementAge: 67, finishAge: 90, backtestYear: '2008' },
  guardrails: { withdrawalRate: 4, preservation: 20, prosperity: 25, adjustment: 10 },
};
const OTHER = {
  settings: { inflationRate: 0.035, filingAs: 'Single', startAge: 45, retirementAge: 62, finishAge: 95, backtestYear: '2001' },
  guardrails: { withdrawalRate: 4.5, preservation: 12, prosperity: 18, adjustment: 9 },
};

/** Put guardrail parameters in force, the way loading a scenario does. */
function putGuardrailsInForce(gp) {
  G.global_setGuardrailWithdrawalRate(gp.withdrawalRate);
  G.global_setGuardrailPreservation(gp.preservation);
  G.global_setGuardrailProsperity(gp.prosperity);
  G.global_setGuardrailAdjustment(gp.adjustment);
}

const guardrailsInForce = () => ({
  withdrawalRate: G.global_guardrail_withdrawalRate,
  preservation: G.global_guardrail_preservation,
  prosperity: G.global_guardrail_prosperity,
  adjustment: G.global_guardrail_adjustment,
});

/** Save the plan on screen the way calculate() ends: preview curve, then the scenario. */
function calculateSaves(storyName, assetNames) {
  const wrotePreview = S.saveScenarioPreview(ARC, storyName, { series: [1, 2], end: 2, ts: 0 });
  const wroteScenario = S.saveScenario(ARC, storyName, {
    assets: assetNames.map((displayName) => ({ displayName })),
    lifeEvents: [{ type: 'ACCUMULATE', triggerAge: 35 }],
    guardrails: guardrailsInForce(),
  });
  return wrotePreview || wroteScenario;
}

/**
 * A viewer with two saved scenarios, 'mine' active, each saved on its own
 * settings, and mine's in force: the state the app leaves after a session.
 */
function viewerWithTwoScenarios() {
  for (const k of Object.keys(store)) delete store[k];
  G.global_setSimDataMode('calibrated');
  for (const [name, scenario, assets] of [
    ['other', OTHER, ['Salary', 'Brokerage']],
    ['mine', MINE, ['Salary A', 'Salary B', '401K A', 'Home', 'Mortgage']],
  ]) {
    U.util_ensureStoryNames(ARC, name);
    S.putSettingsInForce(scenario.settings);
    putGuardrailsInForce(scenario.guardrails);
    assert.ok(calculateSaves(name, assets), `the viewer's ${name} scenario was not saved`);
  }
  localStorage.setItem('activeStoryName', 'mine');
}

// ── Holding the settings ─────────────────────────────────────────────
console.log('\n── Held settings are in force and never stored ──\n');

check('held, every plan setting moves in memory and storage does not change', () => {
  viewerWithTwoScenarios();
  const before = storage();
  G.global_holdPlanSettings();
  S.putSettingsInForce(LINK_SETTINGS);
  putGuardrailsInForce({ withdrawalRate: 3, preservation: 30, prosperity: 30, adjustment: 30 });
  assert.deepEqual(S.settingsInForce(), LINK_SETTINGS);
  assert.equal(G.global_guardrail_withdrawalRate, 3);
  assert.equal(storage(), before, 'a held setting was stored');
  G.global_releasePlanSettings();
});

check('held, a getter reads back what its setter set, not what is stored', () => {
  // The app pairs setters with getters (`global_setUserStartAge(v);
  // global_getUserStartAge()`), and calculate() does it for the retirement age.
  // A getter reading storage would put the viewer's value straight back.
  viewerWithTwoScenarios();
  G.global_holdPlanSettings();
  G.global_setUserStartAge(52);
  G.global_getUserStartAge();
  G.global_setUserRetirementAge(60);
  G.global_getUserRetirementAge();
  G.global_setInflationRate(0.04);
  G.global_getInflationRate();
  assert.deepEqual([G.global_user_startAge, G.global_user_retirementAge, G.global_inflationRate], [52, 60, 0.04]);
  G.global_releasePlanSettings();
});

check('released, the stored settings come back into force', () => {
  viewerWithTwoScenarios();
  const before = storage();
  G.global_holdPlanSettings();
  S.putSettingsInForce(LINK_SETTINGS);
  G.global_releasePlanSettings();
  assert.deepEqual(S.settingsInForce(), MINE.settings);
  assert.equal(storage(), before);
});

check('released and kept, the held settings are stored', () => {
  viewerWithTwoScenarios();
  G.global_holdPlanSettings();
  S.putSettingsInForce(LINK_SETTINGS);
  G.global_releasePlanSettings({ keep: true });
  assert.deepEqual(S.settingsInForce(), LINK_SETTINGS);
  assert.equal(store.userStartAge, '55');
  assert.equal(store.filingAs, 'Single');
});

check("the viewer's own preferences are stored even while plan settings are held", () => {
  // Sampling mode and diagnostics belong to the viewer, not to a plan, so a
  // change made while looking at a shared plan is theirs to keep.
  viewerWithTwoScenarios();
  G.global_holdPlanSettings();
  G.global_setSimDataMode('historical');
  G.global_releasePlanSettings();
  assert.equal(store.simDataMode, 'historical');
  assert.equal(G.global_simDataMode, 'historical');
});

// ── Open ─────────────────────────────────────────────────────────────
console.log('\n── Open shows the link and writes nothing ──\n');

check('Open writes nothing: no scenario, preview, snapshot or setting', () => {
  viewerWithTwoScenarios();
  const before = storage();
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  assert.equal(calculateSaves('mine', ['Salary', 'Social Security', '401K', 'IRA', 'Roth IRA', 'Brokerage', 'Living Expenses']),
    false, 'the shared plan was saved over the active scenario');
  assert.equal(storage(), before, 'opening the link changed what the viewer has stored');
  // And the plan on screen is the link's, on the link's settings.
  assert.deepEqual(S.settingsInForce(), LINK_SETTINGS);
});

check('edits made while it is open are not stored either', () => {
  viewerWithTwoScenarios();
  const before = storage();
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  // The settings row, the retirement rule in calculate(), a guardrail.
  G.global_setInflationRate(0.045);
  G.global_setUserRetirementAge(63);
  G.global_getUserRetirementAge();
  G.global_setGuardrailPreservation(22);
  assert.equal(calculateSaves('mine', ['Salary']), false);
  assert.equal(storage(), before);
  assert.equal(G.global_inflationRate, 0.045, 'an edit to the open plan did not take');
});

check("leaving it puts the viewer's settings back, and storage is as it was", () => {
  viewerWithTwoScenarios();
  const before = storage();
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  G.global_setUserStartAge(50);
  S.closeUnsaved();
  assert.equal(S.unsavedPlan(), null);
  assert.deepEqual(S.settingsInForce(), MINE.settings);
  assert.deepEqual(guardrailsInForce(), MINE.guardrails);
  assert.equal(storage(), before);
  // From here the app saves again.
  assert.equal(calculateSaves('mine', ['Salary A']), true);
});

check('a scenario switched to from it runs on its own settings', () => {
  viewerWithTwoScenarios();
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  S.closeUnsaved();
  assert.equal(S.restoreScenarioSettings(ARC, 'other'), true);
  assert.deepEqual(S.settingsInForce(), OTHER.settings);
});

check("a second link opened over an unsaved plan starts from the viewer's settings", () => {
  // A link with no guardrail parameters keeps the ones in force. Over an
  // unsaved plan those must be the viewer's, not the previous link's.
  viewerWithTwoScenarios();
  const first = { ...sharePayloadFromPlan(planFromProfile('retired')),
                  guardrailParams: { withdrawalRate: 3, preservation: 30, prosperity: 30, adjustment: 30 } };
  const { guardrailParams: _, ...second } = arrive(link);
  S.openUnsaved({ title: 'Retired' });
  applySharedSettings(readSharedPlan(first));
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(second));
  assert.deepEqual(guardrailsInForce(), MINE.guardrails);
  assert.deepEqual(S.unsavedPlan(), { title: 'Pre-Retirement', note: '' });
});

// ── Open & Save, and saving later ────────────────────────────────────
console.log('\n── A saved link is a new scenario, on its own settings ──\n');

check('Open & Save adds a scenario on the link\'s settings and changes no other scenario\'s', () => {
  viewerWithTwoScenarios();
  const mineBefore = store['default+mine+settings'];
  const otherBefore = store['default+other+settings'];
  applySharedSettings(readSharedPlan(arrive(link)));
  U.util_ensureStoryNames(ARC, 'shared');
  assert.equal(calculateSaves('shared', ['Salary', 'Social Security']), true);

  assert.deepEqual(U.util_loadLocalScenarioSettings(ARC, 'shared'), LINK_SETTINGS);
  assert.equal(store['default+mine+settings'], mineBefore);
  assert.equal(store['default+other+settings'], otherBefore);

  // Each runs on its own when switched to.
  S.restoreScenarioSettings(ARC, 'mine');
  assert.deepEqual(S.settingsInForce(), MINE.settings);
  S.restoreScenarioSettings(ARC, 'other');
  assert.deepEqual(S.settingsInForce(), OTHER.settings);
});

check('saving the unsaved plan keeps its settings, edits included, with the new scenario only', () => {
  viewerWithTwoScenarios();
  const mineBefore = store['default+mine+settings'];
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  G.global_setInflationRate(0.045);
  S.closeUnsaved({ keep: true });
  U.util_ensureStoryNames(ARC, 'saved');
  assert.equal(calculateSaves('saved', ['Salary']), true);
  assert.deepEqual(U.util_loadLocalScenarioSettings(ARC, 'saved'), { ...LINK_SETTINGS, inflationRate: 0.045 });
  assert.equal(store['default+mine+settings'], mineBefore);
});

check('a link that leaves out the backtest year opens with none, not the viewer\'s', () => {
  // The MCP server's links never carry one, and it runs them with none; a
  // scenario that kept the viewer's would show other numbers than the report.
  viewerWithTwoScenarios();
  assert.equal(G.global_backtestYear, '2008');
  const plan = readSharedPlan(arrive(link));
  assert.equal(plan.backtestYear, SIM_CONFIG_DEFAULTS.backtestYear);
  applySharedSettings(plan);
  assert.equal(G.global_backtestYear, SIM_CONFIG_DEFAULTS.backtestYear);

  const withOne = arrive(link);
  withOne.settings = { ...withOne.settings, backtestYear: '2001' };
  applySharedSettings(readSharedPlan(withOne));
  assert.equal(G.global_backtestYear, '2001');
});

// ── Each scenario's settings ─────────────────────────────────────────
console.log('\n── Scenarios saved before they kept settings ──\n');

check('a scenario with no settings of its own is given the ones in force, once', () => {
  for (const k of Object.keys(store)) delete store[k];
  U.util_ensureStoryNames(ARC, 'old');
  U.util_ensureStoryNames(ARC, 'kept');
  U.util_saveLocalScenarioSettings(ARC, 'kept', OTHER.settings);
  S.putSettingsInForce(MINE.settings);

  assert.deepEqual(S.stampScenarioSettings(ARC), ['old']);
  assert.deepEqual(U.util_loadLocalScenarioSettings(ARC, 'old'), MINE.settings);
  assert.deepEqual(U.util_loadLocalScenarioSettings(ARC, 'kept'), OTHER.settings);
  assert.deepEqual(S.stampScenarioSettings(ARC), [], 'stamping twice stamped again');
});

check('nothing is stamped while an unsaved plan is open, whose settings are not the viewer\'s', () => {
  for (const k of Object.keys(store)) delete store[k];
  U.util_ensureStoryNames(ARC, 'old');
  S.openUnsaved({ title: 'Pre-Retirement' });
  applySharedSettings(readSharedPlan(arrive(link)));
  assert.deepEqual(S.stampScenarioSettings(ARC), []);
  assert.equal(U.util_loadLocalScenarioSettings(ARC, 'old'), null);
});

check('stored settings a setter cannot take keep the ones in force instead of throwing', () => {
  viewerWithTwoScenarios();
  U.util_saveLocalScenarioSettings(ARC, 'odd',
    { inflationRate: '3%', filingAs: 'Married', startAge: 50, retirementAge: null, finishAge: 92 });
  assert.equal(S.restoreScenarioSettings(ARC, 'odd'), true);
  assert.deepEqual(S.settingsInForce(),
    { ...MINE.settings, startAge: 50, finishAge: 92 });
  assert.equal(S.restoreScenarioSettings(ARC, 'never-saved'), false);
});

check('a stored inflation rate shows as the percent it was entered as', () => {
  // Switching scenarios puts each one's rate back in the settings row, so a
  // float artefact there (3.5000000000000004) showed on every switch.
  for (const [rate, shown] of [[0.035, 3.5], [0.029, 2.9], [0.07, 7], [0.0725, 7.25], [0.031, 3.1]]) {
    G.global_setInflationRate(rate);
    assert.equal(G.global_multBy100(G.global_inflationRate), shown);
  }
});

check('deleting a scenario deletes its settings', () => {
  viewerWithTwoScenarios();
  U.util_deleteScenario(ARC, 'other');
  assert.equal(store['default+other+settings'], undefined);
  assert.ok(store['default+mine+settings'], 'the other scenario lost its settings');
});

// ── The app ──────────────────────────────────────────────────────────
console.log('\n── The app saves through this, and in this order ──\n');

// Normalised because '\n}\n' (a function's closing brace) is the end marker.
const app = readFileSync('js/finplan-app.js', 'utf8').replace(/\r\n/g, '\n');
const body = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `finplan-app.js has no function ${name}`);
  return app.slice(start, app.indexOf('\n}\n', start));
};

check('the app saves a scenario only through scenario-store.js', () => {
  // A direct write would not know an unsaved plan is on screen.
  const direct = app.match(/util_saveLocal(AssetModels|LifeEvents|GuardrailParams|ScenarioPreview|ScenarioSettings)\(/g);
  assert.equal(direct, null, `finplan-app.js writes scenario data itself: ${direct}`);
  const writes = [...app.matchAll(/localStorage\.setItem\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ["'finplan.expandedSections'"], `finplan-app.js stores: ${writes}`);
  assert.ok(/saveScenario\(/.test(body('saveLocalData')));
  assert.ok(/saveScenarioPreview\(/.test(body('cacheScenarioPreview')));
});

check('Open holds the settings before it applies them', () => {
  const apply = body('applyImportedPortfolio');
  const held = apply.indexOf('openUnsaved(');
  const dropped = apply.indexOf('closeUnsaved(');
  const applied = apply.indexOf('applySharedSettings(plan)');
  assert.ok(held >= 0 && held < applied, 'the link\'s settings are applied before they are held, so they are stored');
  assert.ok(dropped >= 0 && dropped < applied, 'Open & Save keeps an earlier unsaved plan\'s settings held');
});

check('the scenarios are stamped before a link is read', () => {
  const init = body('initiateActiveData');
  const stamped = init.indexOf('stampScenarioSettings(');
  assert.ok(stamped >= 0 && stamped < init.indexOf('loadSharedPortfolio()'),
    'a link saved with Open & Save would be stamped onto the viewer\'s older scenarios');
});

check('a scenario switched to runs on its own settings, the one under an unsaved plan included', () => {
  const sw = body('switchScenario');
  assert.ok(/restoreScenarioSettings\(/.test(sw), 'switching keeps the settings of the scenario left');
  assert.ok(sw.indexOf('unsavedPlan()') < sw.indexOf('storyName === appState.storyName'),
    'picking the scenario an unsaved plan was opened over is skipped as the current one');
  assert.ok(/restoreScenarioSettings\(/.test(body('deleteScenario')),
    'deleting a scenario leaves its settings on the next one');
});

check('a guardrail edit is saved with its scenario', () => {
  // It was stored only as the setting in force, so a reload put the scenario's
  // old parameters back.
  assert.ok(/saveLocalData\(\)/.test(body('connectGuardrailInput')));
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
