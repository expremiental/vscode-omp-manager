# Changelog

## Unreleased — local fork source recovery

- Preserve the installed local customizations as maintained JavaScript sources alongside upstream TypeScript, rather than committing generated `out/` files or reconstructing event-sensitive state machines.
- Port session watcher invalidation events, add pin/unpin manifest contributions, and include the preserved identity-cache test in `npm test`.
- Retain upstream metadata, settings, build tooling, documentation, assets, and release history. The installed extension and VS Code settings are unchanged.
- Migration verification (2026-11-11): the integrating agent compiled and passed 23 upstream tests plus five identity-cache subtests. Isolated Chromium checks covered Pinned/Open ordering, current-row marking, pointer routing to an exact remote owner, and keyboard routing to a local terminal. Preservation review confirmed the six recovered modules match the snapshot except source-map comments. No live Extension Host verification, installation, or activation was performed.

The following local customization entries are historical notes from the installed
snapshot, not new verification of this source migration. The November 7 subagent
feature was removed on November 9 and is not restored here.

## Local customization — 2026-11-09

- Removed subagent sidebar rows, disclosure controls, recursive transcript indexing, and the read-only snapshot renderer. Nested artifact changes are ignored by the session watcher's filename filter instead of queuing reads or full rescans. Top-level sessions, pinning, status colors, window routing, and restore remain unchanged; OMP subagents and their transcripts are not disabled or deleted.
- Sidebar canonical-path lookups reuse successful and failed filesystem results within a fixed five-second window. Filtered top-level filesystem events invalidate affected paths and aliases immediately; structural events and watcher errors clear temporary results. Last-known ownership survives missing files, and routing, deletion, and launch checks still resolve freshly. No new polling timer, setting, or dependency is added.
- Backup before removal: `~/.omp/backups/omp-manager-0.3.0-remove-subagents-20261109/`. Reload the Extension Host to load this change; marketplace updates may overwrite this installed-extension customization.

## Local customization — 2026-11-07

- Parents have a disclosure arrow for linked subagent transcripts in their per-session artifact directories. Children stay nested, including during search, and do not consume the top-level history limit or appear as duplicate Open/history rows. Valid session headers and explicit `parentSession` links exclude advisor delivery files and unrelated artifacts; filesystem changes refresh the tree.
- Subagent siblings are ordered newest-first by creation time, at every nesting level.
- Search initially expands subagents, but their arrows still collapse/reopen the list; explicit search overrides last until the query changes and do not alter ordinary expansion preferences. Disclosure arrows sit at the right end of parent rows, preserving the original left position of every session title; childless rows have no arrow or placeholder.
- Child clicks open a separate, clearly labeled read-only snapshot using the configured executable and `omp render <absolute child path> --plain`, without a shell, interactive extra arguments, tracker, restore hook, resume fallback, or new model turn. Output stays readable after the process exits. Opening the child again replaces its prior snapshot with freshly rendered output. Snapshots are not live and do not guarantee complete artifact/scrollback coverage.
- Invalid, missing, or unlinked child paths and render failures report an explicit error. Snapshot terminals are transient and are not restored after reload. Existing parent routing, grouping, pinning, status colors, and selection remain unchanged.
- Backup before this customization: `~/.omp/backups/omp-manager-0.3.0-subagents-20261107/`. Reload the Extension Host to load it; marketplace updates may overwrite this installed-extension customization. Verification is performed separately by the main agent.

## Local customization — 2026-11-06

- The identified session in this window's selected editor terminal has a 2px inset blue frame (`#2459b3`) and `aria-current`. Session cards use uniform 8px padding, leaving more space inside the frame without changing geometry when selection changes. Status backgrounds, titles, grouping, and pinning are unchanged.
- Selection reuses the confirmed tab-to-terminal association without acknowledging unread results. Unknown/restored tabs and editor/panel mismatches remain unmarked until identified; remote sessions are never marked as this window's current session.
- Current-session backup: `~/.omp/backups/omp-manager-0.3.0-current/`. This code-only change needs an Extension Host restart; it adds no manifest contributions.
- Selection-only snapshots decorate existing rows instead of replacing their DOM. Structural updates wait for the active pointer gesture to complete, preserving session clicks during status updates. Background renders restore keyboard focus only when the webview still owns focus. Backup: `~/.omp/backups/omp-manager-0.3.0-switching/`.
- Pin/unpin snapshots render immediately after right-click or macOS Ctrl-click: only ordinary primary-button gestures defer structural updates, and context menus release any pending gesture. Chromium renderer checks cover both context-menu gestures without pointerup and preserve ordinary left-click routing. Restart Extension Host to load this fix.
- Verified with real Chromium pointer/keyboard events: current-only and mixed status updates preserve one open message with the original owner/terminal tuple, external focus is not reclaimed, and keyboard activation remains functional. Native verification restarted the expremients Extension Host, switched HIND → current session, observed the stronger frame on the working session, and opened existing LIVE in its uxpressia owner window. Other windows still need their Extension Host restarted to load this renderer.
- Pinned bookmarks: right-click a session and choose **Pin Session** / **Unpin Session**. Pinned appears before Open, Recent, and projects without duplicate rows; live pins retain status colors and window routing. The group appears after the first pin. Opening a bookmark does not unpin it.
- Pins persist across windows/restarts in `<agentDir>/vscode-pins/`, keyed by the parsed session ID so moves retain the bookmark and new branches do not inherit it. Pins bypass workspace scope and history limits; missing transcripts remain removable bookmarks. Deleting a session through the extension removes its pin.
- With grouping disabled, Pinned and the remaining Sessions have separate headers. Backup before pin customization: `~/.omp/backups/omp-manager-0.3.0-pinned/`. Reload the VS Code window to load the new commands; marketplace updates may overwrite this local customization (bookmark data is stored separately).
- Pin verification: isolated extension-host adapters exercised actual pin commands/storage and cross-window file watching; Chromium exercised the actual sidebar renderer. Native VS Code context menus and the user's running extension host were not reloaded as part of that verification.
- Unpinned folder history shows Open, then Recent (the ten newest non-open, unpinned sessions under the configured time sort), then remaining projects without duplicates. Searching preserves section membership.
- Within each section, sessions sort by waiting for input, unread completion, working, then other states; each status block is newest-first using the configured session time. Working/waiting states take precedence over a retained unread flag.
- Original renderer: `~/.omp/backups/omp-manager-0.3.0-recent/views.js`. Extension updates may overwrite this local customization.
- Open, Recent, and Pinned show only the project name beneath the session title, without visible status or owning-window captions. Status remains in the hover tooltip and background: yellow while working, purple while awaiting an answer, green for an unread completion; otherwise no status background. Project-group rows omit the redundant subtitle. Verified provider output and all three sections in Chromium.
- Solid status palette: working `#ffe396` (user-selected pale yellow without the sandy tint), unread completion `#79cc85`, waiting `#b798ed`; dark foregrounds preserve contrast in light and dark themes.
- Adjacent session cards have a 2px vertical gap so status backgrounds do not merge; group-header spacing is unchanged.
- Unread completions persist per workspace, including while the sidebar is hidden. Confirmed entry into a terminal editor clears green, not departure; tab/terminal events may arrive in either order. Explicit opening of an already-selected startup terminal acknowledges its current result only after its owner window is focused, without inventing a lasting viewed association. Startup/restore focus does not acknowledge results; ambiguous mixed editor/panel focus conservatively retains unread. Viewing never clears a live waiting state.
- A completion requires a same-session working-to-idle transition; missing reports and session switches do not manufacture completion. Backups before this change: `~/.omp/backups/omp-manager-0.3.0-attention/`.
- Open is shared across local VS Code windows using the same OMP agent directory. Each owner publishes its live status and unread state; clicking a remote row reveals the existing terminal and focuses its exact owning window. History retains its configured scope, Recent limit and project grouping; transcript aliases are deduplicated by canonical identity.
- Every resume/restore path checks current ownership. Private Unix-socket IPC can only inspect or reveal existing terminals. Atomic per-transcript launch reservations prevent simultaneous windows from starting copies; stale targets, unavailable owners and uncertain launches fail closed rather than silently resuming.
- A proven closed terminal releases ownership. Extension-host restart preserves terminals and re-adopts ownership. A crash during an uncertain launch can retain a blocking reservation; there is intentionally no timeout-based takeover. Older OMP processes without the reporting hook still need individual restart/resume before their live status can be known.
- Cross-window customization backup: `~/.omp/backups/omp-manager-0.3.0-multiwindow/`. This is a local installed-extension modification and can be overwritten by a marketplace update.

## 0.3.0

- Session transcripts that are symlinks are listed, as omp lists and resumes them. A link to a transcript that is already listed shows once, and a session folder that is itself a symlink is still skipped.
- The workspace session list also shows sessions from the same folders in the repository's other git worktrees, as omp's resume picker does, so a session moved with `/wt` stays listed.
- `omp.restoreContinuesTurns` (off by default) restores sessions with `omp --restore`, so a turn that VS Code closing or crashing cut off goes on, with its subagents. Sessions opened by hand still use `--resume`. Needs omp 18.10.3 or later.
- A session stays working when omp ends a turn it will continue: a goal or todo continuation, a queued steer, or a wait on its background jobs. These no longer show as idle or notify "finished".
- A session waiting on an interactive plan review shows as needing input and notifies like a question. A question now notifies even when the session was idle, since omp ends the turn before opening the review.
- A π button in the editor tab bar starts a new session. Hide it by right-clicking the tab bar.
- Accounts in the usage view collapse: click an account's header. A collapsed account shows its highest usage, and collapse is remembered.
- The pace marker has dark edges, so it shows on the yellow and red bars too.
- The OMP sidebar opens at startup instead of Explorer. VS Code restores the last active view per workspace, so new windows and folders would otherwise land on Explorer. Turn it off with `omp.focusOnStartup`.
- A session keeps its status when omp moves it to a new file, which omp does when another process holds the transcript, and after a branch.

## 0.2.0

- Usage meters show pacing: a marker where usage would be at an even pace through the window, and how far under or over that pace you are. Toggle with `omp.usage.showPace`.
- Session groups collapse: click a header, or use Left and Right on it. Each header shows its session count, and collapse is remembered. A search shows every match regardless.
- Folder groups have a `+` on hover that starts a session in that folder.
- A resumed session shows a hollow "starting" dot until omp reports, which can take several seconds on a large session.
- An `OMP` output channel logs each launch: terminal created, process started, and omp's first report, with timings.
- Restore waits at most 2s (was 10s) for each terminal's process before opening the next, and the missing-hook warning comes after 10s (was 20s), with a Show Log button.
- The first session scan no longer blocks the extension host; it reads files in chunks, and the resume picker shows a busy bar until it finishes.

## 0.1.1

- Sidebar content uses more of the width: 8px from the left edge, and the right edge lines up with the session list's scrollbar lane.
- The omp hook no longer leaves `.tmp` files behind or drops a status update when Windows blocks a file replace.
- Usage limit warnings are remembered across windows and restarts, so each limit warns once per reset window.

## 0.1.0

First release.

- Sidebar with usage limits from `omp usage`: countdown and local reset time, warning color, optional status bar item and warning notification.
- Session history for the workspace or all sessions, grouped by date or folder, with search and keyboard navigation.
- Live status for open sessions (idle, working, needs input), with VS Code or OS notifications when a background session finishes or asks a question.
- Restore the sessions that were open when VS Code closed, in tab order, with an option to ask first.
- Launch settings: extra arguments, environment variables, start folder, tab icon and color.
- Keybindings for New Session, Resume Session, and Focus Next Session Needing Input.
