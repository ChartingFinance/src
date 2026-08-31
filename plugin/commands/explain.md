---
description: Ask why the simulator produced a particular number, using a run's recorded causal chain.
argument-hint: "[what surprised you — an asset, a month, or a flagged issue]"
---

Explain, from the most recent run's recorded history: **$ARGUMENTS**

Use the run handle from that run. Call `explain_issue` for something flagged
under "What Needs Attention", or `explain_month` for an asset in a given month.

Derive the explanation from the returned causal chain only. Do not recompute the
arithmetic yourself and do not narrate a mechanism the chain does not show — if
the chain does not account for it, say that it does not, and treat it as a
finding worth reporting rather than a gap to fill in with a plausible story.

If no run handle exists yet in this conversation, run the plan first — a handle
identifies one specific run, and a fresh run would answer a different question.
