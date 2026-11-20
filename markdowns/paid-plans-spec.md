# Spec 16 — Paid plans: a $10 pass, two tokens, and one rule for the app and MCP

Status: **DRAFT — Rev 2 (2026-11-19).** Spec only, no code. The open decisions are in §12; nothing is built until they are answered.

Charting Finance is free today, and everything it does runs in the browser. This spec adds a way to pay: **$10 a year buys a household pass**. A pass unlocks all of the user's scenarios, the deeper tools (the Test Bench, plan comparison and the paid MCP tools), and share links that carry paid access for anyone who opens them.

Five rules hold throughout:

- **No plan contents on the server.** The server knows hashed pass keys, share tokens and expiry dates, and nothing about the money in any plan. Plans stay in the browser and in share links, as today.
- **One rule everywhere.** A pass bought on `charting.finance` unlocks the same tools in the web app and in the MCP plugin. One exception is proposed, `diff_plans` (decision §12.13).
- **Gates never touch the engine.** Paid status decides which tools the page and the MCP layer offer. It never changes a simulated number.
- **Nothing held hostage.** An expired pass never locks out data. Every plan always opens, exports and shares as a snapshot; only the paid tools switch off.
- **Fail open.** If the status server cannot be reached, a user holding a token keeps the paid tools. An outage must never lock out someone who paid.

### Revision history

| Rev | Date | Summary of changes |
|---|---|---|
| Rev 0 | 2026-11-18 | Initial draft: a $10/yr pass of 10 manual plan slots (`planIds`), attach/detach UI, `GET /api/plan/{planId}` on every check, 3 s timeout, manual renewal. |
| Rev 1 | 2026-11-19 | Replaced the 10 slots with **two tokens (`passKey` + `shareToken`)**, removing attach/detach and cross-browser slot desync. Claim made idempotent against the redirect/webhook race. Restore moved to `POST`; O(1) table rows. Ed25519 signed offline tokens, 24 h background refresh, 6 s timeout. `CHARTING_FINANCE_PASS_KEY`, handle-cache upgrade, an `optimize_routing` MCP tool. Renewal contradiction resolved; merchant-of-record fee math. Engine-only layer-boundary check. Added §13 Measuring success. |
| **Rev 2** | **2026-11-19** | Review of Rev 1 against the code. **The claim needs a secret held by the buying browser**, answers once, within 30 minutes (§2.2): Rev 1 gave the pass key to anyone holding a transaction id, and `?claim=` reached Tag Manager before app code could remove it. **Ed25519 signatures dropped** for a plain cached status (§4.3). **Status lives in one row** (§4.1). **Share tokens can be replaced** (§3.5). **No tool takes the pass key** (§7.1). **Refusals tell the agent not to approximate** (§7.2). **No MCP telemetry**, and the §13 targets are marked as guesses. **`optimize_routing` moved to its own spec** (§7.2). New decisions: ten plans or all (§12.5), editing a shared paid plan (§12.6), `diff_plans` (§12.13), how the plugin gets its key (§12.16), analytics (§12.17). Facts corrected: Quick Starts are not scenarios (§1.2); a handle hashes the spec and its run options (§1.5); restore sends the pass key itself over HTTPS, not a hash (§7.3). |

---

## 1. What exists

### 1.1 No server

- The site is a static Vite build served by Azure Static Web Apps (`.github/workflows/azure-static-web-apps-happy-glacier-056a05c10.yml`: `api_location: ""`, `output_location: "dist"`). There are no accounts, no database and no API.
- The repo (`ChartingFinance/src`) is public, under the ISC license (`LICENSE`, Charting Finance, LLC). Anyone may copy, change and host it.
- Every gate in this spec therefore runs in code the user has. It is an honor system (§8): it sells convenience and support to people who want to pay, and does not try to stop people who do not.

### 1.2 A plan today is a scenario

`js/scenario-store.js` is the only scenario writer. A scenario is a set of `localStorage` keys under `util_buildStoryArcKey(storyArc, storyName)`:

| Key | Holds |
|---|---|
| `(base)` | the assets |
| `lifeEvents_<arc>_<name>` | the life events, phase rules included |
| `+guardrails` | guardrail parameters |
| `+settings` | the six settings in the settings row |
| `+format` | the plan format it was saved in (`PLAN_FORMAT`, PR #136) |
| `+meta`, `+preview` | the menu's title, note and preview curve |

- There is no limit on how many scenarios a user has. The scenario menu's footer adds one ("＋ New scenario", `finplan-app.js`).
- `addScenario(…, { copyFrom })` copies the assets, life events, guardrails, settings and format of the scenario named. It does not copy `+meta` or `+preview`.
- A shared plan opened with **Open** (not **Open & Save**) is on screen without being a scenario, and nothing is written while it is (`openUnsaved`).
- Quick Start profiles are not scenarios. Choosing one loads it into the scenario on screen (`loadQuickStartProfile`, `finplan-app.js`).

### 1.3 Share links carry the whole plan

- A link is `https://charting.finance/#portfolio=<LZ-compressed payload>` (`SHARE_PARAM = 'portfolio'`, `js/share-link.js`). The plan is after the `#`, so it never reaches a server. `tests/share-link.mjs` guards that property.
- The payload is the five plan keys (`SPEC_KEYS`: `name`, `settings`, `modelAssets`, `lifeEvents`, `guardrailParams`) plus `planFormat`, and a provenance `handle` when the MCP server made the link. `specFromPayload` strips everything that is not a plan key before the engine sees it.

### 1.4 The engine is headless

- `tests/layer-boundary.mjs` keeps the headless import closure free of browser globals (`document`, `window`, `localStorage`, …). Its `ENTRY_POINTS` list holds both the engine (`js/mcp/run-plan.js`, `js/chronometer.js`, `js/portfolio.js`) and the shipped plugin entry point (`js/mcp/mcp-server.js`).
- `fetch` and `node:crypto` are not on the banned list, and Node 20+ (the plugin's floor) has both, so status checks can live in `js/mcp/` without breaking the boundary.

### 1.5 The MCP plugin

- The plugin runs locally from a bundle built from this repo (`plugin/server/mcp-server.mjs`), and makes no network calls today (`plugin/README.md`).
- A run handle is a sha1 of the spec **and its run options** (`handleFor(spec, opts)`, `js/mcp/run-plan.js`). The same plan with the same options always gets the same handle. The registry (`SPECS`) keeps one entry per handle.
- Two tools already do what this spec makes paid in the app:
  - `max_spending` is the Test Bench's spending test;
  - `diff_plans` compares two plans.
- `run_plan` and `quick_start_report` also take `monteCarlo`. There is no guardrails tool; a spec only carries `guardrailParams`.
- The plugin's guidance (`plugin/skills/charting-finance/SKILL.md`) tells the agent to use `diff_plans` instead of comparing two reports itself, and `max_spending` for "how much can I spend". So a refusal from either changes what the agent does next (§7.2).

### 1.6 The features this spec gates

| Feature | Where it is |
|---|---|
| Test Bench (Spending + Routing) | `js/components/test-bench.js`, the page's `#sec-testbench` |
| Plan comparison | not built: primary and secondary plans, and choosing a plan to compare against, are a later spec (§11) |
| Number of scenarios | the scenario menu (beyond the free limit `F`, decision §12.1) |
| Paid MCP tools | `max_spending`, and `diff_plans` if decision §12.13 gates it (`js/mcp/mcp-server.js`) |
| Guardrails (decision §12.2) | the Simulations panel, and the third figure on the outcome strip (`js/components/outcome-strip.js`) |

### 1.7 Analytics

- `index.html` loads Google Tag Manager (`GTM-WRSW7SKN`) in the page head, before any app code runs. Anything in the page address when the page loads can reach analytics before the app can remove it.
- Its tags are set in Google's console, not in this repo. What it records, including the query string and the `#` fragment that carries a share link's plan, cannot be checked from here (decision §12.17).

---

## 2. The purchase

### 2.1 A pass

- **$10 a year** buys a household pass with one renewal date.
- One pass unlocks **all** of the user's scenarios, with nothing to attach or detach. The server never sees which plan a slot is on, so per-plan slots protected nothing; they added UI and fell out of step across browsers. Whether the pass covers all scenarios or ten is decision §12.5.
- **Economics:** a merchant of record (Paddle or Lemon Squeezy) typically charges **5% + $0.50** (plus minor PayPal and international fees), leaving roughly **$8.75–$9.00** per $10 sale.

### 2.2 Checkout

1. The user chooses **Get a pass**. The app makes a random 128-bit `claimSecret`, keeps it in `localStorage`, and opens the provider's hosted checkout with `sha256(claimSecret)` in the provider's custom checkout data.
2. The provider takes payment and sends a signed webhook to `POST /api/webhook`, which carries the custom data. If the provider issues license keys, it also issues the `passKey`, puts it on the receipt and keeps it in the buyer's portal (decision §12.12).
3. The provider sends the user back to `https://charting.finance/#claim=<transactionId>`.
4. The app calls `POST /api/claim` with `{ transactionId, claimSecret }`. The server:
   - finds the pass by `providerRef`. If the webhook has not arrived yet (redirects routinely arrive 1–10 seconds before it), it asks the provider's API and creates the pass record itself, idempotently on `providerRef`;
   - checks that `sha256(claimSecret)` matches the custom data;
   - answers once, and only within 30 minutes of purchase.

   The client retries briefly (1 s / 2 s / 4 s, showing "Confirming your pass…").
5. `/api/claim` returns `{ passKey, shareToken, status, renews, expiresAt }`. The app stores them in `cf_pass` (§3.2), deletes `claimSecret`, removes `#claim=` from the address, and offers a one-click copy or download of the `passKey`, plus the file the MCP plugin reads (§7.1).
6. On another browser, or when the claim cannot answer (checkout finished on another device, or more than 30 minutes later), the user enters the `passKey` from the receipt under **Restore pass** (`POST /api/pass/restore`).

**Why the secret.** A transaction id is not secret. It is on the receipt, and a provider may add it to the return address's query string, where Tag Manager sees it (§1.7). A claim that answered for a transaction id alone would give the pass key to anyone who saw one. The secret leaves the buying browser only as a hash, so a leaked transaction id is useless. The `#` keeps the id out of server logs as well.

### 2.3 The provider

A merchant-of-record provider sells on Charting Finance's behalf and handles sales tax, VAT, receipts and renewal emails (Lemon Squeezy and Paddle work this way). The provider holds the buyer's email and payment details; the Charting Finance server never sees either. What the provider must offer is in decision §12.12.

---

## 3. Tokens (beside the plan, never inside it)

### 3.1 Two tokens, two roles

| Token | Visibility | Issued by | Role |
|---|---|---|---|
| `passKey` | **Private**, at least 128 bits | the provider's license key, or the server (§12.12) | Proves ownership of the pass. Stored in `cf_pass` and, for MCP, where §7.1 says. **Never** in a share link, and never a tool argument. |
| `shareToken` | **Public-safe**, 128-bit random | the server, at pass creation | Identifies the pass for read-only status checks. Travels in share links made by a paid user, so viewers get the paid tools while viewing without seeing the `passKey`. Can be replaced (§3.5). |

Neither token is related to the deterministic in-plan asset and life-event ids of #132–#136 (`a1`, `e2`).

### 3.2 Where tokens live: beside the plan, never inside it

- **In the browser:** one top-level `localStorage` record, `cf_pass`, holding `{ passKey, shareToken, status, renews, expiresAt, checkedAt }`. Scenarios need **no** `+plan` key.
- **Share statuses** seen while viewing other people's links are cached apart from the user's own pass, in `cf_shares` (`shareToken → { status, expiresAt, checkedAt }`). They never enter `cf_pass` (§10, trap 4).
- **In a share link:** an optional `shareToken` field in the share payload, beside `SPEC_KEYS`, the same way `planFormat` travels. `specFromPayload` keeps stripping it from the spec.
- **In the MCP server:** the pass from §7.1, plus any `shareToken` carried on an incoming link, stored beside the spec in the handle registry (§7.1).

Why outside `SPEC_KEYS`: a run handle is a hash of the spec. Two copies of the same plan, one paid and one not, must get the same handle and the same numbers, and `diff_plans` must never report a token as a difference between two plans.

`shareToken` is an additive payload key: older code ignores it, so it needs no `PLAN_FORMAT` bump.

### 3.3 Copying and saving

- Entitlement belongs to the user's **pass**, not to a scenario, so copying a scenario or choosing "Save as a scenario" in the Test Bench works at once for a paid user, with no extra step.
- Unpaid users remain governed by the free scenario limit `F` (§6.4).

### 3.4 Sharing a paid plan

- A share link made while the user holds an active (or grace) pass carries `shareToken`. Anyone who opens it with **Open** (`openUnsaved`) gets the paid tools while viewing, as long as the pass stays active or in grace (decision §12.4).
- **Open & Save** drops `shareToken`. The saved copy is the viewer's own scenario, governed by the viewer's own pass, or unpaid if they have none.
- "Save as a scenario" from the Test Bench drops it the same way, and a share link made by a viewer without a pass of their own does not carry the sender's token.
- Edits made while viewing: decision §12.6. Recommended: the tools stay on until the viewer saves or makes a new share link.
- Renewing the pass extends every link already shared, with no re-sharing.

### 3.5 Replacing a share token

- Every link a pass holder makes carries the same `shareToken`. A link posted in public gives everyone who opens it the paid tools until the pass expires.
- **New share token**, in the pass panel, calls `POST /api/pass/share-token` with the `passKey` and receives a new token. The old token answers `unknown` from then on.
- Links already sent still open, as snapshots without the paid tools. New links carry the new token.

---

## 4. The server

### 4.1 What it stores

One row holds a pass's status; the others point at it. Every lookup is at most two point reads, a renewal or refund writes one row, and no two rows can disagree about a status.

| Row key | Fields | Purpose |
|---|---|---|
| `pass:<passId>` | `{ status, renews, expiresAt, shareToken, providerRef, claimHash, claimedAt, createdAt }` | the one place status and expiry live |
| `key:<sha256(passKey)>` | `{ passId }` | restore, without storing the plaintext `passKey` |
| `tok:<shareToken>` | `{ passId }` | status checks from share links |
| `ref:<providerRef>` | `{ passId }` | matching webhooks: renewals, refunds, chargebacks |

- `providerRef` is the provider's subscription id when passes renew automatically, or the order id otherwise, so that a renewal finds the pass it renews.
- `claimHash` is the custom checkout data of §2.2; `claimedAt` marks the claim used.
- `renews` is whether automatic renewal is on (§5.3), kept current from the provider's webhooks.
- The pass row is written first and the pointer rows after it. A creation that stops halfway leaves a pass nothing points to, which the next webhook or claim completes, idempotently on `providerRef`.
- Nothing else: no plan contents, no names or amounts, no emails.

### 4.2 Endpoints

| Endpoint | Does |
|---|---|
| `POST /api/webhook` | Provider-signed: purchase, renewal, cancellation of automatic renewal, refund, chargeback. Idempotent on `providerRef`. |
| `POST /api/claim` | `{ transactionId, claimSecret }` → `{ passKey, shareToken, status, renews, expiresAt }`, once, within 30 minutes of purchase, when the secret matches (§2.2). |
| `POST /api/pass/restore` | `{ passKey }` in the body, never in the address → `{ shareToken, status, renews, expiresAt }`. |
| `POST /api/pass/share-token` | `{ passKey }` → a new `shareToken`; the old one stops answering (§3.5). |
| `GET /api/token/{shareToken}` | → `{ status: paid \| grace \| expired \| unknown, expiresAt }`. Unknown, forged and replaced tokens answer `unknown`, treated as unpaid. |

- No endpoint logs request bodies or `Authorization` headers.
- The browser calls them on the same origin (`charting.finance/api/*`). The MCP plugin calls them from Node, where CORS does not apply.

### 4.3 The cached status

- The browser keeps the last answer in `cf_pass` (and `cf_shares`). The plugin keeps it in memory and beside its key file (§7.1).
- On load, the cached answer applies at once: no waiting, no flash of locked panels, and server cold starts never on the user's path.
- If `checkedAt` is older than 24 hours, the client refreshes in the background, which picks up renewals, refunds and chargebacks.
- With no `passKey` and no `shareToken`, no request is made.

**Why not signed.** Rev 1 proposed Ed25519-signed tokens. The gates are an honor system (§8): a signature would stop only someone editing `cf_pass` in the browser's developer tools, who could as easily change the code. It would cost a private signing key to protect, and a public key built into every plugin bundle. Changing that key would make every installed plugin reject new answers until it was updated, and installs do not follow `main` (§10, trap 8). If tampering ever matters, a signature can be added later as one more field, without changing the endpoints.

### 4.4 Where it runs

Two options (decision §12.14):

1. **Azure Static Web Apps managed functions + Azure Table Storage** (`api_location: "api"`). Same deploy, same domain, no CORS setup. Two operational details:
   - Consumption-plan Node.js cold starts take 2–5 seconds, so client timeouts are **6 seconds** (not 3). The cached status (§4.3) keeps cold starts off the user's path.
   - PR preview environments, made by `.github/workflows/azure-static-web-apps-happy-glacier-056a05c10.yml`, must **not** receive the production webhook secret or provider API key. Confirm in phase 3 how Static Web Apps scopes application settings to preview environments.
2. **Cloudflare Workers + KV/D1** at `api.charting.finance`: no cold starts, a generous free tier, and CORS headers needed for `charting.finance`.

### 4.5 Privacy

- A refresh or share-link check tells the server that a pass key or share token was checked, and from which IP address, at most once per 24 hours per client. The privacy note says so plainly.
- Unpaid users make no calls to these endpoints.
- Plan contents never leave the browser or the local MCP process: share links keep the plan after the `#`, and only a token is ever sent.

---

## 5. Lifespan

### 5.1 States

| State | When | Paid tools | What the user sees |
|---|---|---|---|
| `paid` | before `expiresAt` | on | reminders near the end (§5.3) |
| `grace` | `expiresAt` + 30 days (decision §12.10) | on | a banner: renew to keep the paid tools |
| `expired` | after grace | off | a banner; every plan opens, exports and shares as a snapshot |
| `unknown` | not a token the server issued, or one replaced | off | treated as unpaid |

### 5.2 Renewal

- Renewing adds a year to `expiresAt` in the pass row, which extends every scenario and every link already shared.
- Automatic or manual renewal is decision §12.7.

### 5.3 Reminders

`expiresAt` and `renews` are in the cached status, so reminders need no email list. Each shows once per threshold, as a dismissible banner, remembered in `localStorage`.

- **Manual renewal, or automatic renewal turned off:** banners at 90, 30, 7 and 1 days before `expiresAt`: "Your pass ends on {date}. Renew to keep the paid tools."
- **Automatic renewal on:** the provider sends the renewal notices (decision §12.8). The app shows "Your pass renews on {date} for $10" once, 30 days before.

### 5.4 Refunds and chargebacks

The webhook marks the pass `expired` at once (decision §12.11). Clients pick this up on their next 24-hour refresh.

### 5.5 Failing open

- Network checks time out after **6 seconds**.
- **No token** (no `passKey` and no `shareToken` on the plan on screen): unpaid at once, with no network call.
- **A token with a cached answer:** if the server cannot be reached, the cached answer holds until its `expiresAt` plus grace.
- **A token never checked** (the first open of a shared link): the tools show at once, and lock only if the server answers `unknown` or `expired`. If the server cannot be reached, they stay on for the session and the check is retried next time.
- So working offline with a cached answer just works, and an outage never locks out a paying customer.

---

## 6. The gates

### 6.1 One rule

A tool is on when **either** the user holds an active or grace `passKey`, **or** the plan on screen arrived through a link carrying an active or grace `shareToken`.

| Tool | Gated on |
|---|---|
| Test Bench (Spending + Routing) | an active pass, or an active shared link on screen |
| Plan comparison | an active pass, or an active shared link on screen; may compare against any saved scenario |
| More scenarios | beyond the free limit `F` (decision §12.1), creating a scenario needs an active pass |
| `max_spending` (MCP) | an active `passKey`, or an active `shareToken` on the plan |
| `diff_plans` (MCP) | decision §12.13; if gated, the pass or the first plan's `shareToken` |
| Guardrails | decision §12.2 |

Free, whatever the status: the deterministic projection, the timeline, Month & Year Details, "What needs attention", Monte Carlo (decision §12.3), exports, snapshot share links, and the core MCP tools (`plan_defaults`, `build_plan`, `list_profiles`, `quick_start_report`, `run_plan`, `explain_month`, `explain_issue`, `share_link`).

### 6.2 Where the gates live

- **The page:** `finplan-app.js` and the components that host each tool (`test-bench.js`, the scenario menu, and the Simulations panel / `outcome-strip.js` if Guardrails is gated).
- **The MCP layer:** the tool handlers in `js/mcp/mcp-server.js` (§7).
- **Never the engine.** Add a check to `tests/layer-boundary.mjs`, computed over the **engine entry points only** (`js/mcp/run-plan.js`, `js/chronometer.js`, `js/portfolio.js`, and not `js/mcp/mcp-server.js`, which does import the entitlement module): no file in the engine closure may import the entitlement module. Paid status can never alter a simulated number.

### 6.3 What a locked tool shows

The tool's panel stays where it is, explains what it answers (with an illustrative example of the Spending or Routing result), and offers **Get a pass ($10/yr)** with a quiet **Restore pass** link. Hiding the panel would mean nobody discovers it exists.

### 6.4 The free scenario limit

- An unpaid user may keep up to `F` saved scenarios (decision §12.1). Quick Starts do not count: they are not scenarios (§1.2).
- Beyond `F`, **"＋ New scenario"** offers a pass, or deleting an old scenario.
- Existing users already over `F`: decision §12.15.

---

## 7. MCP

### 7.1 The pass key and share tokens

1. **The pass key**, for paying users. The plugin reads it from, in order:
   - a plugin setting, if Claude Code plugins can ask for a secret at install and store it securely (to verify, decision §12.16);
   - `~/.charting-finance/pass.json`, the file the app's **Download for Claude** button writes (§2.2);
   - the `CHARTING_FINANCE_PASS_KEY` environment variable.

   It checks the key with `POST /api/pass/restore`, keeps the answer (§4.3), and unlocks every run in the session, including plans built on the spot with `build_plan` or passed inline to `run_plan`.

   **Never a tool argument.** Whatever a tool receives is in the conversation transcript. So there is no `activate_pass` tool, and no tool takes a pass key.
2. **A share token**, for viewers of a paid link. `planFromReference` (`js/mcp/plan-reference.js`) reads `shareToken` from the decoded payload **before** calling `specFromPayload`, and returns `{ spec, shareToken }`.
   - The handle registry (`SPECS`, `js/mcp/run-plan.js`) stores `{ spec, opts, shareToken }`.
   - **Upgrade rule:** a handle hashes `{ spec, opts }` alone, so a paid link and an unpaid copy of the same plan share one handle. A non-null `shareToken` replaces a null one for that handle; a call without a token never removes one.
3. **`share_link`** writes `shareToken` into the link whenever the pass or the handle carries one.
4. **No token:** gated tools refuse at once, with no network call.

### 7.2 The gated tools

- `max_spending`.
- `diff_plans`, only if decision §12.13 gates it.

Each checks before running, with the same cached status, 24-hour refresh, 6-second timeout and fail-open rule as the web app (§4.3, §5.5).

**What a refusal says.** An agent refused a tool does the next best thing, and for these tools the next best thing is worse. Refused `max_spending`, it can search for a spending level with repeated `run_plan` calls, which is not the Spending test and has no "what stops it". Refused `diff_plans`, it reads two reports side by side, which the plugin's own guidance warns against. So the refusal:

- says the figure is not available without a pass, and that an estimate from other tools would not be the same answer;
- names where to get a pass (`https://charting.finance/`) and how to give the plugin its key (§7.1);
- is an MCP error result, as the tools already return for invalid input.

**`optimize_routing`.** Rev 1 proposed exposing `js/routing-search.js` as an MCP tool. It belongs in its own spec: a routing search is many plan runs, and what the tool returns, and how a result becomes a handle, need their own answers. If built, it is gated by this spec's rule.

### 7.3 Disclosure

Update `plugin/README.md`, `plugin/.claude-plugin/plugin.json` and `plugin/skills/charting-finance/SKILL.md`. Replace the sentence "the server makes no network calls" with: free tools make no network calls; paid tools contact `charting.finance` at most once a day, sending the pass key (over HTTPS, in the request body) or a share token, and never portfolio contents. The plugin sends no analytics (§13).

Rev 1 said "only a hashed pass key". Restore sends the key itself, and the server hashes it.

---

## 8. Honest limits

- **An honor system.** The code is public, ISC-licensed and runs on the user's machine. Anyone determined can switch the gates off, edit `cf_pass`, host a fork, or share a `passKey`. The server cannot prevent that without holding data or running the tools itself.
- **A share token is copyable.** Anyone can attach a paid link's token to a plan of their own. Replacing the token (§3.5) is the remedy.
- **Offline stays unlocked until refresh or expiry.** A refunded pass can stay unlocked offline until its next refresh or `expiresAt`. That is the price of instant startup and of never locking out a paying user.
- **Lost browser data means lost plans.** Restoring a `passKey` restores paid access, not local scenarios. Paid users see a gentle reminder to keep a backup (an exported file or a share link).
- **IP addresses on refresh.** The server sees tokens and IP addresses on 24-hour refreshes and shared-link checks (§4.5).

---

## 9. Existing users

Everyone's plans today become unpaid plans. Existing users already over the free limit `F` keep every plan readable, editable and exportable; the limit applies only when adding a scenario (decision §12.15).

---

## 10. Traps this codebase has already hit

1. **Run handles hash the spec.** `shareToken` must never enter `SPEC_KEYS` (§3.2). Follow the `planFormat` pattern of PR #136.
2. **`specFromPayload` strips every non-plan key.** `planFromReference` must read `shareToken` before calling `specFromPayload`, and `readSharedPlan` (`js/shared-plan.js`) must return it beside `handle`.
3. **Handle-cache collision on identical plans.** A handle hashes `{ spec, opts }`, so an unpaid run and a paid link of the same plan share one handle; `runPlanCached` must upgrade `shareToken` rather than return a stale `null` (§7.1).
4. **An unsaved Open writes nothing.** Viewing a link with a `shareToken` must never touch the viewer's own `cf_pass`; share statuses go in `cf_shares`. Saving as a non-owner drops the sender's `shareToken` (§3.4).
5. **Layer-boundary closure split.** `tests/layer-boundary.mjs` puts `mcp-server.js` in the same `ENTRY_POINTS` list as `run-plan.js`. Keep the browser-globals check on all four, and run the new "no entitlement import" check on the engine entry points only (§6.2).
6. **A gate that is always open passes every "it runs" test.** Every gate needs tests in all directions: an active pass (on), a valid shared link (on), no token (off, **with zero `fetch` calls**), expired (off), and a token with the server unreachable (fail open).
7. **Browser checks share `localStorage` with real data.** Run them on an isolated origin (for example `http://refcheck.localhost:5173`).
8. **The plugin install does not follow `main`.** Every PR that changes `plugin/server/mcp-server.mjs` bumps `plugin/.claude-plugin/plugin.json`, rebuilds with `npm run build:plugin`, and checks the installed plugin separately.
9. **Tag Manager loads before app code.** Anything in the page address at load can reach analytics before the app removes it. No secret ever goes in the address; the claim's transaction id is harmless on its own (§2.2).
10. **A refused tool invites a workaround.** Test what the refusal says, not only that it refuses (§7.2).

---

## 11. Phases and cost

1. **Decisions (§12).**
2. **Entitlement module and gates with a local stub.** `cf_pass` and `cf_shares`, the cached status, `shareToken` in share links (`share-link.js`, `shared-plan.js`), locked panels, the free limit `F`, and the layer-boundary and gate tests. All testable with no server and no payments.
3. **Server and payments in the provider's test mode.** Functions (or a Worker), the four row kinds, `POST /api/webhook`, `POST /api/claim` (secret, once, 30 minutes), `POST /api/pass/restore`, `POST /api/pass/share-token`, `GET /api/token/{shareToken}`, and keeping secrets out of preview environments.
4. **MCP.** The key from a plugin setting, file or environment variable, the app's **Download for Claude** button, `shareToken` extraction and the handle-cache upgrade, gating, the refusal text, and the `plugin/README.md` and `SKILL.md` updates.
5. **Reminders, instrumentation and polish.** The reminder banners (§5.3), the grace banner, backup prompts, the privacy note, and the web events of §13 if decision §12.17 keeps them.

Plan comparison is gated in this spec but built in its own spec, as is `optimize_routing`.

---

## 12. Open decisions

Each has a recommendation; John decides.

1. **The free scenario limit (`F`).** Recommend **3**. Quick Starts are not scenarios, so `F` counts saved scenarios only: a main plan and two what-ifs.
2. **Guardrails.** Paid or free? Recommend **free**. It is the third figure on the outcome strip, part of answering "will my money last", and gating it would be the most visible paywall in the app. Gate the Test Bench and comparison, the "dig deeper" tools.
3. **Monte Carlo.** Recommend **free**, for the same reason: it is the "in simulated markets" figure on the outcome strip.
4. **Viewers of a paid plan's link get the paid tools while viewing.** Recommend **yes** (§3.4), with `shareToken` dropped on **Open & Save**, on a Test Bench save, and from share links made by a viewer without a pass of their own.
5. **Ten plans or all of them.** Rev 0 sold 10 slots; Rev 1 covers every scenario. Recommend **all**. The server cannot tell plans apart, so a cap would only be a count in the user's own browser, and slots were most of Rev 0's complexity. The pitch changes from "10 plans for $10" to "all your plans for $10". A soft cap (say 25) can come later if needed.
6. **Editing a shared paid plan while viewing.** Either the tools stay on until the viewer saves or re-shares (Rev 1), or they lock at the first edit. Recommend **stay on**. A token is copyable anyway (§8), so locking at the first edit only burdens the honest viewer, such as a spouse or adviser trying a what-if on the plan they were sent.
7. **Automatic or manual renewal.** Automatic: renewals don't depend on the user remembering, and the provider sends the notices that auto-renewal laws require. Manual: matches the original four reminders (90/30/7/1 days), and never charges anyone by surprise. Recommend **automatic, with an off switch in the provider's portal**; §5.3 gives the reminders for each case.
8. **Email reminders.** Recommend **the provider's only**, so the server stores no email.
9. **Restoring a pass on another browser, or giving it to the plugin.** Recommend **the `passKey`** from the receipt or the provider's buyer portal, entered under **Restore pass** or given to the plugin as §7.1 says. Depends on §12.12.
10. **The grace period.** Recommend **30 days**.
11. **A refund or chargeback expires the pass at once.** Recommend **yes**, picked up on clients' next 24-hour refresh.
12. **The payment provider.** Recommend a **merchant of record** (Lemon Squeezy or Paddle). It must offer: custom checkout data returned in the webhook (§2.2); a license key on the receipt and in a buyer portal (§12.9); and subscriptions, if §12.7 is automatic. To verify before choosing:
    - Lemon Squeezy issues license keys; check its current terms since Stripe bought it (2024).
    - Paddle Billing (the current Paddle) may not issue license keys. Without them the server issues the key, the claim response is the only place it ever appears, the backup prompt becomes mandatory, and a lost key cannot be recovered, because the server keeps no email.
13. **`diff_plans` in MCP.** Recommend **free**. The plugin's guidance tells the agent to use it instead of comparing two reports, because comparing reports is how a 15-year difference in retirement age once went unnoticed; gating it pushes an unpaid user's agent into exactly that. Plan comparison in the app (a side-by-side view, its own spec) stays paid. This is the one exception to "one rule everywhere"; the alternative is to gate it, with the refusal of §7.2.
14. **Where the server runs.** Recommend **Azure Static Web Apps managed functions + Azure Table Storage** (same repo and domain, no CORS), with the cached status (§4.3) hiding cold starts; or **Cloudflare Workers + KV** if no cold starts are wanted at all.
15. **Existing users.** Recommend keeping every existing scenario usable as unpaid, with the free limit applying only to creating new scenarios.
16. **How the plugin gets the pass key.** Recommend a **plugin setting stored securely**, if Claude Code plugins support one (to verify); otherwise the file from **Download for Claude**, and the environment variable for people who manage their own setup. Never a tool argument (§7.1).
17. **Analytics.** Recommend: **first audit the Tag Manager container** for what it records, the `#` fragment above all, since the promise that a plan never reaches a server depends on it. That audit is worth doing whatever this spec decides. Then add the web events of §13. The plugin sends none.
18. **The license.** Out of scope for this spec, but it is the lever if the honor system ever matters more than it does at $10 a year (or if paid features move to server-side compute or a hosted remote MCP later).

---

## 13. Measuring success

The site already loads Google Tag Manager (§1.7). With the merchant of record's dashboard and coarse server counts, the funnel can be measured without collecting financial data. This is the **web only**: the plugin sends no analytics, so MCP use shows only as server-side counts of restores and refreshes. Whether to add these events at all is decision §12.17.

### 13.1 Instrumentation (no plan contents)

| Signal | Where | Payload (coarse only) | What it answers |
|---|---|---|---|
| `active_planner` | GTM | `{ source: 'quickstart' \| 'custom' }`, once per session after editing an asset or running a simulation | the real denominator, without bounced visits |
| `gate_hit` | GTM | `{ surface: 'test_bench' \| 'scenario_limit' \| 'comparison' }` | which locked feature creates demand |
| `checkout_started` | GTM | `{ trigger_surface }` | whether locked panels persuade people to choose **Get a pass** |
| `pass_claimed` | server | `{ outcome: 'ok' \| 'webhook_wait' \| 'error' }` | checkout completion and claim reliability |
| `paid_tool_run` | GTM | `{ tool }` | whether buyers use the paid tools on the web |
| refreshes by client | server (`X-CF-Client: web \| mcp` on the daily refresh) | counts only | the web vs. MCP mix |
| `shared_paid_view`, `pass_restored` | server (`GET /api/token/…`, `POST /api/pass/restore`) | counts only | reach of shared paid links; multi-device and MCP adoption |

### 13.2 Checkpoints

**The targets below are guesses, not benchmarks.** At early volume, read them as counts: twenty sales is not a conversion rate.

- **Day 30, the plumbing:**
  - at least 98% of completed checkouts succeed on `/api/claim`;
  - under 2% refunds and chargebacks, and under 5% of buyers writing in about a lost pass key (if higher, show the provider's buyer-portal link inside **Restore pass**);
  - `checkout_started / gate_hit` of 5–15%. Below 3% suggests the locked Test Bench panel needs a clearer picture of what it computes.
- **Day 90, whether people pay:**
  - `pass_claimed / active_planner` of 2–5%. Under 1% with healthy `gate_hit` volume means the paid tools are not yet compelling: build plan comparison before cutting the price. Over 5% suggests testing $15–$20.
  - At least 70% of web buyers run a paid tool within 14 days.
  - If 20–30% of refreshes come from `mcp`, a hosted remote MCP is worth considering next.
  - `shared_paid_view` per active pass shows whether paid links bring in new people.
- **Month 12, sustainability:**
  - renewal of at least 55% with automatic renewal, or 25% with manual;
  - net revenue (about $8.75–$9.00 a pass) comfortably above hosting and domain costs ($0–$5 a month), with little support time.

---

## Sources

- `js/scenario-store.js`, `js/ui/util.js`: what a scenario keeps. `js/finplan-app.js` (`loadQuickStartProfile`): Quick Starts load into the scenario on screen.
- `js/share-link.js`, `js/shared-plan.js`: the share payload, `SPEC_KEYS`, `specFromPayload`, `planFormat`.
- `js/plan-ids.js`: `PLAN_FORMAT`, and the in-plan asset ids (`a1`, `e2`) that pass and share tokens must not be confused with.
- `js/mcp/run-plan.js` (`handleFor(spec, opts)`, `SPECS`, `runPlanCached`), `js/mcp/mcp-server.js` (the tools), `js/mcp/plan-reference.js` (`planFromReference`).
- `js/routing-search.js`: the Test Bench routing search, proposed for MCP in its own spec.
- `tests/layer-boundary.mjs`: `ENTRY_POINTS`, `BROWSER_GLOBALS`, the engine closure.
- `js/components/test-bench.js`, `js/components/outcome-strip.js`: gated surfaces.
- `plugin/README.md` (line 8, the network sentence), `plugin/skills/charting-finance/SKILL.md` (the `diff_plans` and `max_spending` guidance).
- `.github/workflows/azure-static-web-apps-happy-glacier-056a05c10.yml`, `LICENSE`, `index.html` (`GTM-WRSW7SKN`, loaded in the head): hosting, license and analytics.
- Discussion with John, 2026-11-18; Rev 1 review, 2026-11-19.
