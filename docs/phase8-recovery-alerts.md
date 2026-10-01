# Phase 8 automatic recovery and result-change alerts

Implementation checkpoint, 2026-09-30. These changes are in the source tree; this note does not assert a packaged release, a live Google login test, or a successful paid model run.

## Browser observation recovery

`packages/task-recovery` wraps only internal fresh browser observations or reopening a stopped session. Known temporary observation/transport errors get up to two additional attempts with 300 ms and 1,200 ms delays. The task has a durable total allowance of four reserved automatic retries. A successful repair continues the current task; it does not create a replacement task or increase its model, time, token or tool limits.

An attempt is persisted before its delay and callback, so a crash cannot restore spent retry authority. Task authority is checked before the initial read, after the delay, and after each returned read. An abort, pause, sleep or shutdown cancels delayed work and drains active wrappers. Records from a dead process become interrupted without automatic replay. Acknowledging an incident changes its reviewed state only; it never resets its retry allowance.

Login, MFA, policy violations, model failures, uncertain navigation, website clicks and other writes are outside this retry service. Existing account-specific login requests remain responsible for human sign-in. Error details saved here are fixed messages and an allowlisted error code, not arbitrary browser text, credentials or exception messages.

Integration:

- Migration constant: `TASK_RECOVERY_MIGRATION` from `packages/task-recovery/migration.ts`.
- `TaskRecoveryService.runRead({taskId, runId, operation: 'browser_read', check, signal?, read})` replaces the former immediate single-retry wrapper.
- `suspend()` cancels backoff and drains; `resume()` allows future reads; `drain()` waits for current wrappers.
- Owner commands are `taskRecovery.state` and `taskRecovery.acknowledge`.
- `RecoveryCenter` accepts `recovery`, `onChanged` and `onTask` props. Its owner bridge and navigation must be wired before presenting it as an available screen.

## Result-change alerts

Routines can opt into in-app result-change alerts. Existing routines keep alerts disabled until the owner enables them. New routine setup includes an explicit checkbox. Alerts inspect future completed scheduled runs against the latest earlier owner-accepted occurrence, falling back to the accepted source result. Each comparison names the exact immutable baseline and output versions. Accepting an output in Results makes it eligible for future comparisons; marking an alert reviewed does not accept its output.

Complete Markdown, plain text and CSV outputs up to 1 MiB are supported. CSV comparison ignores row ordering, column ordering and equivalent quote syntax while preserving duplicate-row counts and literal cell values. It never evaluates formulas. Markdown comparison ignores ordinary spacing, paragraph wrapping and heading depth. Code indentation, numbers, links and section ordering remain significant. This detects content differences, not semantic correctness or verified changes in the outside world.

Comparison records and notices are durable. Equivalent output is recorded as unchanged. Repeated changed content against the same exact accepted baseline produces only one alert. A new accepted baseline allows later reversals to be detected. Unsupported, missing, corrupt or oversized outputs are explicitly comparison-unavailable rather than unchanged. Differences show up to eight short added and removed examples and links to both tasks; complete outputs remain in Results. No private report content is sent to a notification provider or model by this feature.

The existing routine tick reconciles comparisons before dispatching due work. Its sleep/backup suspension fences asynchronous reads before recording an alert. Existing schedule consent, occurrence leases, no-overlap checks, per-run and monthly caps, and interrupted-dispatch behavior remain in effect.

Migration constant: `ROUTINE_ALERTS_MIGRATION` from `packages/routines/migration.ts`. `RoutineService` constructor is unchanged. Its state now includes `alerts`, `unreadAlerts`, per-routine `alertsEnabled`, and per-occurrence `comparison`; owner commands add `routines.setAlerts` and `routines.acknowledgeAlert`.

## Source freshness and remaining work

Scheduled tasks still reuse their saved workflow, account policy and exact selected input versions. This change does not refresh an imported Google document, expand an account scope, or silently read a different resource. A changed generated report may reflect wording differences even when the source has not changed. The Routines screen states these limits. Explicit, versioned refresh recipes for selected resources and account/range bindings remain future work.

Alerts are visible inside the app. Native desktop notifications, quiet-hour delivery and a unified notification inbox are not claimed here. There is no automatic factual verification or automatic result acceptance.

## Focused verification

- `tests/phase8/recovery.test.ts`: six passing cases for transient recovery, durable exhaustion across service instances, authentication/model/write exclusions, pause during backoff, authority fences and dead-process recovery.
- `tests/phase8/alerts.test.ts`: six passing cases for normalized comparison, changed values, immutable accepted baselines, deduplicated notices, unavailable outputs and pause/consent fences.
- Existing `tests/phase7/routines.test.ts`: all fifteen cases passed after integration, including spend caps, occurrence leases, expiry, no overlap and interrupted dispatch.
- The first integration run exposed an obsolete Phase 5 assertion about exactly one immediate retry and history notes. The integration now checks durable success/exhaustion records and bounded attempts; all eight Phase 5 recovery cases passed, including Google login and uncertain-navigation behavior.
- Final combined verification of recovery, routines, alerts and the separate Security Review integration suite: 42 passed, zero failed. TypeScript checks also passed for the shared tree.

No external accounts, paid model requests, new downloads or running production data were used by these tests.
