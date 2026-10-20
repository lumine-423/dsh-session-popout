# Session Popout

> **This project is AI-assisted.** The author owns the requirements, design direction and acceptance; the code, docs and debugging were done in an AI pairing session. Everything was human-reviewed before release, and the feature descriptions below describe actual behaviour.

Drag sessions out of the sidebar into their own standalone window, so you stop switching back and forth.

In DeepSeek Harness every session shares one window. Watching two sessions at once, throwing one onto a second monitor, or reading a long answer while doing something else all mean clicking through the sidebar again and again. This plugin turns *one session* into a real operating-system window. Closing it leaves the main window alone; the main window keeps working.

## When it helps

- **One session is grinding through a long task while you keep chatting in another.** Send the long one to its own window and leave the main window on the conversation you are actually having — neither gets evicted, neither needs switching.
- **You want a session on your second monitor.** The popout is a real OS window: drag it to any display, fullscreen it alone, let the window manager remember where it sat.
- **You are waiting on a long answer and working elsewhere.** Park the session you are waiting on in its own window beside your work, instead of clicking back to check on it.

---

## What it looks like

The popped-out window is **DSH's own conversation UI**, not a screenshot in a frame:

- the same *Conversation / Trace* tabs, model name and top-right controls
- the same message flow, with Markdown, code blocks and tool-call cards rendered exactly as before
- the same composer, image/file upload and status bar
- the sidebar collapses itself, so the window holds nothing but that session

In other words, a slice of DSH is **cut out**, not redrawn. The plugin does not render any conversation content — the host does that. It only opens the window, collapses the sidebar, and adds two small buttons to the session header.

## Features

| Capability | Detail |
|---|---|
| Drag to pop out | Drag a sidebar session outward; the window opens where you release |
| Merge by dragging | Drag one window onto another and the two sessions merge into a group window |
| Group window | Several sessions side by side, with a member rail to switch and split out |
| Recall | Click **⇲ Recall** in the window and the session returns to the main window |
| Follows host theme | The native title bar tracks DSH's light/dark preference |
| Hot reload | Plugin edits reload through HMR without restarting DSH |

## Install

From GitHub (works today):

```bash
dsh plugin add github:lumine-423/dsh-session-popout
```

Or use the prebuilt tarball (no local build, faster install):

```bash
dsh plugin add "https://github.com/lumine-423/dsh-session-popout/releases/latest/download/dsh-session-popout.tgz"
```

Once it is on npm, plain `dsh plugin add dsh-session-popout` will work too.

Then just drag any session out of the sidebar. No configuration needed.

## Listing status

- ✅ GitHub repository live: [lumine-423/dsh-session-popout](https://github.com/lumine-423/dsh-session-popout), with a release and a prebuilt `dsh-session-popout.tgz` (the asset name carries no version, so the install command does not rot on the next release)
- ⏳ Market catalog: PR open — [awesome-dsh-plugin#8306](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8306). The catalog has an automated 1-day repo-age check; it is red on the first run, re-runs itself every six hours, and turns green on its own once the repo is a day old. No need to reopen anything
- ⏳ npm package `dsh-session-popout`: not published yet; once it is, the market can show a download count

## Requirements

- **DSH Desktop** (`dsh-desktop-runtime`). The plugin borrows the desktop app's bundled Electron to create native windows. Plain `dsh web` has no such capability and the plugin quietly does nothing there.
- Electron lookup order: `DSH_POPOUT_ELECTRON` env var → the current process → `<home>/.dsh/electron/`. Point the env var at another Electron build if you prefer.

## Known limitations

**This plugin relies on parts of DSH's internals** rather than a public, stable plugin API. Specifically:

- layout service `beginNavigation()`, `toggleSidebar()`, `closeRightbar()`
- `retainedBy.mainView` in the session snapshot, used to verify main-view ownership
- stable DOM markers the layout layer emits, such as `data-shell-overlay`
- the `conversation.session.header.utilities` slot

That means **a DSH upgrade may break it**. The usual symptom is an empty window with only the background, or a missing button — not a crash. Please include your DSH version in any issue.

Other limits:

- Verified on Windows only; macOS/Linux code paths exist but are untested on real machines
- A session can appear in one window at a time
- Group member order cannot be dragged (use the dropdown)

## When it goes wrong

The window carries its own self-check: if DSH's conversation UI has not appeared 3.5 seconds after opening, a panel appears at the bottom listing every layer it probed (frame, sidebar state, overlay, session catalog, open state, boot errors). Screenshot that panel into an issue — it says far more than "it's blank".

## Development

```bash
# Edit the source directly — the profile links to it, so a page refresh picks it up.
# client.js changes are detected by index.js's watcher and hot-reloaded.
```

| File | Responsibility |
|---|---|
| `index.js` | Host side: HTTP routes, spawning and supervising the window butler |
| `client.js` | Front end: drag-to-pop, collapse shell, open session, header buttons |
| `window/main.cjs` | Butler main process: BrowserWindow creation, merge/split/close |
| `window/preload.cjs` | Page preload: window identity, shell layout narrowing, self-check reporting |

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) plus an added source-availability term. SPDX identifier: `LicenseRef-PolyForm-Noncommercial-1.0.0-With-Source-Availability`.

In plain terms, you may:

- use it for free, for any noncommercial purpose — personal, study, research, hobby, charity, education, public research, and government use are all permitted
- read the source and change it for yourself
- pass the unmodified plugin on to someone else

You may not:

- **sell it or use it commercially** — no selling, no shipping inside a paid product, no running it as part of a commercial service. Contact the author for a separate commercial licence
- **publish a modified closed-source version** — if you distribute a modified copy, you must publish the complete corresponding source of your version under these same terms, free of charge, somewhere the people who got your copy can find it. Compiled, bundled, minified, or otherwise machine-only output does not count

Full terms are in [LICENSE](LICENSE).
