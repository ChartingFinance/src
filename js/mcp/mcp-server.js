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

import { runPlanCached, getRun, planFromProfile, listProfiles } from './run-plan.js';
import { explainIssue, explainAt, explainIssueMarkdown, explainAtMarkdown } from './explain.js';
import { generatePortfolioMarkdown } from '../generators/finplan-ai.js';
import { planExhaustion } from '../portfolio-issues.js';
import { EventType } from '../sim-event.js';

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
 */
function reportFor(handle, portfolio, issues) {
  const ids = [...new Set(issues.map(i => i.id))];
  const followUp = [
    `**Run handle:** \`${handle}\``,
    '',
    ids.length
      ? `Ask why any of these happened with \`explain_issue\` — finding ids in this run: `
        + ids.map(i => `\`${i}\``).join(', ') + '.'
      : `Nothing needs attention in this run. Use \`explain_month\` to look at any month anyway.`,
    '',
    '---',
    '',
  ].join('\n');

  return `${followUp}${issuesMarkdown(issues)}\n\n---\n\n${generatePortfolioMarkdown(portfolio)}`;
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
  },
  guard(async ({ profile, startAge, retirementAge, finishAge, inflationRate, includeReconciliation }) => {
    const spec = planFromProfile(profile, { startAge, retirementAge, finishAge });
    if (inflationRate != null) spec.settings.inflationRate = inflationRate;

    const { handle, portfolio, issues } = await runPlanCached(spec, { includeReconciliation });
    return { content: [{ type: "text", text: reportFor(handle, portfolio, issues) }] };
  })
);

// ── run_plan ──────────────────────────────────────────────────────

server.tool(
  "run_plan",
  "Runs a caller-supplied portfolio through the full simulation and returns the same Markdown "
  + "report as quick_start_report. The plan format is exactly what the Charting Finance app's "
  + "Share link encodes, so a portfolio exported from the app can be passed straight in.",
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
    }).describe("A plan in the app's share format."),
    includeReconciliation: z.boolean().default(false),
  },
  guard(async ({ plan, includeReconciliation }) => {
    const { handle, portfolio, issues } = await runPlanCached(plan, { includeReconciliation });
    return { content: [{ type: "text", text: reportFor(handle, portfolio, issues) }] };
  })
);

// ── explain_issue ─────────────────────────────────────────────────

server.tool(
  "explain_issue",
  "Answers WHY a finding from a plan's report happened, as a causal chain: the sequence of "
  + "engine operations that produced it, plus everything else that happened in the same step. "
  + "Requires a run handle from quick_start_report or run_plan.",
  {
    handle: z.string().describe("Run handle, e.g. 'plan_1', from a report."),
    issueId: z.string()
        .describe("Finding id, e.g. 'plan-exhaustion', 'unfunded-obligation', 'funding-ran-dry', "
                + "'contribution-capped'. The report lists the ids present in that run."),
    assetName: z.string().optional()
        .describe("Disambiguates when several assets carry the same finding."),
    limit: z.number().int().min(1).max(20).default(3)
        .describe("How many occurrences to explain, earliest first."),
  },
  guard(async ({ handle, issueId, assetName, limit }) => {
    const result = explainIssue(getRun(handle), issueId, { assetName, limit });
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
    handle: z.string().describe("Run handle, e.g. 'plan_1', from a report."),
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
    const result = explainAt(getRun(handle), { date, assetName, eventType, limit });
    return { content: [{ type: "text", text: explainAtMarkdown(result) }] };
  })
);

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
