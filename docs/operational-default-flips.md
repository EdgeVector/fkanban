# Operational Default Flips

F-Kanban defaults that change pickup eligibility, write guards, routing
classification, or the visible board frontier are operational events. Treat
them as agent-impacting config changes even when the code change is small.

Before promoting a host-track build or config where an `enforce*` default flips
from permissive to restrictive, post a non-blocking Situations notice. The
notice lets scheduled pickup, watch, groom, and reconciler workers attribute
short-lived queue shrinkage or write rejections to an expected rollout instead
of diagnosing a LastDB outage.

Use this shape, filling in the promoted build and expected fallout:

```bash
situations notice \
  --title "F-Kanban enforceLivePrMilestone default enabled" \
  --kind config \
  --system fkanban \
  --system last-stack-board \
  --app fkanban \
  --actor human \
  --expires-hours 2 \
  --summary "Promoting <build/ref>: Kind:pr todo/doing placement now requires milestone linkage. Agents may see pickup frontier shrinkage and live_pr_milestone_required rejects until cards are attached or intentionally forced."
```

Scheduled routines should set `--actor routine:<automation-id>` instead of
`human`; skills should use `--actor skill:<skill-name>`. Keep the notice narrow
and temporary. It is FYI only and must not block preflight.

This convention applies to any future default or host-track promotion that can
change a previously valid board write into a guarded write, including:

- `enforce*` guard defaults
- pickup eligibility policy changes
- default lane or diagnostics classification changes that move cards between
  ready, skipped, or malformed buckets
- host-track promotions where the installed CLI observes stricter behavior than
  the prior installed CLI

If the change is an emergency rollback or disables a restrictive default, still
post a notice when agents may see the opposite transient symptom, such as a
frontier expanding or earlier rejects disappearing.
