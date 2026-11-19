/**
 * atlas-hooks — opencode plugin porting atlas's Claude Code hooks to opencode.
 *
 * Transport: spawns `atlas --hook` (Claude Code command-hook contract: the
 * event JSON on stdin, the answer JSON on stdout), one process per event.
 *
 *   session.hook("prompt")            -> UserPromptSubmit (recall context appended to the prompt)
 *   tool.hook("execute.before")       -> PreToolUse       (deny = throw; updatedInput = mutate input)
 *   tool.hook("execute.after")        -> PostToolUse      (digest big output via result.output)
 *   session.hook("compaction")        -> PreCompact       (summary instructions)
 *   session.hook("experimental.idle") -> Stop             (journal/handoff nudge via session.prompt)
 *
 * Written against the opencode 2.x plugin context (the promise bridge).
 * Fails open: any atlas failure, timeout, or missing binary leaves the
 * session untouched.
 *
 * Binary: $ATLAS_BIN, else ~/.config/opencode/atlas.bin, else the fork default.
 * Install: this file at ~/.config/opencode/plugins/atlas-hooks.ts
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function atlasBin(): string | null {
  const cands = [
    process.env.ATLAS_BIN,
    path.join(os.homedir(), ".config", "opencode", "atlas.bin"),
    process.platform === "win32"
      ? path.join(os.homedir(), "git", "atlas", "bin", "atlas.exe")
      : path.join(os.homedir(), "git", "atlas", "bin", "atlas"),
  ].filter((p): p is string => !!p);
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function hook(event: Record<string, unknown>, timeoutMs = 20000): Promise<any | null> {
  const bin = atlasBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(bin, ["--hook"], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) resolve(null);
        else { try { resolve(JSON.parse(stdout)); } catch { resolve(stdout.trim()); } }
      });
    child.stdin!.write(JSON.stringify(event));
    child.stdin!.end();
  });
}

// opencode tools return result.output as either a string (older shapes) or a
// tool-specific object: shell -> {exitCode, output}, read -> {content, ...},
// etc. Reach through both shapes; write back in place.
function outText(e: any): string | null {
  const o = e?.result?.output;
  if (typeof o === "string") return o;
  if (o && typeof o === "object") {
    if (typeof o.output === "string") return o.output;
    if (typeof o.content === "string") return o.content;
  }
  return null;
}

function setOut(e: any, text: string): void {
  const o = e?.result?.output;
  if (typeof o === "string") { e.result.output = text; }
  else if (o && typeof o === "object") {
    if (typeof o.output === "string") { o.output = text; }
    else if (typeof o.content === "string") { o.content = text; }
  }
  // The model-facing parts come from result.content; rewrite those too.
  const parts = e?.result?.content;
  if (Array.isArray(parts)) {
    const i = parts.findIndex((p: any) => p && p.type === "text");
    if (i >= 0) parts[i] = { type: "text", text };
    else parts.unshift({ type: "text", text });
  }
}

const CLAUDE: Record<string, string> = {
  bash: "Bash", shell: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob",
};

function toClaudeInput(tool: string, args: any): any {
  switch (tool) {
    case "bash": case "shell": return { command: args?.command ?? "" };
    case "read": return { file_path: args?.filePath ?? args?.file_path, offset: args?.offset, limit: args?.limit };
    case "write": return { file_path: args?.filePath ?? args?.file_path, content: args?.content ?? "" };
    case "edit": return { file_path: args?.filePath ?? args?.file_path };
    case "grep": return { pattern: args?.pattern, path: args?.path ?? ".", glob: args?.include };
    case "glob": return { pattern: args?.pattern, path: args?.path ?? "." };
    default: return args ?? {};
  }
}

export default {
  id: "atlas-hooks",
  setup: async (input: any) => {
    let stopActive = false; // atlas Stop-hook loop guard; a new prompt re-arms

    const base = (sessionID: string, event: string, extra: Record<string, unknown> = {}) => ({
      hook_event_name: event,
      session_id: sessionID,
      cwd: process.cwd(),
      transcript_path: "",
      ...extra,
    });

    // UserPromptSubmit: recall context rides along with the prompt (once).
    await input.session.hook("prompt", async (e: any) => {
      stopActive = false;
      const text = e?.prompt?.text ?? "";
      if (!text.trim()) return;
      const a = await hook(base(e.sessionID, "UserPromptSubmit", { prompt: text }));
      const extra = a?.hookSpecificOutput?.additionalContext;
      if (extra) e.prompt.text = text + `\n\n<atlas-context>\n${extra}\n</atlas-context>`;
    });

    // PreToolUse: deny -> throw; updatedInput -> mutate input.
    await input.tool.hook("execute.before", async (e: any) => {
      const name = CLAUDE[e.tool];
      if (!name) return;
      const a = await hook(base(e.sessionID, "PreToolUse", {
        tool_name: name,
        tool_use_id: e.id,
        tool_input: toClaudeInput(e.tool, e.input),
      }));
      const out = a?.hookSpecificOutput;
      if (out?.permissionDecision === "deny") {
        throw new Error(`atlas: ${out.permissionDecisionReason || "tool blocked"}`);
      }
      const u = out?.updatedInput;
      if (u && typeof u === "object" && e.input) {
        if (e.tool === "read") {
          if (typeof u.offset === "number") e.input.offset = u.offset;
          if (typeof u.limit === "number") e.input.limit = u.limit;
        } else if ((e.tool === "bash" || e.tool === "shell") && typeof u.command === "string") {
          e.input.command = u.command;
        }
      }
    });

    // PostToolUse: the digest. Send opencode output in Claude's response
    // shapes; write the replacement back onto result.output.
    await input.tool.hook("execute.after", async (e: any) => {
      const name = CLAUDE[e.tool];
      if (!name) return;
      const args = toClaudeInput(e.tool, e.input);
      const text = outText(e) ?? "";
      if (e?.status === "error") return;
      let resp: any = null;
      if (e.tool === "bash" || e.tool === "shell") resp = { stdout: text, stderr: "", interrupted: false };
      else if (e.tool === "read") {
        const lines = text.split("\n").length;
        resp = { type: "text", file: { filePath: e.input?.filePath ?? e.input?.file_path, content: text, numLines: lines, totalLines: lines, startLine: 1 } };
      } else if (e.tool === "grep") resp = { mode: "content", content: text, numFiles: 0, filenames: [] };
      else if (e.tool === "glob") resp = { filenames: text ? text.split("\n") : [], durationMs: 0, numFiles: 0 };
      if (!resp) {
        if (name === "Write" || name === "Edit") {
          await hook(base(e.sessionID, "PostToolUse", { tool_name: name, tool_use_id: e.id, tool_input: args, tool_response: {} }), 5000).catch(() => {});
        }
        return;
      }
      const a = await hook(base(e.sessionID, "PostToolUse", {
        tool_name: name, tool_use_id: e.id, tool_input: args, tool_response: resp,
      }));
      const u = a?.hookSpecificOutput?.updatedToolOutput;
      if (!u) return;
      let newText: string | null = null;
      if (e.tool === "bash" || e.tool === "shell") {
        if (typeof u.stdout === "string") newText = u.stdout + (typeof u.stderr === "string" && u.stderr ? "\n" + u.stderr : "");
      } else if (e.tool === "read" && u.file && typeof u.file.content === "string") newText = u.file.content;
      else if (e.tool === "grep" && typeof u.content === "string") newText = u.content;
      else if (e.tool === "glob" && Array.isArray(u.filenames)) newText = u.filenames.join("\n");
      if (newText !== null) setOut(e, newText);
    });

    // PreCompact: atlas's plain-text reply is compaction instructions.
    await input.session.hook("compaction", async (e: any) => {
      const a = await hook(base(e.sessionID, "PreCompact", { trigger: "auto" }));
      const text = typeof a === "string" ? a : a?.hookSpecificOutput?.additionalContext;
      if (!text || !String(text).trim()) return;
      const trimmed = String(text).trim();
      if (Array.isArray(e.context)) e.context.push(trimmed);
      else if (typeof e.context === "string") e.context = e.context + "\n" + trimmed;
    });

    // Stop: journal/handoff nudge. On block, prompt the session to continue.
    await input.session.hook("experimental.idle", async (e: any) => {
      const sessionID = e?.sessionID;
      if (!sessionID || stopActive) return;
      stopActive = true; // one attempt per idle; atlas sees stop_hook_active next
      const a = await hook(base(sessionID, "Stop", { stop_hook_active: false }));
      if (a?.decision === "block" && a.reason) {
        await Promise.resolve(input.session.prompt({
          sessionID,
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: `<atlas-stop>\n${a.reason}\n</atlas-stop>` }] },
        })).catch(() => {});
      }
    });
  },
};
