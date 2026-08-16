# claude-agent-watch

**See what every Claude Code session and subagent is doing right now.**
One shared timeline, across every window and every project.

No hooks. No build step. No dependencies. One command.

```bash
git clone https://github.com/USER/claude-agent-watch
cd claude-agent-watch
node server/index.mjs
# → http://127.0.0.1:4317
```

Node 18+. There is no `npm install`.

---

## The problem

You hand a task to Claude Code, it spawns subagents, and three hours later you still
cannot answer two simple questions:

- **What has it actually done?**
- **Is it still working, or did it stall?**

The terminal shows a river of tool calls. Open two or three windows and you cannot even
tell which one is doing what.

## What you get

```
전체 활동                                              12:28 ~ now
        13:00      13:30      14:00      14:30      15:00
─────────────────────────────────────────────────────────────────
● toss-agent   ▐ add rule engine ▌▐ redo the change gate ▌▐ ... ▌
  › rule engine  ▐Impl 6▌▐Review 6▌▐Fix▌▐ Implement Task 7 ▶▶▶ ▌

● fogmap       ▐ just do it ▌▐ ok go ahead ▌
  › 3d flythrough
```

Two kinds of bar share one axis:

| Bar | Means | Label is |
|---|---|---|
| **Blue** | A turn: one thing *you* asked for | what you typed |
| **Grey** | One subagent, start to finish | the agent's description |
| **Green** | Running right now | grows toward the right edge |

Below the timeline, one card per live session:

```
● toss-agent › rule engine          [rule-engine]     running
  ASK   redo the change gate removal, forget the theme stuff

  ▸ Implement Task 7: remove change gate    sonnet · 52 tools · 18m

  The review found one Critical. Because of the ordering, a silent
  block with no reason came back through another path.
  15:08:15                                           show all

  SAME ERROR ×4   6m   Bash
  Exit code 2 ./.ruff_cache ./.venv/Lib/site-packages/ruff …

  Bash  python -m pytest tests/ -q                          2m

  PLAN  6/11   avg 21m · 5 left ≈ 1h 43m      [show tasks]
  ██████░░░░░
  ▸ 7. remove change gate                                  17m

  TOKENS  out 720K   cache-read 150.3M         since 23:42
```

---

## It calls you, so you don't have to watch

The point is not to give you another screen to stare at. Turn on 🔔 and the page
notifies you at exactly two moments:

| | When |
|---|---|
| **Your turn** | it was holding a tool, let go, and is now waiting on you |
| **Stuck** | the same error keeps repeating |

Nothing else fires. An alert that goes off constantly stops being a signal.

### Failures are not events, they are a pattern

The first version showed every tool failure. That was wrong.

Most tool failures are **the agent's normal working rhythm**, not incidents.
`String to replace not found` means read the file again. `File has been modified since
read` means the same. `ruff` exiting 1 is what running a linter is *for*. The agent looks
at the error and carries on — and a red box announcing a problem it already solved is pure
noise. In testing, a failure from 13:57 was still sitting on screen at 15:41.

The useful signal is not *"a failure happened"*, it is **"it isn't getting anywhere"**.
So nothing is shown until:

- the **same error repeats 3+ times** within 10 minutes (paths and line numbers are
  stripped before comparing, so hitting one wall over and over is recognised), or
- **6+ errors** land in 10 minutes at all

Otherwise the card stays quiet, because there is nothing you need to do.

Stuck is checked before your-turn, because reporting a session that ground to a halt on an
error as "finished" would be a lie.

---

## Why no hooks

Claude Code can push events to you through hooks. That approach has two holes:

1. **Hooks are read when a session starts.** A window that is already running sends
   nothing until you restart it — and restarting kills the work you were watching.
2. **Hooks are per project**, configured in `.claude/settings.json`. A window open on a
   different repo stays invisible until you install them there too.

Together that produces the exact failure you were trying to avoid: two windows busy,
dashboard empty.

This tool reads what Claude Code **already writes to disk**. Nothing to install, nothing
to restart, and history that predates the tool is visible immediately. The cost is that
it polls (4s) instead of streaming.

It only ever **reads**. It writes nothing and sends nothing anywhere.

```
~/.claude/projects/<slug>/<session>.jsonl                   main loop
~/.claude/projects/<slug>/<session>/subagents/*.jsonl        subagents
~/.claude/projects/<slug>/<session>/subagents/*.meta.json    description, model
```

---

## How "running" is decided

The obvious rule — *last write was under N seconds ago* — is wrong.

While a single long `Bash` runs (a build, a lint, a full test suite) **nothing at all is
written to the transcript**. Measured gaps of 102s, 263s and 284s were routine, and every
one of them made a perfectly busy window look dead.

So:

- **A tool call was issued and no result has come back** → running, no matter how long
- Otherwise, fall back to recency (90s)

## How the timeline is built

Subagents record their own boundaries, for free:

| File | mtime is |
|---|---|
| `agent-<id>.meta.json` | when the subagent was spawned |
| `agent-<id>.jsonl` | when it last did anything |

Two `stat` calls give you a bar. No file contents are read. Measured: **143 subagents in
69 ms**, cheap enough to poll.

The main loop has no such boundaries, so the timeline uses **your prompts** instead. One
request, to the moment before the next request, is one bar — labelled with what you typed.
That is why the timeline reads as *"what I asked for, and how long it took"*.

---

## Plan progress (optional)

If you use the [superpowers](https://github.com/obra/superpowers) SDD file convention,
each session card also shows plan progress and an estimate.

```
<project>/docs/superpowers/plans/<newest>.md   →  `## Task N: title`
<project>/.superpowers/sdd/task-N-brief.md     →  task started
<project>/.superpowers/sdd/task-N-report.md    →  task finished
```

The estimate averages finished tasks (and refuses to guess from fewer than two samples).

**If you don't use that convention, this section simply doesn't appear.** You never have
to adopt it to use the tool.

The project root comes from each session's own `cwd`, so windows on different repos each
show their own plan. When several windows share a repo, only the one actually running
tasks gets the progress bar — otherwise the same numbers show up on unrelated cards and
you cannot tell whose they are.

---

## Tokens

Each card shows output and cache-read tokens, with a **`since HH:MM`** label.

That label is not decoration. Only the last 4 MB of each transcript is parsed, so the
number is "what landed in the window", **not** a session total. Presenting a partial sum
as a lifetime total would be worse than showing nothing.

No dollar figure is shown. Prices change and most people here are on a subscription, so
tokens are the honest unit.

## Desktop widget (Windows)

Park it down the edge of your screen instead of leaving a browser tab open:

```powershell
# one-click: makes a desktop shortcut, then just click it
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1

# or run it directly
.\widget.cmd
powershell -ExecutionPolicy Bypass -File widget.ps1 -Width 520 -Side left -OnTop
```

`install-shortcut.ps1` adds a desktop icon that launches with no console window. Add
`-Startup` to also launch it at login, and `-Remove` to take both away.

It starts the server if needed, then opens Chrome (or Edge) in app mode — no tabs, no
address bar — snapped to the screen edge at full height, in its own browser profile so it
doesn't mix with your normal windows. `-OnTop` keeps it above everything.

Clicking again never opens a second window: if one is already up, it is brought to the
front instead.

**Switch either way with the 🪟 / 🖥 button in the header.** From the widget it opens the
page in your normal browser and closes itself; from the browser it launches the widget.
The endpoint that opens windows only answers requests from this machine, and only while
the server is bound to loopback.

The compact layout follows the *mode*, not just the width: the widget window carries
`?widget=1`, so it stays compact even if you stretch it. Under 720px anything compacts
anyway. Compact drops the timeline's label column, stacks cards single-file, and hides
token counts.

**This is a window, not a desktop-embedded widget.** It won't sit behind other windows on
top of the wallpaper — for that you'd need something like Rainmeter driving the same
`/api/sessions` endpoint. Wrapping the page in Electron or Tauri would give a nicer frame,
but it would also add `node_modules` and a build step, and then "clone it and run node" is
no longer true.

On macOS and Linux, just open `http://127.0.0.1:4317` in any browser window and size it
however you like — the compact layout kicks in the same way.

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to reach it from another machine. There is **no auth** — trusted networks only. |

## Layout

```
server/index.mjs      HTTP + static files, no dependencies
server/sessions.mjs   transcript parsing, liveness, timeline
server/plan.mjs       optional SDD plan progress
public/index.html
public/app.js         rendering, no framework
public/styles.css     light + dark, derived tokens
```

---

## Known limits

- Sessions active in the last **12 hours**, up to **8**; timeline reaches back **3 hours**.
- Transcripts grow to tens of MB (37 MB and 83 MB in testing). Only the **last 4 MB** of
  each is parsed, cached by size and mtime so idle sessions cost nothing. A session that
  has been quiet for a very long time may show an empty title or request.
- **The UI is in Korean.** If you want English, open an issue — the strings are in two files.
- Claude Code's transcript format is not a public API. A future version may break this.
  Verified against **Claude Code 2.1.x**.

## License

MIT
