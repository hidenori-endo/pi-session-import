# pi-session-import

Search your **Claude Code** and **Codex CLI** history the way you remember it — *"yesterday's PR discussion in subtitle-ml"* — and import that conversation into [pi](https://pi.dev) as a real pi session you can continue.

Both agents are searched through the same index and imported through the same code path, so `claude:` and `codex:` sessions behave identically.

## Install

```bash
pi install npm:pi-session-import
# or
pi install git:github.com/hidenori-endo/pi-session-import
```

Run `/reload` if pi is already running.

## Usage

### Let the model find it (no ids, no titles)

```
> bring over yesterday's ARIB ingest failure discussion from subtitle-ml

  [find_sessions] query="subtitle-ml ARIB ingest" since_hours=48
  [import_session] ref="codex:019ff377" turns=60
  → run /import-open to continue in it
```

### Or drive it yourself

```
/resume-session <keywords>                     pick from matches, import, and switch to it
/resume-session codex:019ff377 --turns 100     import a specific session
/resume-session claude:46b90abf --mode strict  include tool calls/results as text
/import-open                                   open what the tool imported last
```

> The command is `/resume-session` — it reads for a Claude Code or Codex session what pi's
> `/resume` reads for a pi one. It is deliberately not `/import`: pi's interactive mode
> matches its own built-in `/import` (import a pi JSONL file from disk) before extension
> commands are dispatched, so a command registered as `import` never runs — you would get
> `File not found: <cwd>/claude:<id>` instead. `/resume` is matched by exact equality, so
> `/resume-session` reaches this extension.

## What it registers

| Kind | Name | Purpose |
|---|---|---|
| tool | `find_sessions` | Search both agents by content keywords, `cwd`, and recency. Returns refs like `codex:019ff377`. |
| tool | `import_session` | Convert a session into a pi session file. Does not switch sessions (tools cannot). |
| command | `/resume-session` | Keyword or ref → import → `switchSession` into it. |
| command | `/import-open` | Open the session imported most recently by the tool. |

### Options

- `--mode compact` (default) — user/assistant messages only.
- `--mode strict` — also include tool calls and tool results as text, truncated to 2000 chars each.
- `--turns N` — import only the last N turns. Default 60, max 400.

## How it works

| | Claude Code | Codex CLI |
|---|---|---|
| Source | `~/.claude/projects/**/*.jsonl` | `~/.codex/sessions/**/rollout-*.jsonl` |
| Metadata | parsed from the JSONL | `~/.codex/state_5.sqlite` (`threads`), falling back to a file walk |
| Search text | sampled from the transcript | sampled from the rollout, plus the thread title |

Transcript stores get large (GBs), so each session is indexed from its **first 32 KB and last 16 KB**, cached by mtime and size in `~/.pi/agent/cache/session-import-index.json`. A cold index over thousands of sessions takes a few seconds; later searches are sub-second. The trade-off: a keyword that appears only in the middle of a very long session will not match.

Harness-injected turns are stripped from both sides before import — `<system-reminder>`, `<task-notification>`, `[Request interrupted by user`, `<turn_aborted>`, `<recommended_plugins>`, `# AGENTS.md instructions`, and similar wrappers.

Imported sessions are written under the **current** working directory's pi session store (`~/.pi/agent/sessions/<cwd>/`). When the source session came from a different directory, the tool says so in its result.

## Limitations

- One way. Continuing in pi does not write anything back to Claude Code or Codex.
- Conversation text only. Tool execution state, file diffs, and checkpoints are not restored.
- The imported session records the model that was active when you ran the import, not the model the original session used.
- Requires Node's `node:sqlite` for the fast Codex path (Node 22.5+); without it the extension falls back to scanning rollout files.

## Development

```bash
npm install
npm test
```

The tests run on Node's built-in runner with type stripping (Node 22.18+ / 24+), against a
throwaway `$HOME` holding a synthetic Claude Code transcript — nothing reads or writes your
real `~/.claude`, `~/.codex`, or `~/.pi`.

## License

MIT
