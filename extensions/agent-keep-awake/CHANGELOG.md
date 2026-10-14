# Changelog

## 1.1.0 - manual-mode and owner-coordinator preview

- Adopt the implementation handoff's Off / Keep awake / Auto mode controls.
- Keep awake means indefinite manual ownership until Off or owning-window exit;
  preserve explicitly timed commands and Duration (Hours), including 0/no expiry.
- Consolidate desired protection behind one idempotent owner-map coordinator
  with instance/generation boundaries, stale-event rejection and bounded timers.
- Off releases only this extension's holds and does not cancel native Copilot.
- Remove the @awake participant/model/tool route from the packaged runtime.
  Its historical tests remain in the development repository, not native Auto evidence.
- Native Copilot Auto stays visibly Unavailable until a complete harness-specific
  lifecycle/correlation profile passes; no live hooks or IPC service are installed.
- Retain combined Windows system/display requests, explicit screen-on/AC
  limitations, and unverified non-Windows readiness rather than false green.
- Native Windows verification now refuses ambient system/display power holds
  as inconclusive before starting a test helper.
- Included as a clearly labeled preview in the owner's public two-extension
  repository. Installation remains explicit; automatic activity detection is unavailable.

## 1.0.5 - unpublished duration settings and Windows standby correction

- Added application-scoped Duration (Hours), default 1, configurable through extension settings.
- Added 0-hour live-forever mode with no expiry timer; still stops on Off,
  window close/reload, or helper failure. Positive durations support up to 24 hours.
- Settings changes affect the next click, never silently alter an active session.
- Validate numeric/fractional durations and keep invalid settings from starting a helper.
- Correct Windows activation to request display activity along with system activity.
  A real idle Modern Standby event was reported despite the earlier system-only request.
- Windows screen-on behavior, AC recommendation, and forced/battery-policy limits
  are explicit in the tooltip and guide; no input simulation or power-plan changes.
- Added test-first settings/no-expiry/display regressions and a native unattended
  idle test that checks real standby events beyond the machine's current timeout.
- Hardened optional @awake context with encoded untrusted data and fresh,
  fail-closed approval of every tool's bounded arguments; preserved native confirmations.
- Explicitly request response-stream closure on cancellation without waiting on
  uncooperative providers; no power ownership remains for a cancelled request.
- Removed prompt/context identity/raw provider-error persistence from extension logs.
- Added security regression tests, late-approval cancellation checks, and 500-cycle
  timer/listener cleanup coverage. Third-party provider/tool lifetime remains outside scope.

## 1.0.4 - unpublished compact coffee status

- Inactive: neutral coffee cup with "@awake ready"; tooltip says awake mode is disabled.
- Active: only the green cup remains, freeing status-bar width for adjacent icons.
- Preserve one-click timed activation; accessible labels and tooltips announce enabled/disabled state.
- Log the loaded version to distinguish installed updates from stale running-window handlers.
- Diagnose the reported non-working click: that window was still running the earlier 1.0.1 status-only handler.

## 1.0.3 - unpublished one-click coffee control

- Click once in the lower status bar to enable a 1-hour keep-awake session;
  click again to disable it, with no duration picker or success dialog.
- Added the requested "Awake mode is disabled/enabled" tooltip wording.
- Kept alternate durations in a separate Command Palette action.
- Added test-first no-picker tooltip checks and a real native-power command-toggle check.

## 1.0.2 - unpublished friendly coffee control

- Added explicit timed start/stop sessions for normal Copilot and Claude prompts;
  no special participant or model account is needed for the coffee control.
- Replaced ambiguous "@awake ready" with neutral Off, Starting, green On, and Failed.
- Green uses the theme's success color and appears only after the OS helper
  acknowledges protection; the text and accessible label also say On.
- Added 30-minute, 1-hour, 2-hour, and 4-hour choices. A session stops on expiry,
  coffee click, or window close, never starts merely because VS Code is open.
- Preserved optional @awake automatic request protection with shared-helper ownership.
- Clearly explains that normal chat completion/cancellation does not stop the timer.
- Added test-first timed-session, green-status, startup, failure, expiry, and mixed-mode tests.

## 1.0.1 - unpublished local @awake preview

- Added a supported `@awake` participant inside Copilot Chat using the selected model.
- Automatically hold system protection across its model requests and explicitly
  attached awaited tools; release on completion, error, cancellation, and shutdown.
- Share a helper across overlapping requests, and abort visibly if protection is lost.
- Use only stable APIs; require desktop VS Code 1.95 or newer and a trusted workspace.
- Added test-first request, cancellation, overlap, tool, budget, and disposal regressions.
- Added actual registered-handler integration checks with deterministic models,
  a real VS Code tool, native OS measurements, and editor-shutdown verification.
- Keep ordinary Copilot requests, standalone Claude chats, and detached work outside scope.
- Preserve the no-login, no-telemetry, no-idle-helper contract. Model providers retain
  their own normal sign-in, consent, plan, and usage requirements.
- No GitHub or Marketplace publication; local user UAT approval is still required.

## Earlier unreleased diagnostic prototype

- Withdrew the prematurely published prototype and GitHub Pages site.
- Removed editor-open and generic activity modes. Old settings cannot turn them on.
- Reports unavailable chat integration explicitly; does not make any power request.
- No transcript monitoring, undocumented API access, or manual fallback.
- Added startup and manifest regression tests before implementation.
- Fixed backend reentrant release/acquire/dispose leaks after reproducing them in tests.
- Removed automatic release and push-triggered workflows.
- Provider-wide automatic lifecycle integration was blocked; the supported
  participant-based preview above does not claim to solve interception of other chats.
