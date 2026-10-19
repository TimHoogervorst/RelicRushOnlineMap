# Dungeon runs and replay

Date: 2026-10-19
Status: design decisions resolved; awaiting confirmation of shared understanding. Implementation has not started.

## Purpose

Record dungeon attempts by one or two players continuously, retain them in the local database, and let every viewer search and replay everyone's history. Each run has one shared outcome: Win, Loss, or Interrupted.

## Lifecycle

- At most one active run exists, with at most two distinct participants.
- The first reliably mapped player starts the run. A second entering during the active run joins it.
- Record while the server runs, even without website visitors. Use the published map rather than unsaved editor diagnostics.
- Record each participant's identity, name, and route separately.
- A healthy feed reporting a participant outside or absent starts their 15-second departure grace period. Returning before finalization cancels it and continues that participation.
- Finalize departure after 15 seconds of confirmed absence. End the shared run when all participants have finished.
- Finalized participants cannot rejoin that run. No replacements are added. Unexpected arrivals remain visible live but are not added to the occupied recording.
- In the game, one player dying causes both players to disappear. The feed has no death signal, so use the final-position classification below.
- Feed failures, stale data, and ambiguous assignments are not evidence of departure. An outage cancels pending departure countdowns; after recovery require a fresh 15 seconds of confirmed absence.
- A server restart or 60 seconds of unavailable/ambiguous tracking ends the recording as Interrupted. Preserve the recorded portion with a neutral indicator.

## Single endpoint and outcome

- Support one endpoint. Editors place or move it by clicking the map. It belongs to a section; terrain supplies an initial height that the editor can correct.
- Its inclusive qualifying area is a centered 10-by-10-block horizontal square: at most five blocks along either horizontal axis and at most two blocks vertically, in the corresponding Minecraft world.
- Snapshot the endpoint configuration at run start. Edits affect subsequent runs and never rewrite historical outcomes.
- For conclusive departures, use only each participant's last reliably tracked dungeon position.
- Win: at least one participant's final position qualifies. For solo runs, that participant must qualify.
- Loss: no final position qualifies, including when no endpoint was configured. Earlier visits to the endpoint never qualify a later departure elsewhere.
- Interrupted remains the exception for missing tracking evidence, rather than a conclusive departure.
- Show a green success indicator, a loss cross, or a neutral interrupted indicator. These are shared outcomes, not individual death judgments.

## Recording and duration

- Persist runs, participants, timed positions, and encounter events in the local database.
- Record fresh feed observations, approximately every two seconds. Do not duplicate cached observations when browsers request tracking.
- Retain world and section-local positions sufficient for classification and replay against section layouts.
- Show total run duration and each participant's duration.
- Total duration spans the first participant's entry through the last recorded dungeon position across participants. Individual duration spans that participant's entry through their last recorded dungeon position.
- Include brief gaps within those intervals; exclude final departure grace periods. Durations are observed estimates, not authoritative game timestamps.

## Marker encounters

- Ordinary markers qualify within a horizontal four-block circle in the player's section. Exclude tracker points and calibration waypoints.
- Animate a brief growth only on the first encounter with each marker per run, whichever participant reaches it first. Neither participant can retrigger it. A new run resets eligibility.
- Save first-encounter events; replay reproduces them rather than recalculating against subsequently edited markers.
- Animate during live tracking and normal playback, once per marker per playback. Scrubbing does not animate encounters. Restarting playback resets eligibility.

## History

- Place Previous runs below Players. All viewers can browse, search, and replay all recordings.
- Initially show the latest five completed recordings, including Interrupted recordings, newest first.
- Search names using case-insensitive partial matching; either co-op name can match.
- Combine name search with calendar-based date/time filters using run start time. A date alone covers the whole day. Display the timezone explicitly.
- Changing filters resets the count to five. Show 10 more expands to fifteen, twenty-five, and so on while preserving filters.
- Retain every recording unless explicitly deleted; five is a display limit.
- Show participants, start time, outcome, total duration, individual durations, and replay access.

## Replay

- Selecting a recording displays red routes; distinguish co-op routes with solid and dashed lines.
- Animate both player heads on one clock, preserving their relative join times and observation timing.
- Provide play/pause, a draggable timeline, restart, and 0.5x, 1x, 2x, 4x, and 8x speeds.
- Interpolate ordinary observations smoothly. Preserve elapsed time and show tracking gaps; break lines across missing observations and section changes rather than inventing connections.
- Do not append 15 seconds of stationary playback for departure confirmation.
- Follow either participant across floors. Both heads appear whenever on the displayed floor.
- Use sections' current layouts for historical section-local routes. Moving sections keeps routes aligned; deleted sections produce explicit map-section-unavailable gaps.
- Clearly label replay mode, suspend live following, and hide live heads. Background recording continues. Back to live restores the live map.

## Deletion, backups, and storage

- Authenticated editors can delete individual completed or Interrupted recordings after confirmation. Active recordings cannot be deleted.
- Remove the recording and its associated participant, route, and encounter data together.
- Include recordings in database backups. Restoring a backup restores its history. Deletion does not remove copies from existing backups.
- Coordinate recorder lifecycle with database restoration. Recording writes must not trigger terrain publication or map-edit revision conflicts.

## Verified implementation context

- Tracking currently refreshes on browser/API requests. Continuous recording requires server-owned polling; upstream requests already share in-flight work and a minimum two-second interval.
- Feed records contain UUID, name, world, and X/Y/Z, but no party, death, success, or source observation timestamp. Receipt time is available.
- Public tracking hides outside/ambiguous positions and expires stale data after 15 seconds. Recording must use richer evidence, not public-list disappearance.
- The database is data/project.sqlite, using SQLite with WAL. Existing backups include the full database. Run tables do not yet exist.
- Ordinary markers lack height; the endpoint needs height data.
- Historical head lookup needs support beyond the existing endpoint's restriction to recently online players, with a fallback when a head cannot load.
- Relevant files: src/player-tracking.js, src/tracking-coordinates.js, src/project-store.js, src/server.js, src/backup-service.js, and public/player-tracking.js.

## Acceptance scenarios

1. No website is open: entry starts recording. A second participant joins the same run.
2. A participant returns before departure finalization: the same participation continues.
3. Both disappear and complete the absence windows. One final point inside the endpoint means Win; neither inside means Loss, even after an earlier endpoint visit.
4. Boundary coordinates qualify inclusively; positions beyond horizontal/vertical bounds or in another world do not.
5. Moving the endpoint during a run affects the next run, not the current or historical outcome.
6. A feed outage cancels a departure countdown. Recovery requires a fresh absence window. Restart or 60-second tracking interruption preserves an Interrupted recording.
7. Alice encounters a marker; her return and Bob's later arrival do not animate it again. A new run can animate it.
8. Replay reproduces first encounters once. Scrubbing does not animate them; restart permits them again.
9. Co-op participants join at different times: playback preserves their timing and supports following either across floors.
10. Entry at 12:00 and last position at 12:05 produce five minutes, even if departure finalizes at 12:05:15.
11. Search either co-op name and a date range together. Show 10 more expands five matches to fifteen when available; changing filters resets to five.
12. Confirmed editor deletion removes the recording and related data. Visitors cannot delete, and active recordings cannot be deleted.
13. Moved sections keep routes aligned; deleted sections show an unavailable gap without changing outcomes.
14. Replay hides live heads while new runs continue recording. Back to live restores live tracking.
15. Restoring a backup restores its recordings, including subsequently deleted recordings present in that backup.

## Confirmation

All interview answers through round four are incorporated. Confirm that this specification reflects the intended feature before implementation begins.
