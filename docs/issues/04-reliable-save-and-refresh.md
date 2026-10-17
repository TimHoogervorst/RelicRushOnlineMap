# 04 — Keep saves consistent during rendering and failures

Status: in progress

## What to build

Exercise and complete the shared save workflow through real floor/section edits in the UI. Add queueing, stale-write protection, retry and interruption recovery now so subsequent mutation features inherit them.

User story: The owner can keep editing while saves run, and visitors always receive a complete saved map.

Follow the agreed spec and domain glossary. Shared constraints: one Docker app; password-protected authoring; one-time schematic import; section-local anchors; Save/autosave updates visitors on refresh; no separate publish step. Implement meaningful verification with the slice, not in a deferred testing phase.

## Acceptance criteria

- [ ] One generation job runs at a time. Each save uses a fixed revision; queued autosaves can coalesce, but older jobs cannot replace newer saved output.
- [ ] Continuing edits during rendering remain visibly unsaved until their own save succeeds. Stale writes from another tab are rejected with reload/retry guidance.
- [ ] Expose unsaved/saving/saved/failed states, explicit Save to flush pending work, debounced text edits, and meaningful worker progress without blocking visitor requests.
- [ ] Render failure, process interruption and invalid output retain the previous complete public map and recoverable edits. No partial image/data revision becomes visible.
- [ ] Refresh loads consistent images, metadata and overlays from one saved revision; cache behavior is tested. No preview approval, draft publication, or Publish action is introduced.
- [ ] Provide a reusable session command/undo contract for subsequent edits and bounded recovery infrastructure. Verify the workflow with two editor tabs and injected job failures.

## Blocked by

- [03 — Import a schematic into a saved floor and section](03-import-sections-and-floors.md)

## Handoff

Implemented the shared save contract foundation. Project imports now require the caller's expected project revision, commit their revision increment with their SQLite changes, and enqueue generation from an immutable geometry snapshot. Saves run serially, replace one pending autosave with the newest revision, and reject stale work. Each completed release contains its floor images, manifest and project snapshot under one revision; a single atomic pointer update makes it public. Public manifests are uncached and image URLs pin a revision with immutable caching. Startup regenerates from persisted project data, so an interrupted render leaves the old pointer intact and is retried on restart.

The editor shows save state/progress and offers Save to retry/flush. Schematic imports autosave after import. Renderer work runs in a worker so map visitors can keep requesting the last complete release. Failed import rendering returns the accepted edit as recoverable and reports the save failure. There is no Publish action.

Verification: `npm.cmd test` (22/22 passed); `npm.cmd run typecheck` (passed). Added queue ordering/coalescing/failure tests, immutable release and retry tests, stale project revision/API checks, manifest/image cache assertions, and floor-snapshot assertions through the public routes.

Remaining: two-tab browser verification, Docker acceptance, and process-kill/restart exercise were not run. The UI has no geometry/text edit controls yet, so debounce and undo/redo are contracts for later mutation tickets rather than exercised editing flows. Ticket 03's imported floors now appear in generation manifests, but full floor/section overlay presentation still needs viewer work. Do not mark done until those checks and the reusable session-command/undo contract are completed.

