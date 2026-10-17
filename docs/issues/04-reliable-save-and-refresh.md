# 04 — Keep saves consistent during rendering and failures

Status: blocked

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

Record implemented behavior, tests run and results, contract changes, and remaining limitations here when completing the ticket.

