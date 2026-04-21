const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const path = require("path");
const { dbPath, defaultSource, getSupabaseKey, requireSupabaseEnv, supabaseUrl } = require("./config");
const { DashboardCommandCenter } = require("./dashboard-command-center");
const { importHistory } = require("./history-import");
const { LocalStore } = require("./local-store");
const { writeNativeMirror } = require("./native-writeback");
const { createSupabaseSync } = require("./supabase-sync");

function nowIso() {
  return new Date().toISOString();
}

function parseMetadata(raw) {
  if (!raw) {
    return {};
  }

  if (typeof raw === "object") {
    return raw;
  }

  return JSON.parse(raw);
}

function ensureConversation(store, conversationId, title, metadata = {}) {
  const existing = store.getConversation(conversationId);

  if (existing) {
    if (existing.deleted_at) {
      store.restoreConversation(conversationId);
    }
    return;
  }

  const timestamp = nowIso();
  store.createConversation({
    id: conversationId,
    title: title || conversationId,
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function addMessageToStore(store, body) {
  const conversationId = body.conversation;
  const content = body.content;

  if (!conversationId || !content) {
    throw new Error("conversation dan content wajib diisi.");
  }

  ensureConversation(store, conversationId, body.title, parseMetadata(body.metadata));

  const timestamp = nowIso();

  store.addMessage({
    id: body.id || crypto.randomUUID(),
    conversationId,
    source: body.source || defaultSource,
    role: body.role || "assistant",
    content,
    metadata: parseMetadata(body.metadata),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return { conversationId };
}

function createDashboardServer({ port = 3030 } = {}) {
  const store = new LocalStore(dbPath);
  store.init();
  const commandCenter = new DashboardCommandCenter({
    projectRoot: path.resolve(__dirname, ".."),
  });

  function json(response, statusCode, payload) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload, null, 2));
  }

  async function runSync() {
    requireSupabaseEnv();
    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });
    try {
      return await sync.syncOnce(store);
    } finally {
      await sync.close();
    }
  }

  async function runPushOnly() {
    requireSupabaseEnv();
    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });
    try {
      return await sync.pushLocalChanges(store);
    } finally {
      await sync.close();
    }
  }

  async function handleAction(action, body) {
    if (action === "backfill") {
      const result = importHistory(store, {
        source: body.source || "all",
        full: Boolean(body.full),
      });

      if (body.push) {
        return {
          action,
          ...result,
          push: await runPushOnly(),
        };
      }

      return { action, ...result };
    }

    if (action === "sync") {
      return {
        action,
        result: await runSync(),
      };
    }

    if (action === "create-conversation") {
      const id = body.id || crypto.randomUUID();
      const title = body.title || id;
      const timestamp = nowIso();
      store.createConversation({
        id,
        title,
        metadata: parseMetadata(body.metadata),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      return { action, conversationId: id };
    }

    if (action === "add-message") {
      return {
        action,
        ...addMessageToStore(store, body),
      };
    }

    if (action === "send-message") {
      const result = addMessageToStore(store, body);
      return {
        action,
        ...result,
        push: await runPushOnly(),
      };
    }

    if (action === "delete-conversation") {
      if (!body.conversation) {
        throw new Error("conversation wajib diisi.");
      }

      store.deleteConversation(body.conversation);
      return {
        action,
        conversationId: body.conversation,
        push: body.push ? await runPushOnly() : null,
      };
    }

    if (action === "restore-conversation") {
      if (!body.conversation) {
        throw new Error("conversation wajib diisi.");
      }

      store.restoreConversation(body.conversation);
      return {
        action,
        conversationId: body.conversation,
        push: body.push ? await runPushOnly() : null,
      };
    }

    if (action === "native-writeback") {
      if (!body.target) {
        throw new Error("target wajib diisi.");
      }

      return {
        action,
        result: writeNativeMirror(store, {
          target: body.target,
          conversationId: body.conversation || "",
          full: Boolean(body.full),
          codexHome: body.codexHome || "",
          claudeHome: body.claudeHome || "",
          projectName: body.projectName || "",
        }),
      };
    }

    if (action === "pull-native") {
      if (!body.target) {
        throw new Error("target wajib diisi.");
      }

      const sync = await runSync();
      const writeback = writeNativeMirror(store, {
        target: body.target,
        conversationId: body.conversation || "",
        full: Boolean(body.full),
        codexHome: body.codexHome || "",
        claudeHome: body.claudeHome || "",
        projectName: body.projectName || "",
      });

      return {
        action,
        sync,
        writeback,
      };
    }

    throw new Error(`Action tidak dikenal: ${action}`);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(getDashboardHtml());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/summary") {
        json(response, 200, {
          db_path: dbPath,
          summary: store.getSummary(),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/conversations") {
        const query = requestUrl.searchParams.get("query") || "";
        const source = requestUrl.searchParams.get("source") || "";
        const includeDeleted = requestUrl.searchParams.get("includeDeleted") === "true";
        json(response, 200, {
          conversations: store.listConversationsForDashboard({
            query,
            source,
            includeDeleted,
            limit: Number(requestUrl.searchParams.get("limit") || 200),
          }),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/commands") {
        json(response, 200, {
          presets: commandCenter.listPresets(),
          jobs: commandCenter.listJobs(),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/conversations/")) {
        const conversationId = decodeURIComponent(requestUrl.pathname.replace("/api/conversations/", ""));
        const includeDeleted = requestUrl.searchParams.get("includeDeleted") === "true";
        const conversation = store.getConversation(conversationId, { includeDeleted: true });

        if (!conversation) {
          json(response, 404, { error: "Conversation tidak ditemukan." });
          return;
        }

        json(response, 200, {
          conversation,
          transcript: store.getTranscript(conversationId, { includeDeleted }),
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/actions") {
        const chunks = [];

        for await (const chunk of request) {
          chunks.push(chunk);
        }

        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        const result = await handleAction(body.action, body);
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/commands/run") {
        const chunks = [];

        for await (const chunk of request) {
          chunks.push(chunk);
        }

        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        const result = await commandCenter.runPreset(body.presetId, {
          conversationId: body.conversationId || "",
          projectName: body.projectName || "",
          codexHome: body.codexHome || "",
          claudeHome: body.claudeHome || "",
          full: Boolean(body.full),
        });
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname.startsWith("/api/commands/") && requestUrl.pathname.endsWith("/stop")) {
        const jobId = decodeURIComponent(requestUrl.pathname.replace("/api/commands/", "").replace("/stop", ""));
        json(response, 200, await commandCenter.stopJob(jobId));
        return;
      }

      json(response, 404, { error: "Route tidak ditemukan." });
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });

  return {
    listen() {
      server.listen(port, () => {
        console.log(`Dashboard aktif di http://localhost:${port}`);
      });
    },
  };
}

function getDashboardHtml() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dashboard Sinkron Codex dan Claude</title>
    <style>
      :root {
        --bg: #f3f4f6;
        --bg-accent: #eef6f3;
        --surface: rgba(255, 255, 255, 0.86);
        --surface-strong: rgba(255, 255, 255, 0.96);
        --surface-soft: rgba(248, 250, 252, 0.88);
        --text: #14213d;
        --muted: #5f6b85;
        --line: rgba(20, 33, 61, 0.1);
        --line-strong: rgba(20, 33, 61, 0.16);
        --primary: #0f766e;
        --primary-strong: #115e59;
        --secondary: #c2410c;
        --danger: #b91c1c;
        --warning: #ca8a04;
        --shadow-soft: 0 14px 40px rgba(15, 23, 42, 0.08);
        --shadow-strong: 0 24px 70px rgba(15, 23, 42, 0.14);
        --radius-xl: 28px;
        --radius-lg: 22px;
        --radius-md: 16px;
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        font-family: Inter, "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.12), transparent 28%),
          radial-gradient(circle at top right, rgba(194, 65, 12, 0.1), transparent 24%),
          linear-gradient(180deg, #f8fafc 0%, #f1f5f9 34%, #eef6f3 100%);
        min-height: 100vh;
      }
      *::-webkit-scrollbar {
        width: 11px;
        height: 11px;
      }
      *::-webkit-scrollbar-thumb {
        background: rgba(95, 107, 133, 0.34);
        border-radius: 999px;
        border: 3px solid transparent;
        background-clip: padding-box;
      }
      *::-webkit-scrollbar-track { background: transparent; }
      .shell {
        width: min(1640px, calc(100vw - 24px));
        margin: 12px auto 28px;
        display: grid;
        gap: 16px;
      }
      .hero, .panel, .modal-card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(18px);
      }
      .hero {
        position: relative;
        overflow: hidden;
        padding: 28px;
        display: grid;
        grid-template-columns: minmax(0, 1.12fr) minmax(360px, 0.88fr);
        gap: 22px;
      }
      .hero::after {
        content: "";
        position: absolute;
        inset: auto -90px -120px auto;
        width: 300px;
        height: 300px;
        background: radial-gradient(circle, rgba(15, 118, 110, 0.18), transparent 66%);
        pointer-events: none;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        color: var(--primary);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 14px 0 12px;
        font-size: clamp(2.2rem, 3vw, 3.3rem);
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      .lead, .panel-head p, .footnote, .meta, .small, .job-meta, .command-text, .command-agent-head p, .command-hero p {
        color: var(--muted);
      }
      .lead {
        margin: 0;
        font-size: 15px;
        line-height: 1.72;
        max-width: 64ch;
      }
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 22px;
      }
      .hero-note {
        display: grid;
        gap: 10px;
        align-content: start;
      }
      .hero-note-card {
        padding: 16px 18px;
        border-radius: 20px;
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(244, 247, 250, 0.92));
        border: 1px solid rgba(20, 33, 61, 0.08);
      }
      .hero-note-card strong {
        display: block;
        margin-bottom: 6px;
        font-size: 14px;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .stat {
        padding: 16px 18px;
        border-radius: 20px;
        background: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(246,248,251,0.92));
        border: 1px solid rgba(20, 33, 61, 0.08);
      }
      .stat span {
        display: block;
        font-size: 12px;
        color: var(--muted);
      }
      .stat strong {
        display: block;
        margin-top: 8px;
        font-size: 1.18rem;
        line-height: 1.3;
      }
      .workspace {
        display: grid;
        grid-template-columns: 340px minmax(0, 1fr) 430px;
        gap: 16px;
        align-items: start;
      }
      .panel {
        overflow: hidden;
        min-height: 220px;
      }
      .panel.sticky-panel {
        position: sticky;
        top: 12px;
      }
      .panel-head {
        padding: 20px 20px 16px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(248,250,252,0.84));
      }
      .panel-head h2 {
        margin: 0 0 6px;
        font-size: 1.08rem;
      }
      .sidebar-tools, .actions {
        padding: 16px 18px;
        display: grid;
        gap: 12px;
        border-bottom: 1px solid var(--line);
      }
      .sidebar-tools {
        background: rgba(248, 250, 252, 0.66);
      }
      .conversation-list, .transcript, .action-scroll {
        max-height: calc(100vh - 220px);
        overflow: auto;
      }
      .conversation-list {
        padding: 10px;
      }
      .conversation {
        margin-bottom: 10px;
        padding: 16px 16px 14px;
        border: 1px solid transparent;
        border-radius: 20px;
        cursor: pointer;
        transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      }
      .conversation:hover {
        transform: translateY(-1px);
        border-color: rgba(15, 118, 110, 0.18);
        background: rgba(255,255,255,0.8);
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
      }
      .conversation.active {
        background: linear-gradient(135deg, rgba(15,118,110,0.12), rgba(255,255,255,0.88));
        border-color: rgba(15, 118, 110, 0.22);
      }
      .conversation.deleted strong {
        text-decoration: line-through;
        color: #8b3a3a;
      }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .pill, .command-badge, .section-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }
      .pill {
        background: rgba(20, 33, 61, 0.05);
      }
      .pill.deleted {
        background: rgba(185, 28, 28, 0.1);
        color: var(--danger);
      }
      button, select, input, textarea {
        border: 1px solid var(--line-strong);
        background: rgba(255,255,255,0.96);
        color: var(--text);
        border-radius: 16px;
        padding: 12px 14px;
        font: inherit;
        width: 100%;
        transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
      }
      input:focus, select:focus, textarea:focus {
        outline: none;
        border-color: rgba(15, 118, 110, 0.45);
        box-shadow: 0 0 0 4px rgba(15, 118, 110, 0.12);
      }
      textarea {
        min-height: 112px;
        resize: vertical;
        line-height: 1.55;
      }
      button {
        cursor: pointer;
        font-weight: 700;
        background: rgba(255,255,255,0.96);
      }
      button:hover { transform: translateY(-1px); }
      button.primary {
        background: linear-gradient(135deg, var(--primary), var(--primary-strong));
        color: white;
        border-color: transparent;
        box-shadow: 0 14px 28px rgba(15, 118, 110, 0.22);
      }
      button.accent {
        background: linear-gradient(135deg, #ea580c, var(--secondary));
        color: white;
        border-color: transparent;
        box-shadow: 0 14px 28px rgba(194, 65, 12, 0.2);
      }
      button.danger {
        background: linear-gradient(135deg, var(--danger), #991b1b);
        color: white;
        border-color: transparent;
      }
      button.ghost {
        background: rgba(255,255,255,0.84);
      }
      .button-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .transcript {
        padding: 18px;
        display: grid;
        gap: 14px;
        background: linear-gradient(180deg, rgba(249,250,251,0.58), rgba(255,255,255,0.72));
      }
      .message {
        padding: 16px 18px;
        border-radius: 22px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.9);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
      }
      .message.user { border-left: 6px solid var(--warning); }
      .message.assistant { border-left: 6px solid var(--primary); }
      .message.deleted { opacity: 0.6; border-style: dashed; }
      .message-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 10px;
        font-size: 12px;
        color: var(--muted);
      }
      .message-body {
        white-space: pre-wrap;
        line-height: 1.72;
        font-size: 14px;
      }
      .placeholder {
        padding: 26px;
        border-radius: 18px;
        color: var(--muted);
        background: rgba(248,250,252,0.7);
        border: 1px dashed rgba(20, 33, 61, 0.14);
      }
      .result-box, .job-log {
        margin-top: 10px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(248, 250, 252, 0.9);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        overflow: auto;
      }
      .job-list {
        display: grid;
        gap: 12px;
      }
      .job-card {
        border: 1px solid var(--line);
        border-radius: 20px;
        background: rgba(255,255,255,0.86);
        padding: 14px;
      }
      .job-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: start;
        margin-bottom: 10px;
      }
      .job-actions {
        display: flex;
        gap: 8px;
        min-width: 92px;
      }
      .command-center {
        display: grid;
        gap: 16px;
      }
      .command-hero {
        padding: 16px 18px;
        border-radius: 20px;
        border: 1px solid rgba(15, 118, 110, 0.16);
        background: linear-gradient(135deg, rgba(15, 118, 110, 0.08), rgba(255,255,255,0.96));
      }
      .command-hero h3 {
        margin: 0 0 8px;
        font-size: 1.02rem;
      }
      .command-inputs {
        display: grid;
        gap: 12px;
        padding: 16px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: rgba(248,250,252,0.76);
      }
      .command-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .command-agent {
        border-radius: 24px;
        padding: 16px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.88);
        display: grid;
        gap: 14px;
      }
      .command-agent.codex {
        border-color: rgba(15, 118, 110, 0.18);
        background: linear-gradient(180deg, rgba(15, 118, 110, 0.07), rgba(255,255,255,0.92));
      }
      .command-agent.claude {
        border-color: rgba(194, 65, 12, 0.18);
        background: linear-gradient(180deg, rgba(194, 65, 12, 0.07), rgba(255,255,255,0.92));
      }
      .command-agent-head h3 {
        margin: 0;
        font-size: 1rem;
      }
      .command-grid {
        display: grid;
        gap: 12px;
      }
      .command-card {
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 14px;
        background: rgba(255,255,255,0.9);
        display: grid;
        gap: 12px;
      }
      .command-card-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 10px;
      }
      .command-card-head strong {
        display: block;
        font-size: 15px;
        line-height: 1.35;
      }
      .command-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
      }
      .command-badge {
        border: 1px solid var(--line);
        background: rgba(20, 33, 61, 0.05);
      }
      .command-badge.kind-background {
        background: rgba(194, 65, 12, 0.12);
        color: var(--secondary);
      }
      .command-badge.kind-foreground {
        background: rgba(15, 118, 110, 0.1);
        color: var(--primary);
      }
      .command-help {
        padding: 12px 13px;
        border-radius: 16px;
        background: rgba(20, 33, 61, 0.04);
        font-size: 12px;
        line-height: 1.6;
      }
      .footnote { margin-top: 12px; font-size: 12px; }
      details.action-card {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: rgba(255,255,255,0.74);
        padding: 12px;
      }
      details.action-card[open] {
        background: rgba(255,255,255,0.94);
        box-shadow: 0 10px 26px rgba(15, 23, 42, 0.06);
      }
      details.action-card summary {
        cursor: pointer;
        font-weight: 800;
        font-size: 14px;
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      details.action-card summary::-webkit-details-marker { display: none; }
      details.action-card summary::after {
        content: "+";
        width: 28px;
        height: 28px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(15, 118, 110, 0.08);
        color: var(--primary);
        font-size: 18px;
        font-weight: 600;
      }
      details.action-card[open] summary::after { content: "−"; }
      .action-body {
        display: grid;
        gap: 12px;
        margin-top: 14px;
      }
      .section-note {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(15, 118, 110, 0.06);
        font-size: 13px;
        line-height: 1.6;
      }
      .section-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .section-chip {
        background: rgba(15, 118, 110, 0.08);
        color: var(--primary);
      }
      label {
        display: grid;
        gap: 7px;
        font-size: 13px;
        font-weight: 600;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .modal {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.42);
        z-index: 40;
      }
      .modal.open { display: flex; }
      .modal-card {
        width: min(1320px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow: hidden;
        display: grid;
        grid-template-rows: auto 1fr;
        box-shadow: var(--shadow-strong);
      }
      .modal-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 16px;
        padding: 22px 24px 18px;
        border-bottom: 1px solid var(--line);
      }
      .modal-head h2 {
        margin: 0 0 6px;
        font-size: 1.28rem;
      }
      .modal-body {
        padding: 20px 24px 24px;
        overflow: auto;
        background: linear-gradient(180deg, rgba(248,250,252,0.86), rgba(255,255,255,0.96));
      }
      .launcher-card {
        padding: 16px;
        border-radius: 22px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(243,247,250,0.92));
        display: grid;
        gap: 12px;
      }
      .launcher-card h3 {
        margin: 0;
        font-size: 1.02rem;
      }
      .launcher-card p {
        margin: 0;
        color: var(--muted);
        line-height: 1.65;
        font-size: 13px;
      }
      @media (max-width: 1380px) {
        .workspace { grid-template-columns: 320px minmax(0, 1fr) 390px; }
      }
      @media (max-width: 1220px) {
        .hero, .workspace { grid-template-columns: 1fr; }
        .panel.sticky-panel { position: static; }
        .conversation-list, .transcript, .action-scroll { max-height: none; }
      }
      @media (max-width: 920px) {
        .shell { width: min(100vw - 12px, 100%); }
        .hero { padding: 20px; }
        .stats, .command-columns, .button-row { grid-template-columns: 1fr; }
        .modal { padding: 12px; }
        .modal-card { width: calc(100vw - 12px); max-height: calc(100vh - 12px); }
        .modal-head, .modal-body, .panel-head, .sidebar-tools, .actions, .transcript { padding-left: 16px; padding-right: 16px; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <span class="eyebrow">Dashboard Operasional Sinkron</span>
          <h1>Dashboard sinkron Codex dan Claude</h1>
          <p class="lead">Dashboard ini dirapikan agar lebih nyaman dipakai pengguna awam. Anda bisa melihat percakapan, menyinkronkan data, menarik riwayat lama, mengirim pesan, memulihkan percakapan, dan menulis ulang hasil sinkron ke penyimpanan native dari satu tempat.</p>
          <div class="hero-actions">
            <button class="primary" id="refreshButton">Muat ulang data</button>
            <button class="accent" id="syncButton">Sinkronkan cloud sekarang</button>
            <button class="ghost" id="openCommandCenterButton">Buka pusat perintah</button>
          </div>
          <div class="footnote" id="statusLine">Memuat dashboard...</div>
        </div>
        <div class="hero-note">
          <article class="hero-note-card">
            <strong>Mode tampilan baru</strong>
            <div class="small">Panel kanan dibuat lebih ringkas, sedangkan pusat perintah dipindahkan ke jendela terpisah agar tidak sesak.</div>
          </article>
          <article class="hero-note-card">
            <strong>Tips cepat</strong>
            <div class="small">Pilih percakapan di kiri, baca isi di tengah, lalu jalankan aksi yang diperlukan dari panel kanan atau pusat perintah.</div>
          </article>
          <div class="stats" id="statsGrid"></div>
        </div>
      </section>

      <section class="workspace">
        <aside class="panel sticky-panel">
          <div class="panel-head">
            <h2>Daftar percakapan</h2>
            <p>Cari percakapan, saring berdasarkan sumber, lalu tampilkan juga data yang sudah dihapus bila diperlukan.</p>
          </div>
          <div class="sidebar-tools">
            <input id="searchInput" placeholder="Cari judul atau ID percakapan" />
            <select id="sourceFilter">
              <option value="">Semua sumber</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
            <label style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="includeDeletedToggle" style="width:auto;" />
              <span>Tampilkan yang sudah dihapus</span>
            </label>
          </div>
          <div class="conversation-list" id="conversationList"></div>
        </aside>

        <section class="panel">
          <div class="panel-head">
            <h2 id="transcriptTitle">Isi percakapan</h2>
            <p id="transcriptMeta">Pilih satu percakapan untuk melihat isi lengkapnya.</p>
          </div>
          <div class="transcript" id="transcriptPane">
            <div class="placeholder">Belum ada percakapan yang dipilih.</div>
          </div>
        </section>

        <aside class="panel sticky-panel">
          <div class="panel-head">
            <h2>Aksi cepat</h2>
            <p>Panel ini diringkas untuk tugas yang paling sering dipakai. Pusat perintah lengkap dipindahkan ke jendela terpisah agar tampilan lebih lega.</p>
          </div>
          <div class="action-scroll actions">
            <details class="action-card" open>
              <summary>Aksi penting</summary>
              <div class="action-body">
                <button id="backfillCodexButton">Ambil riwayat Codex lalu kirim ke cloud</button>
                <button id="backfillClaudeButton">Ambil riwayat Claude lalu kirim ke cloud</button>
                <button class="danger" id="deleteSelectedButton">Hapus percakapan terpilih lalu kirim ke cloud</button>
                <button id="restoreSelectedButton">Pulihkan percakapan terpilih lalu kirim ke cloud</button>
              </div>
            </details>

            <details class="action-card">
              <summary>Buat percakapan baru</summary>
              <div class="action-body">
                <label>ID percakapan
                  <input id="createConversationId" placeholder="shared-thread" />
                </label>
                <label>Title
                  <input id="createConversationTitle" placeholder="Shared Thread" />
                </label>
                <button id="createConversationButton">Buat percakapan</button>
              </div>
            </details>

            <details class="action-card">
              <summary>Kirim pesan</summary>
              <div class="action-body">
                <label>Percakapan
                  <input id="messageConversation" placeholder="shared-thread" />
                </label>
                <label>Sumber
                  <select id="messageSource">
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label>Peran
                  <select id="messageRole">
                    <option value="assistant">asisten</option>
                    <option value="user">pengguna</option>
                  </select>
                </label>
                <label>Isi pesan
                  <textarea id="messageContent" placeholder="Tulis pesan yang ingin disimpan atau dikirim ke cloud"></textarea>
                </label>
                <div class="button-row">
                  <button id="addMessageButton">Simpan lokal saja</button>
                  <button class="primary" id="sendMessageButton">Kirim dan sinkronkan</button>
                </div>
              </div>
            </details>

            <details class="action-card">
              <summary>Tulis ulang ke penyimpanan native</summary>
              <div class="action-body">
                <label>Target aplikasi
                  <select id="nativeTarget">
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label>Percakapan
                  <input id="nativeConversation" placeholder="Kosongkan untuk semua percakapan aktif" />
                </label>
                <label>Nama project Claude
                  <input id="nativeProjectName" placeholder="cloud-sync" />
                </label>
                <label>Lokasi Codex Home khusus
                  <input id="nativeCodexHome" placeholder="Opsional, mis. .data/native-test/codex-home" />
                </label>
                <label>Lokasi Claude Home khusus
                  <input id="nativeClaudeHome" placeholder="Opsional, mis. .data/native-test/claude-home" />
                </label>
                <div class="button-row">
                  <button id="nativeWriteButton">Tulis ulang sekarang</button>
                  <button class="accent" id="pullNativeButton">Sinkronkan lalu tulis ulang</button>
                </div>
              </div>
            </details>

            <details class="action-card">
              <summary>Pusat perintah lengkap</summary>
              <div class="action-body">
                <div class="launcher-card">
                  <h3>Pusat perintah dipindahkan ke jendela terpisah</h3>
                  <p>Supaya panel kanan tidak sesak, semua starter pack dan fungsi lanjutan sekarang dibuka lewat jendela penuh. Pengguna awam cukup menekan tombol di bawah ini.</p>
                  <div class="section-chip-row">
                    <span class="section-chip">Starter pack</span>
                    <span class="section-chip">Penjelasan fungsi</span>
                    <span class="section-chip">Codex & Claude</span>
                  </div>
                  <button class="primary" id="openCommandCenterInlineButton">Buka pusat perintah lengkap</button>
                </div>
              </div>
            </details>

            <details class="action-card" open>
              <summary>Riwayat job perintah</summary>
              <div class="action-body">
                <div class="job-list" id="jobList">
                  <div class="placeholder">Belum ada job perintah.</div>
                </div>
              </div>
            </details>
          </div>
        </aside>
      </section>
    </main>

    <div class="modal" id="commandCenterModal" aria-hidden="true">
      <div class="modal-card">
        <div class="modal-head">
          <div>
            <h2>Pusat perintah lengkap</h2>
            <p class="small">Semua starter pack, fungsi lanjutan, dan penjelasan tiap perintah dipindahkan ke jendela ini supaya dashboard utama tetap bersih dan mudah dipahami.</p>
          </div>
          <button class="ghost" id="closeCommandCenterButton" style="width:auto; min-width: 112px;">Tutup</button>
        </div>
        <div class="modal-body">
          <div class="command-center">
            <div class="command-hero">
              <h3>Starter pack dan fungsi lanjutan</h3>
              <p>Pilih parameter umum sekali, lalu jalankan fungsi yang dibutuhkan dari panel <code>Codex</code> atau <code>Claude</code>. Setiap kartu dibuat lebih deskriptif agar mudah dipakai orang awam.</p>
            </div>
            <div class="command-inputs">
              <label>ID percakapan
                <input id="commandConversationId" placeholder="shared-thread atau kosongkan bila tidak relevan" />
              </label>
              <label>Nama project Claude
                <input id="commandProjectName" placeholder="cloud-sync" />
              </label>
              <label>Lokasi Codex Home khusus
                <input id="commandCodexHome" placeholder="Opsional, dipakai untuk write-back Codex" />
              </label>
              <label>Lokasi Claude Home khusus
                <input id="commandClaudeHome" placeholder="Opsional, dipakai untuk write-back Claude" />
              </label>
              <label style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" id="commandFullToggle" style="width:auto;" />
                <span>Mode penuh: pakai untuk scan atau write-back penuh bila fungsi mendukung</span>
              </label>
            </div>
            <div class="command-columns">
              <section class="command-agent codex">
                <div class="command-agent-head">
                  <h3>Operasi Codex</h3>
                  <p>Berisi fungsi untuk membaca riwayat Codex, sinkron ke cloud, menyalakan listener, dan menulis ulang ke penyimpanan native Codex.</p>
                </div>
                <div class="command-grid" id="codexCommandGrid">
                  <div class="placeholder">Memuat preset Codex...</div>
                </div>
              </section>
              <section class="command-agent claude">
                <div class="command-agent-head">
                  <h3>Operasi Claude</h3>
                  <p>Berisi fungsi untuk membaca riwayat Claude, sinkron ke cloud, menyalakan listener, dan menulis ulang ke penyimpanan native Claude.</p>
                </div>
                <div class="command-grid" id="claudeCommandGrid">
                  <div class="placeholder">Memuat preset Claude...</div>
                </div>
              </section>
            </div>
            <div class="result-box" id="commandResultBox">Belum ada perintah yang dijalankan dari dashboard.</div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const state = {
        conversations: [],
        selectedConversationId: null,
      };

      const statsGrid = document.getElementById("statsGrid");
      const statusLine = document.getElementById("statusLine");
      const conversationList = document.getElementById("conversationList");
      const transcriptPane = document.getElementById("transcriptPane");
      const transcriptTitle = document.getElementById("transcriptTitle");
      const transcriptMeta = document.getElementById("transcriptMeta");
      const searchInput = document.getElementById("searchInput");
      const sourceFilter = document.getElementById("sourceFilter");
      const includeDeletedToggle = document.getElementById("includeDeletedToggle");
      const codexCommandGrid = document.getElementById("codexCommandGrid");
      const claudeCommandGrid = document.getElementById("claudeCommandGrid");
      const commandResultBox = document.getElementById("commandResultBox");
      const jobList = document.getElementById("jobList");
      const commandCenterModal = document.getElementById("commandCenterModal");

      function openCommandCenterModal() {
        commandCenterModal.classList.add("open");
        commandCenterModal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
      }

      function closeCommandCenterModal() {
        commandCenterModal.classList.remove("open");
        commandCenterModal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
      }

      async function fetchJson(url, options) {
        const response = await fetch(url, options);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Permintaan gagal.");
        return payload;
      }

      function formatDate(value) {
        if (!value) return "-";
        return new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function selectedConversation() {
        return state.conversations.find((item) => item.id === state.selectedConversationId) || null;
      }

      function renderStats(payload) {
        const { summary, db_path } = payload;
        const cards = [
          ["Database aktif", db_path.split("\\\\").pop()],
          ["Percakapan aktif", summary.conversation_count],
          ["Percakapan dihapus", summary.deleted_conversation_count],
          ["Pesan aktif", summary.message_count],
          ["Pesan dihapus", summary.deleted_message_count],
          ["Pending sync", \`\${summary.pending_conversations} conv / \${summary.pending_messages} msg\`],
          ["Pesan terakhir", formatDate(summary.last_message_at)],
          ["Cursor cloud", summary.remote_cursor ? formatDate(summary.remote_cursor) : "-"],
        ];

        statsGrid.innerHTML = cards
          .map(([label, value]) => \`<article class="stat"><span>\${label}</span><strong>\${escapeHtml(value)}</strong></article>\`)
          .join("");
      }

      function renderConversationList() {
        if (!state.conversations.length) {
          conversationList.innerHTML = '<div class="placeholder">Belum ada percakapan.</div>';
          return;
        }

        conversationList.innerHTML = state.conversations.map((conversation) => \`
          <article class="conversation \${conversation.id === state.selectedConversationId ? "active" : ""} \${conversation.deleted_at ? "deleted" : ""}" data-id="\${encodeURIComponent(conversation.id)}">
            <strong>\${escapeHtml(conversation.title || conversation.id)}</strong>
            <div class="meta">\${conversation.message_count} pesan • \${conversation.sync_status} • update \${formatDate(conversation.updated_at)}</div>
            <div class="pill-row">
              \${conversation.sources.map((source) => \`<span class="pill">\${escapeHtml(source)}</span>\`).join("")}
              \${conversation.deleted_at ? \`<span class="pill deleted">deleted</span>\` : ""}
              <span class="pill">\${escapeHtml(conversation.id)}</span>
            </div>
          </article>
        \`).join("");

        conversationList.querySelectorAll(".conversation").forEach((node) => {
          node.addEventListener("click", async () => {
            state.selectedConversationId = decodeURIComponent(node.dataset.id);
            renderConversationList();
            await loadTranscript(state.selectedConversationId);
            fillSelectedConversationTargets();
          });
        });
      }

      function renderTranscript(payload) {
        transcriptTitle.textContent = payload.conversation.title || payload.conversation.id;
        transcriptMeta.textContent = \`\${payload.transcript.length} pesan • \${payload.conversation.sync_status} • deleted \${payload.conversation.deleted_at ? formatDate(payload.conversation.deleted_at) : "tidak"}\`;

        if (!payload.transcript.length) {
          transcriptPane.innerHTML = '<div class="placeholder">Percakapan ini belum memiliki isi.</div>';
          return;
        }

        transcriptPane.innerHTML = payload.transcript.map((message) => \`
          <article class="message \${message.role} \${message.deleted_at ? "deleted" : ""}">
            <div class="message-head">
              <strong>\${escapeHtml(message.source)} / \${escapeHtml(message.role)}</strong>
              <span>\${formatDate(message.created_at)}</span>
            </div>
            <div class="message-body">\${escapeHtml(message.content)}</div>
          </article>
        \`).join("");
      }

      function renderCommandCenter(payload) {
        const grouped = {
          codex: payload.presets.filter((preset) => preset.agent === "codex"),
          claude: payload.presets.filter((preset) => preset.agent === "claude"),
        };

        codexCommandGrid.innerHTML = renderPresetCards(grouped.codex);
        claudeCommandGrid.innerHTML = renderPresetCards(grouped.claude);

        document.querySelectorAll(".run-preset-button").forEach((button) => {
          button.addEventListener("click", () => runPresetCommand(button.dataset.presetId));
        });

        if (!payload.jobs.length) {
          jobList.innerHTML = '<div class="placeholder">Belum ada job perintah.</div>';
          return;
        }

        jobList.innerHTML = payload.jobs.map((job) => \`
          <article class="job-card">
            <div class="job-head">
              <div>
                <strong>\${escapeHtml(job.label)}</strong>
                <div class="job-meta">\${escapeHtml(job.agent || "-")} | \${escapeHtml(job.presetId)} | \${escapeHtml(job.status)} | mulai \${formatDate(job.startedAt)}</div>
              </div>
              <div class="job-actions">
                \${job.status === "running" ? \`<button class="danger stop-job-button" data-id="\${escapeHtml(job.id)}">Stop</button>\` : ""}
              </div>
            </div>
            <div class="job-meta">PID: \${escapeHtml(job.pid || "-")} | selesai: \${job.finishedAt ? escapeHtml(formatDate(job.finishedAt)) : "-"}</div>
            <div class="job-log">\${escapeHtml(job.log || "Belum ada log.")}</div>
          </article>
        \`).join("");

        jobList.querySelectorAll(".stop-job-button").forEach((button) => {
          button.addEventListener("click", () => stopJob(button.dataset.id));
        });
      }

      function renderPresetCards(presets) {
        if (!presets.length) {
          return '<div class="placeholder">Belum ada preset di grup ini.</div>';
        }

        return presets.map((preset) => \`
          <article class="command-card">
            <div class="command-card-head">
              <div>
                <strong>\${escapeHtml(preset.label)}</strong>
              </div>
              <div class="command-badges">
                <span class="command-badge">\${escapeHtml(preset.category)}</span>
                <span class="command-badge kind-\${escapeHtml(preset.kind)}">\${escapeHtml(preset.kind)}</span>
              </div>
            </div>
            <div class="command-text">\${escapeHtml(preset.description)}</div>
            <div class="command-help"><strong>Penjelasan:</strong> \${escapeHtml(preset.help)}</div>
            <button class="primary run-preset-button" data-preset-id="\${escapeHtml(preset.id)}">Jalankan \${escapeHtml(preset.label)}</button>
          </article>
        \`).join("");
      }

      async function loadSummary() {
        renderStats(await fetchJson("/api/summary"));
      }

      async function loadConversations() {
        const params = new URLSearchParams({
          query: searchInput.value.trim(),
          source: sourceFilter.value,
          includeDeleted: String(includeDeletedToggle.checked),
        });
        const payload = await fetchJson(\`/api/conversations?\${params.toString()}\`);
        state.conversations = payload.conversations;

        if (!state.selectedConversationId && state.conversations[0]) {
          state.selectedConversationId = state.conversations[0].id;
        }

        if (state.selectedConversationId && !state.conversations.some((item) => item.id === state.selectedConversationId)) {
          state.selectedConversationId = state.conversations[0]?.id || null;
        }

        renderConversationList();

        if (state.selectedConversationId) {
          await loadTranscript(state.selectedConversationId);
        } else {
          transcriptPane.innerHTML = '<div class="placeholder">Belum ada percakapan yang cocok dengan filter ini.</div>';
          transcriptTitle.textContent = "Isi percakapan";
          transcriptMeta.textContent = "Pilih satu percakapan untuk melihat isi lengkapnya.";
        }
      }

      async function loadTranscript(conversationId) {
        const payload = await fetchJson(\`/api/conversations/\${encodeURIComponent(conversationId)}?includeDeleted=\${includeDeletedToggle.checked}\`);
        renderTranscript(payload);
      }

      async function loadCommands() {
        renderCommandCenter(await fetchJson("/api/commands"));
      }

      function fillSelectedConversationTargets() {
        const selected = selectedConversation();
        if (!selected) return;
        document.getElementById("messageConversation").value = selected.id;
        document.getElementById("nativeConversation").value = selected.id;
        document.getElementById("commandConversationId").value = selected.id;
        document.getElementById("createConversationId").placeholder = selected.id;
      }

      async function refreshAll() {
        statusLine.textContent = "Memuat data terbaru...";
        await loadSummary();
        await loadConversations();
        await loadCommands();
        fillSelectedConversationTargets();
        statusLine.textContent = \`Terakhir dimuat: \${formatDate(new Date().toISOString())}\`;
      }

      async function runAction(action, body = {}) {
        statusLine.textContent = \`Menjalankan \${action}...\`;
        try {
          const payload = await fetchJson("/api/actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...body }),
          });
          statusLine.textContent = \`\${action} selesai.\`;
          await refreshAll();
          return payload;
        } catch (error) {
          statusLine.textContent = \`Gagal: \${error.message}\`;
          throw error;
        }
      }

      function collectCommandOptions() {
        return {
          conversationId: document.getElementById("commandConversationId").value.trim(),
          projectName: document.getElementById("commandProjectName").value.trim(),
          codexHome: document.getElementById("commandCodexHome").value.trim(),
          claudeHome: document.getElementById("commandClaudeHome").value.trim(),
          full: document.getElementById("commandFullToggle").checked,
        };
      }

      async function runPresetCommand(presetId) {
        statusLine.textContent = "Menjalankan preset command...";
        try {
          const payload = await fetchJson("/api/commands/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              presetId,
              ...collectCommandOptions(),
            }),
          });
          commandResultBox.textContent = JSON.stringify(payload, null, 2);
          statusLine.textContent = \`\${presetId} selesai dipanggil.\`;
          await refreshAll();
        } catch (error) {
          statusLine.textContent = \`Gagal: \${error.message}\`;
          commandResultBox.textContent = error.message;
        }
      }

      async function stopJob(jobId) {
        statusLine.textContent = "Menghentikan job...";
        try {
          const payload = await fetchJson(\`/api/commands/\${encodeURIComponent(jobId)}/stop\`, {
            method: "POST",
          });
          commandResultBox.textContent = JSON.stringify(payload, null, 2);
          statusLine.textContent = "Permintaan stop sudah dikirim.";
          await refreshAll();
        } catch (error) {
          statusLine.textContent = \`Gagal: \${error.message}\`;
          commandResultBox.textContent = error.message;
        }
      }

      function selectedConversationIdOrWarn() {
        const selected = selectedConversation();
        if (!selected) {
          throw new Error("Pilih conversation dulu.");
        }
        return selected.id;
      }

      document.getElementById("refreshButton").addEventListener("click", refreshAll);
      document.getElementById("openCommandCenterButton").addEventListener("click", openCommandCenterModal);
      document.getElementById("openCommandCenterInlineButton").addEventListener("click", openCommandCenterModal);
      document.getElementById("syncButton").addEventListener("click", () => runAction("sync"));
      document.getElementById("backfillCodexButton").addEventListener("click", () => runAction("backfill", { source: "codex", push: true }));
      document.getElementById("backfillClaudeButton").addEventListener("click", () => runAction("backfill", { source: "claude", push: true }));
      document.getElementById("deleteSelectedButton").addEventListener("click", async () => {
        const conversation = selectedConversationIdOrWarn();
        await runAction("delete-conversation", { conversation, push: true });
      });
      document.getElementById("restoreSelectedButton").addEventListener("click", async () => {
        const conversation = selectedConversationIdOrWarn();
        await runAction("restore-conversation", { conversation, push: true });
      });
      document.getElementById("createConversationButton").addEventListener("click", () => runAction("create-conversation", {
        id: document.getElementById("createConversationId").value.trim(),
        title: document.getElementById("createConversationTitle").value.trim(),
      }));
      document.getElementById("addMessageButton").addEventListener("click", () => runAction("add-message", collectMessageForm()));
      document.getElementById("sendMessageButton").addEventListener("click", () => runAction("send-message", collectMessageForm()));
      document.getElementById("nativeWriteButton").addEventListener("click", () => runAction("native-writeback", collectNativeForm()));
      document.getElementById("pullNativeButton").addEventListener("click", () => runAction("pull-native", collectNativeForm()));

      function collectMessageForm() {
        return {
          conversation: document.getElementById("messageConversation").value.trim(),
          source: document.getElementById("messageSource").value,
          role: document.getElementById("messageRole").value === "asisten" ? "assistant" : (document.getElementById("messageRole").value === "pengguna" ? "user" : document.getElementById("messageRole").value),
          content: document.getElementById("messageContent").value,
        };
      }

      function collectNativeForm() {
        return {
          target: document.getElementById("nativeTarget").value,
          conversation: document.getElementById("nativeConversation").value.trim(),
          projectName: document.getElementById("nativeProjectName").value.trim(),
          codexHome: document.getElementById("nativeCodexHome").value.trim(),
          claudeHome: document.getElementById("nativeClaudeHome").value.trim(),
        };
      }

      document.getElementById("closeCommandCenterButton").addEventListener("click", closeCommandCenterModal);
      commandCenterModal.addEventListener("click", (event) => {
        if (event.target === commandCenterModal) closeCommandCenterModal();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && commandCenterModal.classList.contains("open")) {
          closeCommandCenterModal();
        }
      });

      searchInput.addEventListener("input", () => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(refreshAll, 250);
      });
      sourceFilter.addEventListener("change", refreshAll);
      includeDeletedToggle.addEventListener("change", refreshAll);

      refreshAll();
      setInterval(refreshAll, 10000);
    </script>
  </body>
</html>`;
}

module.exports = {
  createDashboardServer,
};
