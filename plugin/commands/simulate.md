---
description: Run a financial simulation — a built-in profile, or a portfolio you supply.
argument-hint: "[profile name or a description of the plan]"
---

Run a Charting Finance simulation for: **$ARGUMENTS**

Follow the `charting-finance` skill. In particular:

1. If no profile is named, call `list_profiles` and ask which fits, rather than
   picking one. The profile determines every asset and date in the run.
2. If ages were mentioned, pass them — `startAge` / `retirementAge` / `finishAge`
   genuinely reshape the plan.
3. Add `monteCarlo` only if the user asked about uncertainty or ranges, and
   carry the calibration caveat from the skill when you report the percentiles.
4. Lead with "What Needs Attention", then the specific thing that was asked
   about. Do not paste the whole report back.
5. Keep the run handle — follow-up questions go to `explain_month` /
   `explain_issue` against that handle, never to a fresh run.
6. Report what the model projects. Do not recommend a course of action.
