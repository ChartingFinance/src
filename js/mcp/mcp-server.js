#!/usr/bin/env node
/**
 * mcp-server.js — MCP server for Claude Desktop integration
 *
 * Exposes the financial simulation engine as tools that AI clients
 * can invoke over the Model Context Protocol (stdio transport).
 *
 * Usage:  node js/mcp/mcp-server.js
 *
 * ── Thin by design ───────────────────────────────────────────────────
 *
 * Every tool here goes through runPlan() in run-plan.js and formats the
 * result. Nothing in this file constructs a Portfolio, sets a global or
 * builds a TaxTable — that sequence has six steps and an ordering
 * constraint, and the previous version of this file got three of them
 * wrong by doing it inline. See the module comment in run-plan.js.
 *
 * As of Spec 9 step 6 this server needs no localStorage polyfill. The engine
 * takes its configuration as a value, so nothing on the run path reaches for
 * browser storage — verified by running a full plan, report and causal chain
 * with no localStorage defined at all.
 *
 * NOTHING MAY WRITE TO STDOUT. StdioServerTransport owns it for JSON-RPC;
 * a stray console.log corrupts the protocol mid-session. logger.js already
 * routes to stderr under Node for exactly this reason.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runPlanCached, getRun, specForHandle, planFromProfile, listProfiles, runMonteCarloFor } from './run-plan.js';
import { shareUrlFromPlan, SHARE_URL_SOFT_LIMIT } from '../share-link.js';
import { planFromReference } from './plan-reference.js';
import { diffSpecs, diffOutcomes, diffMarkdown } from './plan-diff.js';
import { explainIssue, explainAt, explainIssueMarkdown, explainAtMarkdown } from './explain.js';
import { generatePortfolioMarkdown, generateMonteCarloSectionMarkdown, REPORT_SECTIONS } from '../generators/finplan-ai.js';
import { planExhaustion } from '../portfolio-issues.js';
import { EventType } from '../sim-event.js';
import { buildPlan, planDefaults, PlanRefusal } from './build-plan.js';

// ── Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ChartingFinance-Local",
  version: "2.0.0",
});

const PROFILE_KEYS = listProfiles().map(p => p.key);

/** Wrap a handler so a thrown error becomes an MCP error result, not a crash. */
function guard(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}\n\n${err.stack}` }],
        isError: true,
      };
    }
  };
}

/**
 * Render findings as their own section.
 *
 * These lead rather than trail. An agent handed a net-worth table with no
 * mention that the plan stopped being able to pay its bills in 2049 will
 * summarise the table — the number it was given — and the omission becomes
 * advice. Exhaustion gets called out first for the same reason the UI panel
 * does it: it is the headline fact about the whole run.
 */
function issuesMarkdown(issues) {
  if (!issues.length) {
    return `# What Needs Attention\n\nNo issues detected. Every obligation in this plan was paid `
         + `from an eligible account, no contribution hit a limit, and every required `
         + `distribution was met.\n`;
  }

  const lines = ['# What Needs Attention', ''];

  const exhaustion = planExhaustion(issues);
  if (exhaustion) {
    lines.push(`> **${exhaustion.headline}**`, '>', `> ${exhaustion.detail}`, '');
  }

  const CATEGORY = {
    obligation:     'Paying for the plan',
    configuration:  'Needs setting up',
    reconciliation: 'Engine diagnostics',
  };

  for (const [key, label] of Object.entries(CATEGORY)) {
    const rows = issues.filter(i => i.category === key && i.id !== 'plan-exhaustion');
    if (!rows.length) continue;
    lines.push(`## ${label}`, '');
    lines.push('| Severity | Asset | Finding | Detail |', '| :--- | :--- | :--- | :--- |');
    for (const i of rows) {
      const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${cell(i.severity)} | ${cell(i.assetName ?? '—')} | ${cell(i.headline)} | ${cell(i.detail)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The report, headed by the handle.
 *
 * The handle is stated up front and in the imperative, because a tool result is
 * the only place the client learns that follow-up questions are possible at all.
 * Findings carry their own ids so `explain_issue` can be called without the
 * agent having to guess one.
 *
 * The granularity line is here for the same reason. The report body is annual
 * and lifetime totals; the run also holds a package for every month and an
 * event log finer than that, and nothing in a table of yearly rows says so. An
 * annual row reads as though the year were uniform, so a home sale or a single
 * large true-up becomes a question about a whole year instead of a question
 * about one month — which the caller can only ask if it knows the month exists.
 */
/**
 * The plan in one line: who it is about, and under what assumptions.
 *
 * The report has never said this anywhere, which is why the round-trip notes
 * had to read `setting-startAge` out of the DOM to find out what the app was
 * simulating. Ages are the single most common way a plan turns out to be about
 * a person the user is not, and they cost one line to state.
 */
function planLine(portfolio) {
  const c = portfolio?.config;
  if (!c) return null;
  return `${c.filingAs} · ages ${c.startAge} → retires ${c.retirementAge} → ends ${c.finishAge} · `
       + `inflation ${(c.inflationRate * 100).toFixed(1)}%`;
}

function reportFor(handle, portfolio, issues, mcResults = null, sections = null) {
  const ids = [...new Set(issues.map(i => i.id))];
  const hasReports = !sections || [].concat(sections).includes('reports');
  const followUp = [
    `**Run handle:** \`${handle}\``,
    planLine(portfolio) ? `**Plan:** ${planLine(portfolio)}` : '',
    '',
    ids.length
      ? `Ask why any of these happened with \`explain_issue\` — finding ids in this run: `
        + ids.map(i => `\`${i}\``).join(', ') + '.'
      : `Nothing needs attention in this run.`,
    '',
    hasReports
      ? `Figures below are annual and lifetime totals. The simulation is monthly, and `
        + `every charge is recorded in the month it happened — so for anything finer, `
        + `or for a year whose total looks unusual, call \`explain_month\` with that `
        + `month (\`YYYY-MM\`), or with an \`eventType\` to scan the whole plan.`
      : `This is a partial report. Ask for more with \`sections\` against this same handle, `
        + `or call \`explain_month\` for what a single month did.`,
    '',
    '---',
    '',
  ].join('\n');

  // Monte Carlo is appended only when it was asked for. It is stochastic, so it
  // is not part of the deterministic report body — see runMonteCarloFor.
  const mc = mcResults
    ? `\n\n---\n\n${generateMonteCarloSectionMarkdown(portfolio, mcResults)}`
    : '';

  // What Needs Attention is NOT selectable. A caller asking for one section is
  // asking to read less, not to be told less about whether the plan can pay its
  // bills — and an unpayable obligation outranks any headline number, including
  // the one they came for.
  const body = generatePortfolioMarkdown(portfolio, sections ? { sections } : {});
  return `${followUp}${issuesMarkdown(issues)}\n\n---\n\n${body}${mc}`;
}

// ── list_profiles ─────────────────────────────────────────────────

server.tool(
  "list_profiles",
  "Lists the built-in Quick Start portfolio profiles that quick_start_report can simulate, "
  + "with each profile's key, filing status and default ages. Call this first when you do not "
  + "already know which profile key to use.",
  {},
  guard(async () => ({
    content: [{ type: "text", text: JSON.stringify(listProfiles(), null, 2) }],
  }))
);

// ── quick_start_report ────────────────────────────────────────────

server.tool(
  "quick_start_report",
  "Runs a built-in Quick Start portfolio through the full financial simulation and returns a "
  + "Markdown report: plan issues, net worth trajectory, annual cash flow, lifetime tax "
  + "breakdown, and per-asset summary. The ages genuinely reshape the plan — every asset date "
  + "and life-event trigger is derived from them.",
  {
    profile: z.enum(PROFILE_KEYS).default('midCareer')
        .describe(`Which Quick Start profile to simulate. One of: ${PROFILE_KEYS.join(', ')}. `
                + `Filing status comes from the profile itself.`),
    startAge: z.number().int().min(20).max(90).optional()
        .describe("Override the profile's start age. Shifts every asset date and phase boundary."),
    retirementAge: z.number().int().min(30).max(95).optional()
        .describe("Override the profile's retirement age. Moves the Accumulate/Retire transition."),
    finishAge: z.number().int().min(40).max(110).optional()
        .describe("Override the profile's finish age. Sets where the simulation ends."),
    inflationRate: z.number().min(0).max(0.15).optional()
        .describe("Annual inflation as a decimal (e.g. 0.031 for 3.1%). Defaults to 3.1%."),
    includeReconciliation: z.boolean().default(false)
        .describe("Include engine-diagnostic findings (bookkeeping that does not reconcile). "
                + "These are notes about the engine, not about the finances."),
    monteCarlo: z.number().int().min(100).max(5000).optional()
        .describe("Number of Monte Carlo simulations to run. Omit for none. Adds a percentile "
                + "table to the report. Sampling is random and unseeded, so these figures "
                + "change between calls while the rest of the report does not."),
    sections: z.array(z.enum(REPORT_SECTIONS)).optional()
        .describe("Which parts of the report to return. Omit for all of it. The full report runs "
                + "to several thousand tokens; ['portfolio'] is the headline — net worth, assets "
                + "and transfers — and the rest can be pulled later against the same handle. "
                + "What Needs Attention and the plan's ages are always included."),
  },
  guard(async ({ profile, startAge, retirementAge, finishAge, inflationRate, includeReconciliation, monteCarlo, sections }) => {
    const spec = planFromProfile(profile, { startAge, retirementAge, finishAge });
    if (inflationRate != null) spec.settings.inflationRate = inflationRate;

    const { handle, portfolio, issues } = await runPlanCached(spec, { includeReconciliation });
    const mc = monteCarlo ? await runMonteCarloFor(spec, { numSimulations: monteCarlo }) : null;
    return { content: [{ type: "text", text: reportFor(handle, portfolio, issues, mc, sections) }] };
  })
);

// ── run_plan ──────────────────────────────────────────────────────

server.tool(
  "run_plan",
  "Runs a caller-supplied portfolio through the full simulation and returns the same Markdown "
  + "report as quick_start_report. The plan format is exactly what the Charting Finance app's "
  + "Share link encodes, so a portfolio exported from the app can be passed straight in — as a "
  + "`plan` object, or via `shareUrl` for a link, payload or run handle the user already has. "
  + "That is the return leg of share_link: hand someone a plan, let them edit it in the browser, "
  + "and read back exactly what they are looking at.",
  {
    plan: z.object({
      name: z.string().optional(),
      settings: z.object({
        inflationRate: z.number().min(0).max(0.15).optional(),
        filingAs: z.enum(['Single', 'MFJ']).optional()
            .describe("Selects the tax tables, contribution limits and home-sale exclusion."),
        startAge: z.number().int().optional(),
        retirementAge: z.number().int().optional(),
        finishAge: z.number().int().optional(),
      }).optional(),
      // z.record needs BOTH a key and a value type on zod 4 — the one-argument
      // form throws while building the JSON schema, which surfaces as a
      // tools/list failure rather than an error here.
      modelAssets: z.array(z.record(z.string(), z.any()))
          .describe("Assets in the app's serialized form (ModelAsset.toJSON())."),
      lifeEvents: z.array(z.record(z.string(), z.any())).optional()
          .describe("Life events (ModelLifeEvent.toJSON()). Omitting these means no phase ever "
                  + "transitions: salary never closes and retirement transfers never activate."),
    }).describe("A plan in the app's share format. Give this OR shareUrl, not both.").optional(),
    shareUrl: z.string().optional()
        .describe("A plan someone already has, in any of the three shapes it comes in: a share "
                + "link from the app or from share_link (the payload is after the '#'), the bare "
                + "compressed payload on its own, or a run handle like 'plan_688bcae498'. Use "
                + "this to read back a plan the user edited in the browser. A handle only "
                + "resolves while this server is running; a link always works."),
    includeReconciliation: z.boolean().default(false),
    monteCarlo: z.number().int().min(100).max(5000).optional()
        .describe("Number of Monte Carlo simulations to run. Omit for none. Sampling is random "
                + "and unseeded, so these figures change between calls."),
    sections: z.array(z.enum(REPORT_SECTIONS)).optional()
        .describe("Which parts of the report to return. Omit for all of it. The full report runs "
                + "to several thousand tokens; ['portfolio'] is the headline — net worth, assets "
                + "and transfers — and the rest can be pulled later against the same handle. "
                + "What Needs Attention and the plan's ages are always included."),
  },
  guard(async ({ plan, shareUrl, includeReconciliation, monteCarlo, sections }) => {
    // Exactly one. Silently preferring one over the other is how a caller ends
    // up reading a report about the plan it did not pass — the same class of
    // divergence the round-trip exists to close.
    if (plan && shareUrl) {
      throw new Error('Pass a plan or a shareUrl, not both — they may describe different plans.');
    }
    if (!plan && !shareUrl) {
      throw new Error('run_plan needs a plan: pass `plan` for a portfolio you have built, or '
                    + '`shareUrl` for a share link, payload or run handle.');
    }

    const spec = plan ?? planFromReference(shareUrl);
    const { handle, portfolio, issues } = await runPlanCached(spec, { includeReconciliation });
    const mc = monteCarlo ? await runMonteCarloFor(spec, { numSimulations: monteCarlo }) : null;
    return { content: [{ type: "text", text: reportFor(handle, portfolio, issues, mc, sections) }] };
  })
);

// ── explain_issue ─────────────────────────────────────────────────

server.tool(
  "explain_issue",
  "Answers WHY a finding from a plan's report happened, as a causal chain: the sequence of "
  + "engine operations that produced it, plus everything else that happened in the same step. "
  + "Requires a run handle from quick_start_report or run_plan.",
  {
    handle: z.string().describe('Run handle from a report, e.g. plan_3f9c1a2b04. Stable: the '
        + 'same plan always yields the same handle, and an older one still works — '
        + 'the server re-runs it if needed.'),
    issueId: z.string()
        .describe("Finding id, e.g. 'plan-exhaustion', 'unfunded-obligation', 'funding-ran-dry', "
                + "'contribution-capped'. The report lists the ids present in that run."),
    assetName: z.string().optional()
        .describe("Disambiguates when several assets carry the same finding."),
    limit: z.number().int().min(1).max(20).default(3)
        .describe("How many occurrences to explain, earliest first."),
  },
  guard(async ({ handle, issueId, assetName, limit }) => {
    const result = explainIssue(await getRun(handle), issueId, { assetName, limit });
    return { content: [{ type: "text", text: explainIssueMarkdown(result) }] };
  })
);

// ── explain_month ─────────────────────────────────────────────────

server.tool(
  "explain_month",
  "Shows what the engine did at a point in a plan, with the causal chain behind each event. "
  + "Use this to investigate a month that looks surprising in the projection table. "
  + "Requires a run handle from quick_start_report or run_plan.",
  {
    handle: z.string().describe('Run handle from a report, e.g. plan_3f9c1a2b04.'),
    date: z.string().optional()
        .describe("Month to inspect as 'YYYY-MM', e.g. '2051-11'. Omit to search the whole plan "
                + "(pair with assetName or eventType so the result stays useful)."),
    assetName: z.string().optional()
        .describe("Restrict to one asset, by its display name."),
    eventType: z.enum(Object.values(EventType)).optional()
        .describe("Restrict to one kind of engine event."),
    limit: z.number().int().min(1).max(50).default(10),
  },
  guard(async ({ handle, date, assetName, eventType, limit }) => {
    const result = explainAt(await getRun(handle), { date, assetName, eventType, limit });
    return { content: [{ type: "text", text: explainAtMarkdown(result) }] };
  })
);


// ── share_link ────────────────────────────────────────────────────
//
// The one tool here whose output leaves the machine, and only if someone clicks
// it. Everything else in this server answers in the transcript; this hands back
// a URL that carries the whole plan.
//
// It is built on the FRAGMENT (`#portfolio=`), which browsers do not transmit,
// so opening it does not send the portfolio to charting.finance's server — see
// share-link.js. The page reads the fragment locally and shows an import prompt
// before touching anything the user has saved. Both halves of that matter, and
// both are stated in the result, because "share" is a word that usually means
// upload and here it does not.
//
// specForHandle, not getRun: a link is a function of the plan, so asking for one
// must not cost a simulation.

server.tool(
  "share_link",
  "Turns a run into a link that opens the same plan in the Charting Finance web app for full "
  + "interactive visualization — charts, timeline, projections. The plan is encoded in the URL "
  + "fragment, which browsers never send to the server, so opening the link does not upload the "
  + "portfolio anywhere; the page reads it locally and asks before importing. Give the link to "
  + "the user and let them open it. Requires a run handle from quick_start_report or run_plan.",
  {
    handle: z.string().describe('Run handle from a report, e.g. plan_3f9c1a2b04.'),
    name: z.string().optional()
        .describe("Name the shared portfolio arrives under. Defaults to the plan's own name."),
    origin: z.string().optional()
        .describe('Where the link points. Defaults to https://charting.finance/ — override only '
                + 'to target a local dev server.'),
  },
  guard(async ({ handle, name, origin }) => {
    // The handle rides along so the app can say which run the plan on screen
    // came from — see share-link.js. It is provenance; the spec is unchanged.
    const link = shareUrlFromPlan(specForHandle(handle), { name, origin, handle });

    const lines = [
      `**Open this plan in Charting Finance:**`,
      '',
      link.url,
      '',
      `${link.assetCount} asset(s), as "${link.name}". Opening it uploads nothing — the plan `
      + `travels in the URL fragment, which the browser keeps to itself. On arrival the site `
      + `prompts with **Open** (view it, saved scenarios untouched) and **Open & Save** (keep `
      + `it); nothing already there changes until one is chosen.`,
    ];
    if (link.oversize) {
      lines.push('', `⚠️ This link is ${link.length.toLocaleString()} characters, past the `
        + `${SHARE_URL_SOFT_LIMIT.toLocaleString()} where mail clients and address bars start `
        + `truncating. It will work if it arrives intact; sending it as a file is safer.`);
    }
    return { content: [{ type: "text", text: lines.join('\n') }] };
  })
);

// ── diff_plans ────────────────────────────────────────────────────
//
// The question that follows the round trip. Both bugs in the notes that
// prompted this work were two documents disagreeing about the same plan, with
// nothing putting the two numbers side by side — a fifteen-year age gap went
// unseen across two reports that each looked fine.

server.tool(
  "diff_plans",
  "Compares two plans and what the engine did with them: settings, assets, life events, then "
  + "ending net worth, lifetime tax and findings. Takes anything run_plan's shareUrl takes — a "
  + "run handle, a share link, or a share payload — so it works on a plan the user edited in "
  + "the browser against the one you started from. Use it after a share link comes back, or to "
  + "answer 'what would change if…' with two runs instead of two reports.",
  {
    a: z.string().describe("The baseline: a run handle, share link, or share payload."),
    b: z.string().describe("What to compare against it, in any of the same three shapes."),
    includeReconciliation: z.boolean().default(false)
        .describe("Count engine-diagnostic findings too. Notes about the engine, not the finances."),
  },
  guard(async ({ a, b, includeReconciliation }) => {
    const specA = planFromReference(a);
    const specB = planFromReference(b);

    const runA = await runPlanCached(specA, { includeReconciliation });
    const runB = await runPlanCached(specB, { includeReconciliation });

    const md = diffMarkdown({
      handleA: runA.handle,
      handleB: runB.handle,
      spec: diffSpecs(specA, specB),
      outcome: diffOutcomes(runA, runB),
    });
    return { content: [{ type: "text", text: md }] };
  })
);

// ── plan_defaults ─────────────────────────────────────────────────
//
// Spec 10 step 1 (§7). The smallest addition in the spec and the
// highest-leverage one: it turns the largest class of silent wrongness — a plan
// about a person the user is not — into a visible sentence. Call it ONCE per
// conversation, not once per plan.

server.tool(
  "plan_defaults",
  "The assumptions a new plan starts from — age, retirement age, horizon, inflation and filing "
  + "status — with a plain-language gloss for each. Call this ONCE at the start of a planning "
  + "conversation and state them back to the user before building anything, because a plan "
  + "built on unstated defaults is a plan about someone else. Not needed for quick_start_report.",
  {},
  guard(async () => ({
    content: [{ type: "text", text: JSON.stringify(planDefaults(), null, 2) }],
  }))
);

// ── build_plan ────────────────────────────────────────────────────
//
// Spec 10 step 2. The compiler in front of runPlan. It returns a SPEC and runs
// nothing (§14 q1, decided 2026-08-31) — pass the spec to run_plan to get a
// handle. Its most valuable output is a refusal.

const buildPlanShape = {
  horizonYears: z.number().int().min(1).max(80).optional()
      .describe("How many years to project, e.g. 10. Derives finishAge from startAge. "
              + "Mutually exclusive with settingsOverrides.finishAge."),
  name: z.string().optional(),
  income: z.array(z.object({
    label: z.string().describe("What to call it, e.g. 'Salary'."),
    annual: z.number().optional().describe("Gross annual amount. Give this OR monthly."),
    monthly: z.number().optional(),
    kind: z.enum(['working', 'pension', 'socialSecurity']).optional().default('working'),
    growthRate: z.number().optional().describe("Annual raise rate as a decimal, e.g. 0.025."),
  })).min(1).describe("Income sources. At least one is required."),
  accounts: z.array(z.object({
    label: z.string().describe("What to call it. The wording is read for the account type: "
        + "'brokerage', 'savings', '401k', 'IRA', 'Roth' all resolve."),
    kind: z.string().optional().describe("Explicit instrument key, when the label does not say."),
    startingBalance: z.number().optional(),
    growthRate: z.number().optional(),
  })).optional(),
  savingsSplit: z.array(z.object({
    from: z.string().describe("An income label."),
    to: z.string().describe("An account label."),
    percent: z.number().describe("Share OF THAT INCOME, not of the other splits. "
        + "5 to one account and 5 to another is 10% saved, not 10% each."),
  })).optional(),
  expenses: z.array(z.object({
    label: z.string(),
    monthly: z.number().optional(),
    annual: z.number().optional(),
  })).optional(),
  settingsOverrides: z.object({
    startAge: z.number().int().optional(),
    retirementAge: z.number().int().optional(),
    finishAge: z.number().int().optional(),
    inflationRate: z.number().optional(),
    filingAs: z.enum(['Single', 'MFJ']).optional(),
  }).optional().describe("Anything the user stated. Whatever is omitted comes from "
      + "plan_defaults and is reported as a default in the ledger."),
};

server.tool(
  "build_plan",
  "Turns a described situation into a plan spec that run_plan can simulate — you supply meaning "
  + "(income, accounts, what share is saved) and this supplies instruments, dates, rates and "
  + "phases. It RUNS NOTHING: pass the returned spec to run_plan for numbers. "
  + "It refuses or asks a question when the description does not determine a plan, and that "
  + "refusal is the point — relay the question rather than guessing past it. "
  + "Every value it supplied is listed in the ledger with where it came from; state the "
  + "structural additions and the assumptions to the user when you show the plan.",
  buildPlanShape,
  guard(async (intent) => {
    try {
      const { spec, ledger, notes, horizon } = buildPlan(intent);
      return { content: [{ type: "text", text: JSON.stringify(
        { spec, ledger, notes, horizon,
          nextStep: 'Pass `spec` to run_plan to simulate it.' }, null, 2) }] };
    } catch (err) {
      if (!(err instanceof PlanRefusal)) throw err;
      // NOT an error result. A question is this tool working, not failing, and
      // flagging it isError invites the caller to retry with a guess.
      return { content: [{ type: "text", text: JSON.stringify({
        refused: err.reason,
        question: err.question,
        options: err.options,
        field: err.field,
        guidance: 'Ask the user this question. Do not pick a value on their behalf.',
      }, null, 2) }] };
    }
  })
);

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
