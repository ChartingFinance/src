# Charting Finance — Claude Code plugin

A month-by-month personal finance simulation over decades, as a local Claude Code
plugin. Eight built-in profiles or your own portfolio; federal income tax, FICA,
capital gains, RMDs and NIIT; optional Monte Carlo.

**Everything runs on your machine.** The plugin starts a local MCP server over
stdio. No portfolio data is sent anywhere, and the server makes no network calls.

## Not financial advice

This produces unproven hypotheses. Charting Finance is uncertified by any
recognized financial or fiduciary organization and should be treated as being for
entertainment purposes only. There are no guarantees, and nothing here is telling
you to do anything. For decisions of consequence, talk to a licensed advisor.

The bundled skill lists the model's known limits — optimistic monthly compounding,
no early-withdrawal penalty, flat 85% Social Security taxation, no state income
tax — and instructs Claude to disclose them alongside the numbers.

## Install

```
/plugin marketplace add ChartingFinance/src
/plugin install charting-finance@charting-finance
```

Requires **Node.js 20+** on your PATH. Nothing else — the server ships as a single
bundled file with no dependencies to install.

Claude Code does not provide a Node runtime to plugins, so this has to be your
own. If Node is present but older than 20, the server exits with a message
saying so. If Node is missing entirely the server cannot start at all, and
Claude Code reports nothing — the plugin will simply have no tools. Check with
`node --version` before assuming something else is wrong.

## What you get

| | |
| :--- | :--- |
| `/simulate` | run a profile or a described plan |
| `/explain` | ask why the engine produced a number, from recorded history |
| 7 MCP tools | `plan_defaults`, `build_plan`, `list_profiles`, `quick_start_report`, `run_plan`, `explain_month`, `explain_issue` |

Describe a situation in a sentence — *"I make $100K, if I save 10% what do I
have in 10 years?"* — and `build_plan` compiles it into a plan the engine can
run, or asks you the question that sentence left open. Portfolios built at
[charting.finance](https://charting.finance/) can be passed to `run_plan`
directly.

## Building from source

`server/mcp-server.mjs` is generated. From the repository root:

```
npm install
npm run build:plugin
```

The build verifies the engine is headless (`tests/layer-boundary.mjs`) before it
bundles, then boots the result and asks it for its tool list. A bundle that cannot
answer `tools/list` fails the build.

---

Charting Finance · Portfolio Simulator · © 2025-2026 Charting Finance, LLC
