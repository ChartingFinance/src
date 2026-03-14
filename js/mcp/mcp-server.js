#!/usr/bin/env node
/**
 * mcp-server.js — MCP server for Claude Desktop integration
 *
 * Exposes the financial simulation engine as tools that AI clients
 * can invoke over the Model Context Protocol (stdio transport).
 *
 * Usage:  node js/mcp/mcp-server.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Minimal localStorage polyfill for Node.js (globals.js setters/getters use it)
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// Simulation engine
import { quickStartAssets } from '../quick-start.js';
import { Portfolio } from '../portfolio.js';
import { chronometer_run } from '../chronometer.js';
import { setActiveTaxTable, global_setInflationRate, global_getInflationRate,
         global_setUserStartAge, global_getUserStartAge,
         global_setUserRetirementAge, global_getUserRetirementAge,
         global_setUserFinishAge, global_getUserFinishAge } from '../globals.js';
import { TaxTable } from '../taxes.js';
import { generatePortfolioMarkdown } from '../generators/assets-ai.js';

// ── Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ChartingFinance-Local",
  version: "1.0.0",
});

// ── Quick Start Tool ──────────────────────────────────────────────

server.tool(
  "quick_start_report",
  "Loads the Quick Start example portfolio (salary, 401K, Roth IRA, brokerage, home, mortgage, living expenses), runs the full financial simulation, and returns a comprehensive AI-consumable Markdown report including net worth trajectory, annual cash flow, tax breakdown, and fund transfer topology.",
  {
    inflationRate: z.number().min(0).max(0.15).default(0.031)
        .describe("Annual inflation rate as a decimal (e.g. 0.031 for 3.1%)"),
    startAge: z.number().int().min(20).max(80).default(57)
        .describe("User's current age at simulation start"),
    retirementAge: z.number().int().min(30).max(90).default(67)
        .describe("Target retirement age"),
    finishAge: z.number().int().min(40).max(100).default(85)
        .describe("Age at end of simulation"),
  },
  async ({ inflationRate, startAge, retirementAge, finishAge }) => {
    try {
      // Apply user-provided globals
      global_setInflationRate(inflationRate);
      global_getInflationRate();
      global_setUserStartAge(startAge);
      global_getUserStartAge();
      global_setUserRetirementAge(retirementAge);
      global_getUserRetirementAge();
      global_setUserFinishAge(finishAge);
      global_getUserFinishAge();
      setActiveTaxTable(new TaxTable());

      // Build portfolio from Quick Start data and run simulation
      const assets = quickStartAssets();
      const portfolio = new Portfolio(assets, false);
      await chronometer_run(portfolio);

      // Generate the AI-consumable markdown report
      const markdown = generatePortfolioMarkdown(portfolio);

      return {
        content: [{ type: "text", text: markdown }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error running simulation: ${err.message}\n\n${err.stack}` }],
        isError: true,
      };
    }
  }
);

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
