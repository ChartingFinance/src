// mcp-client.js - MCP Server stub for external AI agent integration
import { ModelAsset } from './model-asset.js';
import { Currency } from './currency.js';
import { DateInt } from './date-int.js';
import { ARR } from './arr.js';
import { Instrument } from './instrument.js';
import { membrane_rawDataToModelAssets } from './membrane.js';
import { Portfolio } from './portfolio.js';
import { chronometer_run } from './chronometer.js';

const VALID_INSTRUMENTS = new Set(Object.values(Instrument));

// ── Tool Registry ────────────────────────────────────────────────────

const tools = new Map();

tools.set('add_asset', {
  description: 'Add a new financial asset to the portfolio',
  inputSchema: {
    type: 'object',
    properties: {
      instrument:      { type: 'string', enum: Object.values(Instrument), description: 'Asset type' },
      displayName:     { type: 'string', description: 'User-friendly name' },
      startDate:       { type: 'string', description: 'Start date in YYYY-MM format' },
      startValue:      { type: 'number', description: 'Starting dollar value' },
      finishDate:      { type: 'string', description: 'End date in YYYY-MM format' },
      annualReturnRate:{ type: 'number', description: 'Annual return as percentage, e.g. 7 for 7%' },
      basisValue:      { type: 'number', description: 'Cost basis (optional, defaults to 0)' },
      isSelfEmployed:  { type: 'boolean', description: 'Self-employed income flag (optional)' },
    },
    required: ['instrument', 'displayName', 'startDate', 'startValue', 'finishDate', 'annualReturnRate'],
  },
  handler(args) {
    if (!VALID_INSTRUMENTS.has(args.instrument)) {
      throw new Error(`Invalid instrument: "${args.instrument}". Must be one of: ${[...VALID_INSTRUMENTS].join(', ')}`);
    }

    const modelAsset = new ModelAsset({
      instrument:      args.instrument,
      displayName:     args.displayName,
      startDateInt:    DateInt.parse(args.startDate),
      startCurrency:   new Currency(args.startValue),
      basisCurrency:   new Currency(args.basisValue ?? 0),
      finishDateInt:   DateInt.parse(args.finishDate),
      annualReturnRate:new ARR(args.annualReturnRate / 100),
      isSelfEmployed:  args.isSelfEmployed ?? false,
    });

    return {
      modelAsset,
      summary: `Created ${args.instrument} "${args.displayName}" from ${args.startDate} to ${args.finishDate} with $${args.startValue} at ${args.annualReturnRate}%`,
    };
  },
});

tools.set('export_report', {
  description: 'Run the simulation and return a portfolio summary report',
  inputSchema: {
    type: 'object',
    properties: {
      assets: { type: 'array', description: 'Array of raw asset objects (as from JSON)' },
    },
    required: ['assets'],
  },
  async handler(args) {
    const modelAssets = membrane_rawDataToModelAssets(args.assets);
    const portfolio = new Portfolio(modelAssets, false);
    await chronometer_run(portfolio);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        startValue:       portfolio.startValue().toString(),
        finishValue:      portfolio.finishValue().toString(),
        accumulatedValue: portfolio.accumulatedValue().toString(),
        totalMonths:      portfolio.totalMonths,
      },
      assets: modelAssets.map(asset => ({
        displayName: asset.displayName,
        instrument:  asset.instrument,
        startValue:  asset.startCurrency.toString(),
        finishValue: asset.finishCurrency.toString(),
        accumulated: asset.cashFlowAccumulatedCurrency.toString(),
      })),
    };
  },
});

// ── MCP Server Stub ──────────────────────────────────────────────────

export class MCPServer {
  listTools() {
    const result = [];
    for (const [name, tool] of tools) {
      result.push({ name, description: tool.description, inputSchema: tool.inputSchema });
    }
    return result;
  }

  async handleRequest(request) {
    const { method, params } = request;

    if (method === 'tools/list') {
      return { tools: this.listTools() };
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const tool = tools.get(name);
      if (!tool) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: "${name}"` }] };
      }

      try {
        const result = await tool.handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }

    return { isError: true, content: [{ type: 'text', text: `Unknown method: "${method}"` }] };
  }
}

// Global instance
export const mcpServer = new MCPServer();


/*

How to test

import { mcpServer } from './js/mcp-client.js';

// List available tools
await mcpServer.handleRequest({ method: 'tools/list', params: {} });

// Add an asset
await mcpServer.handleRequest({ method: 'tools/call', params: {
  name: 'add_asset',
  arguments: {
    instrument: 'taxableEquity',
    displayName: 'Test Portfolio',
    startDate: '2025-01',
    startValue: 10000,
    finishDate: '2035-01',
    annualReturnRate: 7
  }
}});

*/