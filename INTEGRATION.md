# atlas on pi and opencode (Linux + Windows)

This fork adapts [bloodfeast/atlas](https://github.com/bloodfeast/atlas) — a local, stdio-only MCP
server for project memory and token savings — for **pi** and **opencode**, on **Linux** and **Windows**.

Upstream ships atlas as a Claude Code plugin. Everything that matters for pi/opencode is the MCP
server itself, and it works out of the box:

- `bin/atlas` (Linux/macOS launcher) and `bin/atlas.exe` (Windows) are prebuilt; no Rust needed.
- No-args = MCP stdio server. Speaks MCP 2024-11-05, tools + resources, no network at query time.
- 13 model-facing tools (`hook` is Claude-Code-only and should be hidden; see pi config).

**Hooks:** the Claude Code command hooks are not needed — this fork ships adapters that speak
atlas's hook protocol (`atlas --hook`: event JSON on stdin, answer JSON on stdout) from pi
extensions and opencode plugins: see section 7.

## 1. Get the binary

```bash
# Linux
git clone https://github.com/JockeJarre/atlas.git ~/git/atlas
# smoke test (prints a tools/list response)
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | ~/git/atlas/bin/atlas
```

```powershell
# Windows (Git for Windows / PowerShell)
git clone https://github.com/JockeJarre/atlas.git $env:USERPROFILE\git\atlas
# the binary is bin\atlas.exe; run the same handshake piping into it
```

On first run atlas writes a starter `atlas.json` and starts a background download of the ~35 MB
embedding model (SHA-256-pinned). Search is lexical until the model lands. Config location:

| OS | config file |
|---|---|
| Linux | `~/.config/atlas/atlas.json` |
| Windows | `%APPDATA%\atlas\atlas.json` |
| macOS | `~/Library/Application Support/atlas/atlas.json` |

Edit `vaults` to point at your Markdown folders (absolute paths are safest):

```json
{ "vaults": [ { "name": "notes", "path": "/home/you/docs" } ], ... }
```

A vault is any folder of `.md` files; Obsidian is not required. See `wiki/Configuration-reference.md`.

### Install on PATH (recommended)

Point the harnesses at a stable path instead of the checkout. Link **the per-arch binary**, not the
`bin/atlas` launcher script — the launcher resolves its siblings by its own directory, so a symlink
to it breaks:

```bash
ln -s ~/git/atlas/bin/atlas-$(uname -m)-unknown-linux-gnu ~/.local/bin/atlas
ln -s ~/git/atlas/bin/atlas-$(uname -m)-unknown-linux-gnu ~/.pi/agent/atlas.bin       # pi adapter default
ln -s ~/git/atlas/bin/atlas-$(uname -m)-unknown-linux-gnu ~/.config/opencode/atlas.bin # opencode adapter default
```

Then use `~/.local/bin/atlas` as the MCP command in both configs. On Windows, symlinks need
Developer Mode / admin; copying `bin\atlas.exe` to a folder on PATH (e.g. `%USERPROFILE%\.local\bin\atlas.exe`)
or `mklink /H` (hard link, same volume) works too.

## 2. pi

Add to `~/.pi/agent/mcp.json` (same file on Windows; write Windows paths with `\\`):

```json
{
  "mcpServers": {
    "atlas": {
      "command": "/home/you/git/atlas/bin/atlas",
      "description": "Project memory and token-lean search over Markdown vaults and code: lookup, search, section, grep, symbol, recall, remember, journal, handoff.",
      "toolExposure": { "hook": "hidden" }
    }
  }
}
```

Windows:

```json
{ "command": "C:\\Users\\you\\git\\atlas\\bin\\atlas.exe" }
```

Check:

```bash
pi mcp list        # expect: atlas: connected, 14 tools, hook [hidden]
```

Inside a session: `/mcp` shows status. Default exposure is `codemode` (tools reachable from
codemode scripts, keeping the tool list out of context — which is the point of atlas). If you want
the tools declared directly to the model, add `"exposure": "direct"`; `deferred` loads them via
`tool_search`.

## 3. opencode

Global config — `~/.config/opencode/opencode.jsonc` (or `opencode.json`; Windows:
`C:\Users\you\.config\opencode\opencode.json`):

```jsonc
"mcp": {
  "atlas": {
    "type": "local",
    "command": ["/home/you/git/atlas/bin/atlas"],   // Windows: ["C:\\Users\\you\\git\\atlas\\bin\\atlas.exe"]
    "enabled": true,
    "timeout": 20000
  }
}
```

A project-level `opencode.json` with the same block works too and overrides the global entry.

Verified quirk (v2.3.2): `opencode mcp list` only reports **project-level** servers. A server
defined in the global config is invisible there but **works in sessions** — the tools appear as
`atlas_search`, `atlas_recall`, … (see the smoke test in section 5).

## 4. Tool map

| tool | what it is for |
|---|---|
| `lookup` | where an identifier is defined/mentioned |
| `search` | substring/regex/fts/sections/semantic/hybrid over vaults + sources |
| `section` | one section's exact text (cheap read) |
| `grep` | regex over indexed files, with context |
| `symbol` | code symbols (needs SCIP index; see wiki/Code-index.md) |
| `recall` | memory by key/query/lane |
| `remember` | store rules and decisions |
| `journal` | append lane journal entries |
| `handoff` | write a lane handoff before ending a session |
| `note` / `edit` | read / write vault notes |
| `discuss` | discussion threads + decision queue |
| `miss` | report what atlas failed to return |
| `hook` | Claude Code only — hide it (pi: `toolExposure`; opencode: ignore it) |

Server instructions and the `atlas://help` resource carry the usage habits.

## 5. Smoke tests

Raw handshake (any OS; Windows: `bin\atlas.exe`):

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"token savings","mode":"fts","limit":3}}}' \
 | bin/atlas
```

pi: `pi mcp list`, then in a session ask for `search mode=fts` over your vault.

opencode:

```bash
opencode run 'Call the tool atlas_search with {"query":"token savings","mode":"fts","limit":3}'
```

## 6. Troubleshooting

- `atlas: this release has no prebuilt binary for …` → build: `cargo build --release --locked`,
  copy `target/release/atlas` to `bin/atlas-x86_64-unknown-linux-gnu` (or the aarch64 name).
- pi: connection errors and stderr tails show in `/mcp`; server logs in `~/.pi/agent/mcp.log`.
- opencode: `opencode mcp list` (project scope only, see above); run with `--print-logs` for server stderr.
- First search feels lexical only → embedding model still downloading; watch stderr.
- `atlas: models: another atlas process is downloading models now` → harmless; one downloader at a time.

## 7. Hook adapters (pi extension, opencode plugin)

Two adapters translate each harness's events into atlas hook events and map the answers back:

| adapter | file | injects recall context | digests big tool output | blocks tools | compaction notes | stop nudge |
|---|---|---|---|---|---|---|
| pi extension | `adapters/pi/atlas-hooks.ts` | ✓ (before_agent_start) | ✓ (tool_result: bash/read/grep/glob) | ✓ (tool_call deny) | ✓ (block compaction) | ✓ (one continuation) |
| opencode plugin | `adapters/opencode/atlas-hooks.ts` | ✓ (session prompt hook) | ✓ (execute.after: shell/read/grep/glob) | ✓ (throw) | best effort | ✓ (session.prompt) |

Both fail open: missing binary, atlas error, or timeout leaves the session untouched.

### pi

```bash
cp ~/git/atlas/adapters/pi/atlas-hooks.ts ~/.pi/agent/extensions/     # Windows: %USERPROFILE%\.pi\agent\extensions\
```

The extension finds the binary at `$ATLAS_BIN`, `~/.pi/agent/atlas.bin`, or `~/git/atlas/bin/atlas`
(`bin\atlas.exe` on Windows). pi loads `.ts` extensions directly; no build step.

### opencode

```bash
mkdir -p ~/.config/opencode/plugins
cp ~/git/atlas/adapters/opencode/atlas-hooks.ts ~/.config/opencode/plugins/
# Windows: C:\Users\you\.config\opencode\plugins\
```

Binary lookup: `$ATLAS_BIN`, `~/.config/opencode/atlas.bin`, `~/git/atlas/bin/atlas(.exe)`.
The plugin targets the **opencode 2.x** plugin API (`{id, setup}` default export, `tool.hook`
/ `session.hook` on the promise bridge) — verified on v2.3.2. The recall context rides along
with the submitted prompt inside an `<atlas-context>` block (visible in the transcript; that is
the prompt hook, not a hidden injection). Large shell output is digested to a few hundred bytes
with an atlas handle (`h:…`), which `recall op=log` can page back in.

### Verifying

Seed a memory that matches a prompt, e.g. via the MCP tools: `remember kind=rule key=test title="pi adapter test ruling"`.
Then ask the harness something that matches the rule's phrases — the answer should reference it.
For the digest: ask it to run `seq 1 20000` — the tool result should come back as a short digest
starting with an `h:` handle, not thousands of lines.
