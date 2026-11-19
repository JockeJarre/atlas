# atlas on pi and opencode (Linux + Windows)

This fork adapts [bloodfeast/atlas](https://github.com/bloodfeast/atlas) — a local, stdio-only MCP
server for project memory and token savings — for **pi** and **opencode**, on **Linux** and **Windows**.

Upstream ships atlas as a Claude Code plugin. Everything that matters for pi/opencode is the MCP
server itself, and it works out of the box:

- `bin/atlas` (Linux/macOS launcher) and `bin/atlas.exe` (Windows) are prebuilt; no Rust needed.
- No-args = MCP stdio server. Speaks MCP 2024-11-05, tools + resources, no network at query time.
- 13 model-facing tools (`hook` is Claude-Code-only and should be hidden; see pi config).

**Not ported:** the Claude Code hooks (`hooks/hooks.json`, SessionStart/PreToolUse/…) and the
Claude plugin marketplace install. You get the full MCP tool surface; you do not get automatic
output-digesting hooks or session-start injection. That is the current scope of this fork.

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
