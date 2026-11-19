/**
 * atlas-hooks — pi extension that ports atlas's Claude Code hooks to pi.
 *
 * Transport: spawns `atlas --hook` (Claude Code command-hook contract:
 * the event JSON on stdin, the answer JSON on stdout), one process per
 * event, exactly like Claude Code. pi events are translated to the
 * Claude Code event dialect and answers are translated back:
 *
 *   pi before_agent_start      -> UserPromptSubmit   (inject recall context)
 *   pi tool_call               -> PreToolUse         (deny / updatedInput)
 *   pi tool_result             -> PostToolUse        (digest big output)
 *   pi session_before_compact  -> PreCompact         (block)
 *   pi agent_before_settle     -> Stop               (journal/handoff nudge)
 *   pi session_shutdown        -> SessionEnd         (fire-and-forget)
 *
 * SubagentStart/SubagentStop have no pi equivalent (pi has codemode, not
 * subagents). SessionStart's context is skipped: pi has no injection point
 * before the first prompt; the first before_agent_start covers it.
 *
 * Fails open: any atlas failure, timeout, or missing binary leaves the
 * session untouched (same contract as the Claude hooks).
 *
 * Binary: $ATLAS_BIN, else ~/.pi/agent/atlas.bin, else the fork default.
 */
import { type ExtensionAPI, isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------- binary

function atlasBin(): string | null {
  const cands = [
    process.env.ATLAS_BIN,
    path.join(os.homedir(), ".pi", "agent", "atlas.bin"),
    process.platform === "win32"
      ? path.join(os.homedir(), "git", "atlas", "bin", "atlas.exe")
      : path.join(os.homedir(), "git", "atlas", "bin", "atlas"),
  ].filter((p): p is string => !!p);
  for (const p of cands) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

let BIN: string | null | undefined;
let toldMissing = false;

/** Run one hook event; resolves to the parsed answer or null (no-op). */
function hook(event: Record<string, unknown>, timeoutMs = 20000): Promise<any | null> {
  const bin = (BIN ??= atlasBin());
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(bin, ["--hook"], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) resolve(null);
        else {
          try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
        }
      });
    child.stdin!.write(JSON.stringify(event));
    child.stdin!.end();
  });
}

// ------------------------------------------------------- name mapping

const TOOL_NAME: Record<string, string> = {
  bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob",
};

/** pi tool input -> Claude Code tool input (only fields atlas reads). */
function toClaudeInput(name: string, input: any): any {
  switch (name) {
    case "bash": return { command: input.command ?? "" };
    case "read": return { file_path: input.path, offset: input.offset, limit: input.limit };
    case "write": return { file_path: input.path, content: input.content ?? "" };
    case "edit": return { file_path: input.path };
    case "grep": return { pattern: input.pattern, path: input.path ?? ".", glob: input.glob };
    case "glob": return { pattern: input.pattern, path: input.path ?? "." };
    default: return input;
  }
}

const textOf = (content: any[]): string =>
  (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");

// ---------------------------------------------------------------- main

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let cwd = process.cwd();
  let stopActive = false;   // atlas Stop-hook loop guard (stop_hook_active)
  let stopNudged = false;

  const base = (event: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: event,
    session_id: sessionId,
    cwd,
    transcript_path: "",   // pi sessions are not Claude transcripts
    ...extra,
  });

  const notify = (answer: any) => {
    if (answer?.systemMessage) ctxNotify(answer.systemMessage);
  };
  let notifyFn: ((msg: string, level?: "info" | "warning" | "error") => void) | null = null;
  const ctxNotify = (m: string) => { if (notifyFn) notifyFn(m, "info"); };

  pi.on("session_start", async (event, ctx) => {
    sessionId = (ctx.sessionManager as any).getSessionId?.() ?? "";
    cwd = ctx.sessionManager.getCwd?.() ?? process.cwd();
    notifyFn = ctx.ui.notify.bind(ctx.ui);
    stopActive = false; stopNudged = false;
    if (!atlasBin() && !toldMissing) {
      toldMissing = true;
      ctx.ui.notify("atlas-hooks: atlas binary not found (set ATLAS_BIN); hooks idle", "warning");
    }
  });

  // UserPromptSubmit: recall + rules arrive as a persistent custom message.
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    sessionId ||= (ctx.sessionManager as any).getSessionId?.() ?? "";
    const a = await hook(base("UserPromptSubmit", { prompt: event.prompt ?? "" }));
    notify(a);
    const extra = a?.hookSpecificOutput?.additionalContext;
    if (extra) {
      return {
        message: { customType: "atlas-context", content: extra, display: false },
      };
    }
  });

  // PreToolUse: deny -> block; updatedInput -> mutate input in place.
  pi.on("tool_call", async (event, ctx) => {
    const name = TOOL_NAME[event.toolName];
    if (!name) return;
    sessionId ||= (ctx.sessionManager as any).getSessionId?.() ?? "";
    const a = await hook(base("PreToolUse", {
      tool_name: name,
      tool_use_id: event.toolCallId,
      tool_input: toClaudeInput(event.toolName, event.input),
    }));
    notify(a);
    const out = a?.hookSpecificOutput;
    if (out?.permissionDecision === "deny") {
      return { block: true, reason: out.permissionDecisionReason || "blocked by atlas" };
    }
    const u = out?.updatedInput;
    if (u && typeof u === "object") {
      // Map the Claude-shaped updated input back onto pi's arguments.
      if (event.toolName === "read") {
        if (typeof u.offset === "number") event.input.offset = u.offset;
        if (typeof u.limit === "number") event.input.limit = u.limit;
      } else if (event.toolName === "bash" && typeof u.command === "string") {
        event.input.command = u.command;
      }
    }
  });

  // PostToolUse: the token-savings core. Send pi's result in Claude's tool
  // response shape; apply updatedToolOutput back onto pi's content blocks.
  pi.on("tool_result", async (event, ctx) => {
    const name = TOOL_NAME[event.toolName];
    if (!name) return;
    const input = toClaudeInput(event.toolName, event.input ?? {});
    const text = textOf(event.content as any[]);
    let resp: any = null;
    if (event.toolName === "bash") {
      resp = { stdout: text, stderr: "", interrupted: false };
      if (isBashToolResult(event) && (event as any).details?.exitCode !== undefined) {
        // atlas reads Claude's own failure marker; keep the exit code too.
        resp.exit_code = (event as any).details.exitCode;
      }
    } else if (event.toolName === "read") {
      const lines = text.split("\n").length;
      resp = { type: "text", file: { filePath: event.input?.path, content: text, numLines: lines, totalLines: lines, startLine: 1 } };
    } else if (event.toolName === "grep") {
      resp = { mode: "content", content: text, numFiles: 0, filenames: [] };
    } else if (event.toolName === "glob") {
      resp = { filenames: text ? text.split("\n") : [], durationMs: 0, numFiles: 0 };
    }
    if (!resp) {
      // Write/Edit: atlas only re-indexes the touched file; no answer needed.
      if (name === "Write" || name === "Edit") {
        await hook(base("PostToolUse", { tool_name: name, tool_use_id: event.toolCallId, tool_input: input, tool_response: {} }), 5000).catch(() => {});
      }
      return;
    }
    const a = await hook(base("PostToolUse", {
      tool_name: name,
      tool_use_id: event.toolCallId,
      tool_input: input,
      tool_response: resp,
    }));
    notify(a);
    const u = a?.hookSpecificOutput?.updatedToolOutput;
    if (!u) return;
    let newText: string | null = null;
    if (event.toolName === "bash" && typeof u.stdout === "string") newText = u.stdout;
    else if (event.toolName === "read") {
      const f = u.file;
      if (f && typeof f.content === "string") newText = f.content;
    } else if (event.toolName === "grep" && typeof u.content === "string") newText = u.content;
    else if (event.toolName === "glob" && Array.isArray(u.filenames)) newText = u.filenames.join("\n");
    if (newText !== null && newText !== text) {
      return { content: [{ type: "text", text: newText }] };
    }
  });

  // PreCompact: atlas may block the compaction (checkpoint safety).
  pi.on("session_before_compact", async (event, ctx) => {
    const a = await hook(base("PreCompact", {
      trigger: event.reason === "manual" ? "manual" : "auto",
    }));
    if (a?.decision === "block") {
      ctx.ui.notify(`atlas: compaction blocked — ${a.reason ?? ""}`, "warning");
      return { cancel: true };
    }
  });

  // Stop: journal/handoff nudge. atlas answers {decision:"block",reason};
  // pi's actionable boundary is agent_before_settle: inject the reason as
  // a custom message and request exactly one continuation. Once per run.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (stopNudged) return;
    const a = await hook(base("Stop", { stop_hook_active: stopActive }));
    if (a?.decision === "block" && a.reason) {
      stopNudged = true;
      stopActive = true; // atlas sees stop_hook_active on the next Stop
      return {
        entries: [...(event.entries ?? []), {
          type: "custom_message",
          customType: "atlas-stop",
          content: a.reason,
          display: false,
        }],
        continue: true,
      };
    }
  });

  pi.on("agent_start", async () => { stopNudged = false; });

  // SessionEnd: fire-and-forget (journal housekeeping).
  pi.on("session_shutdown", async (event) => {
    hook(base("SessionEnd", { reason: event.reason === "new" ? "clear" : "other" }), 8000).catch(() => {});
  });
}
