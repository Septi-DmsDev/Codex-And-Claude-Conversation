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
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "ya", "on"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function extractConversationContextFromBody(body = {}, metadata = {}) {
  return {
    projectId: String(body.projectId || metadata.projectId || metadata.project_id || "").trim(),
    scope: String(body.scope || metadata.scope || "").trim(),
    allowedForAi: parseBoolean(
      Object.prototype.hasOwnProperty.call(body, "allowedForAi")
        ? body.allowedForAi
        : metadata.allowedForAi ?? metadata.allowed_for_ai,
      false,
    ),
  };
}

function ensureConversation(store, conversationId, title, metadata = {}, context = {}) {
  const existing = store.getConversation(conversationId, { includeDeleted: true });

  if (existing) {
    if (existing.deleted_at) {
      store.restoreConversation(conversationId);
    }
    if (context.projectId || context.scope || Object.prototype.hasOwnProperty.call(context, "allowedForAi")) {
      store.updateConversationContext(conversationId, context);
    }
    return;
  }

  const timestamp = nowIso();
  store.createConversation({
    id: conversationId,
    title: title || conversationId,
    metadata,
    projectId: context.projectId || "",
    scope: context.scope || "",
    allowedForAi: context.allowedForAi,
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

  const metadata = parseMetadata(body.metadata);
  const context = extractConversationContextFromBody(body, metadata);
  ensureConversation(store, conversationId, body.title, metadata, context);

  const timestamp = nowIso();
  store.addMessage({
    id: body.id || crypto.randomUUID(),
    conversationId,
    source: body.source || defaultSource,
    role: body.role || "assistant",
    content,
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return { conversationId };
}

function readJsonBody(request) {
  return new Promise(async (resolve, reject) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : {});
    } catch (error) {
      reject(error);
    }
  });
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
    const sync = createSupabaseSync({ supabaseUrl, supabaseKey: getSupabaseKey() });
    try {
      return await sync.syncOnce(store);
    } finally {
      await sync.close();
    }
  }

  async function runPushOnly() {
    requireSupabaseEnv();
    const sync = createSupabaseSync({ supabaseUrl, supabaseKey: getSupabaseKey() });
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
      return body.push ? { action, ...result, push: await runPushOnly() } : { action, ...result };
    }

    if (action === "sync") return { action, result: await runSync() };

    if (action === "create-conversation") {
      const id = body.id || crypto.randomUUID();
      const title = body.title || id;
      const timestamp = nowIso();
      const metadata = parseMetadata(body.metadata);
      const context = extractConversationContextFromBody(body, metadata);
      store.createConversation({
        id,
        title,
        metadata,
        projectId: context.projectId,
        scope: context.scope,
        allowedForAi: context.allowedForAi,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { action, conversationId: id };
    }

    if (action === "add-message") return { action, ...addMessageToStore(store, body) };

    if (action === "send-message") {
      const result = addMessageToStore(store, body);
      return { action, ...result, push: await runPushOnly() };
    }

    if (action === "delete-conversation") {
      if (!body.conversation) throw new Error("conversation wajib diisi.");
      store.deleteConversation(body.conversation);
      return { action, conversationId: body.conversation, push: body.push ? await runPushOnly() : null };
    }

    if (action === "restore-conversation") {
      if (!body.conversation) throw new Error("conversation wajib diisi.");
      store.restoreConversation(body.conversation);
      return { action, conversationId: body.conversation, push: body.push ? await runPushOnly() : null };
    }

    if (action === "update-conversation-context") {
      if (!body.conversation) throw new Error("conversation wajib diisi.");
      return {
        action,
        conversation: store.updateConversationContext(body.conversation, {
          projectId: body.projectId || "",
          scope: body.scope || "",
          allowedForAi: parseBoolean(body.allowedForAi, false),
          title: body.title || "",
        }),
        push: body.push ? await runPushOnly() : null,
      };
    }

    if (action === "native-writeback") {
      if (!body.target) throw new Error("target wajib diisi.");
      return {
        action,
        result: writeNativeMirror(store, {
          target: body.target,
          conversationId: body.conversation || "",
          full: Boolean(body.full),
          codexHome: body.codexHome || "",
          claudeHome: body.claudeHome || "",
          projectName: body.projectName || "",
          projectId: body.projectId || "",
          scopeMode: body.scopeMode || "",
          onlyAllowedForAi: parseBoolean(body.onlyAllowedForAi, true),
        }),
      };
    }

    if (action === "pull-native") {
      if (!body.target) throw new Error("target wajib diisi.");
      const sync = await runSync();
      const writeback = writeNativeMirror(store, {
        target: body.target,
        conversationId: body.conversation || "",
        full: Boolean(body.full),
        codexHome: body.codexHome || "",
        claudeHome: body.claudeHome || "",
        projectName: body.projectName || "",
        projectId: body.projectId || "",
        scopeMode: body.scopeMode || "",
        onlyAllowedForAi: parseBoolean(body.onlyAllowedForAi, true),
      });
      return { action, sync, writeback };
    }

    throw new Error("Action tidak dikenal: " + action);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://" + request.headers.host);

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(getDashboardHtml());
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/summary") {
        const projectId = requestUrl.searchParams.get("projectId") || "";
        json(response, 200, { db_path: dbPath, project_id: projectId, summary: store.getSummary({ projectId }) });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/conversations") {
        json(response, 200, {
          conversations: store.listConversationsForDashboard({
            query: requestUrl.searchParams.get("query") || "",
            source: requestUrl.searchParams.get("source") || "",
            includeDeleted: requestUrl.searchParams.get("includeDeleted") === "true",
            limit: Number(requestUrl.searchParams.get("limit") || 200),
            projectId: requestUrl.searchParams.get("projectId") || "",
            scopeMode: requestUrl.searchParams.get("scopeMode") || "project-ai",
            onlyAllowedForAi: parseBoolean(requestUrl.searchParams.get("onlyAllowedForAi"), false),
          }),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/commands") {
        json(response, 200, { presets: commandCenter.listPresets(), jobs: commandCenter.listJobs() });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/conversations/")) {
        const conversationId = decodeURIComponent(requestUrl.pathname.replace("/api/conversations/", ""));
        const includeDeleted = requestUrl.searchParams.get("includeDeleted") === "true";
        const conversation = store.getConversation(conversationId, { includeDeleted: true });
        if (!conversation) return json(response, 404, { error: "Conversation tidak ditemukan." });
        json(response, 200, { conversation, transcript: store.getTranscript(conversationId, { includeDeleted }) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/actions") {
        const body = await readJsonBody(request);
        json(response, 200, await handleAction(body.action, body));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/commands/run") {
        const body = await readJsonBody(request);
        json(response, 200, await commandCenter.runPreset(body.presetId, {
          conversationId: body.conversationId || "",
          projectName: body.projectName || "",
          codexHome: body.codexHome || "",
          claudeHome: body.claudeHome || "",
          full: Boolean(body.full),
        }));
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
        console.log("Dashboard aktif di http://localhost:" + port);
      });
    },
  };
}

function getDashboardHtml() {
  return String.raw`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Context Bridge Dashboard</title>
  <style>
  select,
  option,
  .dropdown,
  .dropdown * {
    font-family: var(--font-sans) !important;
  }
    :root {
      --bg: #0b1020;
      --bg-2: #121a31;
      --panel: rgba(10, 16, 31, 0.86);
      --surface: rgba(255,255,255,0.04);
      --surface-2: rgba(255,255,255,0.06);
      --border: rgba(148, 163, 184, 0.16);
      --text: #ebf2ff;
      --muted: #91a0bc;
      --primary: #60e1c0;
      --primary-strong: #1fb594;
      --secondary: #8b78ff;
      --danger: #f87171;
      --warning: #fbbf24;
      --shadow: 0 24px 60px rgba(0,0,0,.32);
      --radius-xl: 24px;
      --radius-lg: 18px;
      --radius-md: 14px;
      color-scheme: dark;
    }
    body[data-theme="light"] {
      --bg: #eef3fb;
      --bg-2: #ffffff;
      --panel: rgba(255,255,255,0.92);
      --surface: rgba(15,23,42,0.03);
      --surface-2: rgba(15,23,42,0.05);
      --border: rgba(15,23,42,0.10);
      --text: #10203d;
      --muted: #64748b;
      --primary: #0f9f82;
      --primary-strong: #0a7d66;
      --secondary: #6c5ce7;
      --danger: #dc2626;
      --warning: #b45309;
      --shadow: 0 24px 60px rgba(30,41,59,.12);
      color-scheme: light;
    }
    
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: radial-gradient(circle at top left, rgba(96,225,192,.10), transparent 28%), radial-gradient(circle at top right, rgba(139,120,255,.12), transparent 30%), linear-gradient(180deg, var(--bg), var(--bg-2)); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .app { max-width: 1560px; margin: 0 auto; padding: 28px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(420px, .9fr); gap: 18px; align-items: stretch; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow); backdrop-filter: blur(18px); }
    .hero-main { padding: 28px; position: relative; overflow: hidden; }
    .hero-main::after { content: ""; position: absolute; right: -80px; top: -80px; width: 240px; height: 240px; border-radius: 999px; background: radial-gradient(circle, rgba(96,225,192,.18), transparent 70%); }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: rgba(96,225,192,.12); color: var(--primary); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .hero h1 { margin: 16px 0 12px; font-size: clamp(30px, 4vw, 44px); line-height: 1.04; max-width: 680px; }
    .hero p { margin: 0; max-width: 760px; color: var(--muted); line-height: 1.7; font-size: 15px; }
    .hero-mini { margin-top: 22px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .mini-stat { padding: 16px; border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); }
    .mini-stat span { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
    .mini-stat strong { display: block; margin-top: 8px; font-size: 20px; }
    .control-card { padding: 20px; display: grid; gap: 14px; }
    .control-top { display:flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .control-top h2 { margin: 0; font-size: 18px; }
    .subtle { color: var(--muted); font-size: 13px; line-height: 1.6; }
    .grid-2, .grid-3, .grid-4 { display: grid; gap: 12px; }
    .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .field { display: grid; gap: 8px; }
    .field label { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .input, .select, .textarea {
      width: 100%; border: 1px solid var(--border); background: rgba(255,255,255,.02); color: var(--text);
      border-radius: 14px; padding: 13px 14px; outline: none; transition: border-color .18s ease, transform .18s ease, background .18s ease;
    }
    .textarea { min-height: 110px; resize: vertical; }
    .input:focus, .select:focus, .textarea:focus { border-color: var(--primary); transform: translateY(-1px); background: rgba(255,255,255,.03); }
    .toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { border: 1px solid transparent; border-radius: 14px; padding: 12px 16px; font-weight: 700; transition: .18s ease; }
    .btn:hover { transform: translateY(-1px); }
    .btn.primary { background: linear-gradient(135deg, var(--primary), #38d6b3); color: #06221b; box-shadow: 0 14px 26px rgba(31,181,148,.24); }
    .btn.secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
    .btn.ghost { background: transparent; border-color: var(--border); color: var(--muted); }
    .btn.danger { background: rgba(248,113,113,.1); border-color: rgba(248,113,113,.25); color: #fecaca; }
    .btn.small { padding: 10px 12px; font-size: 13px; }
    .btn.block { width: 100%; }
    .stats { margin-top: 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .stat { padding: 18px; }
    .stat span { display:block; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
    .stat strong { display:block; margin-top:8px; font-size:28px; }
    .workspace { margin-top: 18px; display: grid; grid-template-columns: 340px minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
    .panel { overflow: hidden; }
    .panel-head { padding: 18px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .panel-head h3 { margin: 0; font-size: 18px; }
    .panel-body { padding: 18px 20px 20px; }
    .list { display: grid; gap: 12px; max-height: calc(100vh - 350px); overflow: auto; padding-right: 4px; }
    .conversation { border: 1px solid var(--border); background: rgba(255,255,255,.02); border-radius: 18px; padding: 15px; transition: .16s ease; }
    .conversation:hover { border-color: rgba(96,225,192,.45); transform: translateY(-1px); }
    .conversation.active { border-color: var(--primary); background: linear-gradient(180deg, rgba(96,225,192,.12), rgba(255,255,255,.02)); }
    .conversation.deleted { opacity: .65; }
    .conversation h4 { margin: 0 0 8px; font-size: 15px; line-height: 1.45; }
    .meta { color: var(--muted); font-size: 13px; line-height: 1.6; }
    .pill-row { display:flex; gap:8px; flex-wrap:wrap; margin-top: 12px; }
    .pill { padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; color: var(--muted); background: var(--surface); }
    .pill.good { color: var(--primary); }
    .pill.warn { color: var(--warning); }
    .transcript-meta { color: var(--muted); font-size: 13px; line-height: 1.6; }
    .transcript-list { display: grid; gap: 12px; max-height: calc(100vh - 330px); overflow: auto; padding-right: 4px; }
    .message { border: 1px solid var(--border); border-radius: 18px; padding: 16px; background: rgba(255,255,255,.02); }
    .message.user { border-left: 3px solid var(--primary); }
    .message.assistant { border-left: 3px solid var(--secondary); }
    .message-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:10px; font-size:13px; color:var(--muted); }
    .message-body { white-space: pre-wrap; word-break: break-word; line-height: 1.75; font-size: 15px; }
    .stack { display:grid; gap:18px; }
    .section { padding: 16px; border: 1px solid var(--border); border-radius: 18px; background: rgba(255,255,255,.02); }
    .section h4 { margin: 0 0 8px; font-size: 15px; }
    .section p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .switch { display:flex; align-items:center; justify-content:space-between; gap:12px; padding: 14px; border:1px solid var(--border); border-radius: 14px; background: rgba(255,255,255,.02); }
    .switch input { width: 18px; height: 18px; }
    .notice { margin-top: 12px; padding: 14px 16px; border-radius: 14px; background: rgba(96,225,192,.10); border: 1px solid rgba(96,225,192,.24); }
    .empty { padding: 24px; text-align: center; border: 1px dashed var(--border); border-radius: 18px; color: var(--muted); }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(7,10,18,.62); backdrop-filter: blur(10px); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 100; }
    .modal-backdrop.open { display: flex; }
    .modal { width: min(1180px, 100%); max-height: calc(100vh - 48px); display: grid; grid-template-rows: auto 1fr; overflow: hidden; }
    .modal-head { padding: 20px 24px; border-bottom: 1px solid var(--border); display:flex; justify-content: space-between; gap: 12px; align-items: center; }
    .modal-body { padding: 22px 24px 24px; overflow: auto; }
    .command-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .command-card, .job-card { padding: 18px; border-radius: 18px; border: 1px solid var(--border); background: rgba(255,255,255,.03); }
    .command-card h4 { margin: 0; font-size: 16px; }
    .command-top, .job-top { display:flex; justify-content: space-between; gap: 12px; align-items:flex-start; }
    .command-note, .job-note { color: var(--muted); font-size: 13px; line-height: 1.6; margin-top: 12px; }
    .job-list { display:grid; gap: 14px; margin-top: 18px; }
    .job-log { margin-top: 12px; padding: 14px; border-radius: 14px; background: rgba(2,6,23,.65); color: #dbeafe; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 220px; overflow: auto; white-space: pre-wrap; }
    .hidden { display: none !important; }
    .muted { color: var(--muted); }
    @media (max-width: 1280px) {
      .hero, .workspace { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0,1fr)); }
    }
    @media (max-width: 760px) {
      .app { padding: 16px; }
      .hero-mini, .stats, .grid-2, .grid-3, .grid-4, .command-grid { grid-template-columns: 1fr; }
      .modal-backdrop { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="hero">
      <div class="card hero-main">
        <div class="badge">Context Bridge / dashboard lokal</div>
        <h1>UI yang fokus ke konteks, bukan sekadar menumpuk semua percakapan.</h1>
        <p>Dashboard ini dirancang untuk memudahkan pengguna non-teknis memilih proyek aktif, memfilter percakapan yang relevan, membuka transcript dengan cepat, lalu menetapkan apakah AI boleh membaca percakapan tersebut atau tidak.</p>
        <div class="hero-mini">
          <div class="mini-stat"><span>Mode kerja</span><strong>Project-first</strong></div>
          <div class="mini-stat"><span>Kontrol AI</span><strong>Whitelist</strong></div>
          <div class="mini-stat"><span>Tata letak</span><strong>Modal command center</strong></div>
        </div>
      </div>
      <div class="card control-card">
        <div class="control-top">
          <div>
            <h2>Kontrol utama</h2>
            <div class="subtle">Atur proyek aktif, mode pagar AI, dan tindakan harian dari satu area yang ringkas.</div>
          </div>
          <button id="themeToggle" class="btn secondary">Mode gelap</button>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="activeProjectId">Proyek aktif</label>
            <input id="activeProjectId" class="input" placeholder="contoh: sync-codex-claude" />
          </div>
          <div class="field">
            <label for="scopeMode">Mode pagar AI</label>
            <select id="scopeMode" class="select">
              <option value="project-ai">Proyek aktif + diizinkan AI</option>
              <option value="project">Semua percakapan proyek aktif</option>
              <option value="allowed">Semua yang diizinkan AI</option>
              <option value="general">Hanya percakapan umum</option>
              <option value="all">Semua percakapan</option>
            </select>
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label for="sourceFilter">Sumber</label>
            <select id="sourceFilter" class="select">
              <option value="">Semua sumber</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </div>
          <div class="field">
            <label for="searchInput">Cari judul atau ID</label>
            <input id="searchInput" class="input" placeholder="Cari percakapan..." />
          </div>
          <div class="field">
            <label>Tampilkan deleted</label>
            <div class="switch"><span class="muted">Aktifkan bila perlu</span><input id="includeDeletedToggle" type="checkbox" /></div>
          </div>
        </div>
        <div class="toolbar-actions">
          <button id="refreshButton" class="btn secondary">Muat ulang</button>
          <button id="syncNowButton" class="btn primary">Sinkronkan sekarang</button>
          <button id="backfillButton" class="btn secondary">Backfill cepat</button>
          <button id="openCommandCenter" class="btn ghost">Buka command center</button>
        </div>
        <div id="noticeBox" class="notice hidden"></div>
        <div id="dbMeta" class="subtle"></div>
      </div>
    </section>

    <section id="statsGrid" class="stats"></section>

    <section class="workspace">
      <aside class="card panel">
        <div class="panel-head">
          <div>
            <h3>Daftar percakapan</h3>
            <div class="subtle">Fokus ke percakapan yang relevan dengan proyek aktif.</div>
          </div>
        </div>
        <div class="panel-body"><div id="conversationList" class="list"></div></div>
      </aside>

      <main class="card panel">
        <div class="panel-head">
          <div>
            <h3 id="transcriptTitle">Transcript</h3>
            <div id="transcriptMeta" class="transcript-meta">Pilih satu percakapan dari kiri untuk melihat isi dan konteksnya.</div>
          </div>
        </div>
        <div class="panel-body"><div id="transcriptPane" class="transcript-list"></div></div>
      </main>

      <aside class="stack">
        <section class="card panel">
          <div class="panel-head">
            <div>
              <h3>Pagar konteks AI</h3>
              <div class="subtle">Tentukan apakah percakapan terpilih boleh dipakai sebagai konteks AI.</div>
            </div>
          </div>
          <div class="panel-body">
            <form id="contextForm" class="grid-2">
              <div class="field" style="grid-column: 1 / -1;">
                <label for="contextProjectId">Project ID</label>
                <input id="contextProjectId" class="input" placeholder="isi project_id untuk percakapan terpilih" />
              </div>
              <div class="field">
                <label for="contextScope">Scope</label>
                <select id="contextScope" class="select">
                  <option value="project">project</option>
                  <option value="general">general</option>
                  <option value="private">private</option>
                  <option value="archive">archive</option>
                </select>
              </div>
              <div class="field">
                <label>Izinkan AI</label>
                <div class="switch"><span class="muted">Aktifkan hanya untuk chat yang relevan</span><input id="contextAllowedForAi" type="checkbox" /></div>
              </div>
              <div style="grid-column: 1 / -1;" class="toolbar-actions">
                <button class="btn primary" type="submit">Simpan konteks</button>
                <button id="useActiveProjectButton" class="btn secondary" type="button">Gunakan proyek aktif</button>
              </div>
            </form>
            <div id="selectedContextSummary" class="notice">Pilih percakapan dari kiri untuk mengatur konteks.</div>
          </div>
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div>
              <h3>Aksi cepat</h3>
              <div class="subtle">Tindakan yang paling sering dipakai sehari-hari.</div>
            </div>
          </div>
          <div class="panel-body stack">
            <div class="section">
              <h4>Sinkronisasi sekarang</h4>
              <p>Menjalankan push dan pull sekali jalan untuk memperbarui data lokal dan cloud.</p>
              <div class="toolbar-actions" style="margin-top: 14px;"><button id="quickSyncButton" class="btn primary block">Jalankan sinkronisasi</button></div>
            </div>
            <div class="section">
              <h4>Backfill cepat</h4>
              <p>Ambil riwayat yang belum masuk dari Codex atau Claude ke database lokal.</p>
              <div class="toolbar-actions" style="margin-top: 14px;"><button id="quickBackfillButton" class="btn secondary block">Jalankan backfill</button></div>
            </div>
            <div class="section">
              <h4>Command center</h4>
              <p>Untuk preset lanjutan, background job, dan tindakan operasional lain, buka modal command center.</p>
              <div class="toolbar-actions" style="margin-top: 14px;"><button id="quickCommandCenterButton" class="btn ghost block">Buka command center</button></div>
            </div>
          </div>
        </section>
      </aside>
    </section>
  </div>

  <div id="commandModal" class="modal-backdrop" aria-hidden="true">
    <div class="card modal" role="dialog" aria-modal="true" aria-label="Command center">
      <div class="modal-head">
        <div>
          <h3 style="margin:0;">Command center</h3>
          <div class="subtle">Preset dan job background dipisahkan ke modal agar dashboard utama tetap bersih.</div>
        </div>
        <button id="closeCommandCenter" class="btn secondary">Tutup</button>
      </div>
      <div class="modal-body">
        <div id="commandGrid" class="command-grid"></div>
        <div id="jobList" class="job-list"></div>
      </div>
    </div>
  </div>

  <script>
    const state = {
      conversations: [],
      selectedConversationId: "",
      selectedConversation: null,
      activeProjectId: localStorage.getItem("context-bridge:projectId") || "",
      scopeMode: localStorage.getItem("context-bridge:scopeMode") || "project-ai",
      includeDeleted: localStorage.getItem("context-bridge:includeDeleted") === "true",
      source: localStorage.getItem("context-bridge:source") || "",
      theme: localStorage.getItem("context-bridge:theme") || "dark",
      commands: { presets: [], jobs: [] },
    };

    const bodyNode = document.body;
    const statsGrid = document.getElementById("statsGrid");
    const activeProjectId = document.getElementById("activeProjectId");
    const scopeMode = document.getElementById("scopeMode");
    const sourceFilter = document.getElementById("sourceFilter");
    const searchInput = document.getElementById("searchInput");
    const includeDeletedToggle = document.getElementById("includeDeletedToggle");
    const conversationList = document.getElementById("conversationList");
    const transcriptTitle = document.getElementById("transcriptTitle");
    const transcriptMeta = document.getElementById("transcriptMeta");
    const transcriptPane = document.getElementById("transcriptPane");
    const contextForm = document.getElementById("contextForm");
    const contextProjectId = document.getElementById("contextProjectId");
    const contextScope = document.getElementById("contextScope");
    const contextAllowedForAi = document.getElementById("contextAllowedForAi");
    const selectedContextSummary = document.getElementById("selectedContextSummary");
    const noticeBox = document.getElementById("noticeBox");
    const dbMeta = document.getElementById("dbMeta");
    const commandModal = document.getElementById("commandModal");
    const commandGrid = document.getElementById("commandGrid");
    const jobList = document.getElementById("jobList");
    const themeToggle = document.getElementById("themeToggle");

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatDate(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("id-ID", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    function scopeModeLabel(value) {
      const labels = {
        "project-ai": "Proyek aktif + diizinkan AI",
        project: "Semua percakapan proyek aktif",
        allowed: "Semua yang diizinkan AI",
        general: "Hanya percakapan umum",
        all: "Semua percakapan",
      };
      return labels[value] || value;
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request gagal");
      return payload;
    }

    function showNotice(message, tone) {
      noticeBox.classList.remove("hidden");
      noticeBox.textContent = message;
      noticeBox.style.background = tone === "error" ? "rgba(248,113,113,.10)" : "rgba(96,225,192,.10)";
      noticeBox.style.borderColor = tone === "error" ? "rgba(248,113,113,.24)" : "rgba(96,225,192,.24)";
    }
    function clearNotice() { noticeBox.classList.add("hidden"); noticeBox.textContent = ""; }

    function applyTheme() {
      bodyNode.dataset.theme = state.theme === "light" ? "light" : "dark";
      themeToggle.textContent = state.theme === "light" ? "Mode terang" : "Mode gelap";
      localStorage.setItem("context-bridge:theme", state.theme);
    }

    function renderSummary(payload) {
      const s = payload.summary;
      dbMeta.textContent = "Database aktif: " + payload.db_path;
      const cards = [
        ["Percakapan aktif", s.conversation_count],
        ["Dalam proyek aktif", s.active_project_conversation_count],
        ["Diizinkan AI", s.allowed_ai_conversation_count],
        ["Pending sync", s.pending_conversations],
        ["Pesan aktif", s.message_count],
        ["Percakapan terhapus", s.deleted_conversation_count],
        ["Update terakhir", formatDate(s.last_conversation_update)],
        ["Mode pagar", scopeModeLabel(state.scopeMode)],
      ];
      statsGrid.innerHTML = cards.map(function(card) {
        return '<article class="card stat"><span>' + escapeHtml(card[0]) + '</span><strong>' + escapeHtml(card[1]) + '</strong></article>';
      }).join("");
    }

    function renderConversationList() {
      if (!state.conversations.length) {
        conversationList.innerHTML = '<div class="empty">Belum ada percakapan yang cocok. Coba isi proyek aktif, ubah mode pagar AI, atau matikan filter yang terlalu sempit.</div>';
        return;
      }
      conversationList.innerHTML = state.conversations.map(function(item) {
        const activeClass = item.id === state.selectedConversationId ? ' active' : '';
        const deletedClass = item.deleted_at ? ' deleted' : '';
        const sourcePills = (item.sources || []).map(function(source) {
          return '<span class="pill">' + escapeHtml(source) + '</span>';
        }).join('');
        return ''
          + '<article class="conversation' + activeClass + deletedClass + '" data-id="' + encodeURIComponent(item.id) + '">'
          +   '<h4>' + escapeHtml(item.title || item.id) + '</h4>'
          +   '<div class="meta">' + escapeHtml(item.message_count) + ' pesan · ' + escapeHtml(item.sync_status) + ' · update ' + escapeHtml(formatDate(item.updated_at)) + '</div>'
          +   '<div class="pill-row">'
          +     sourcePills
          +     '<span class="pill">project: ' + escapeHtml(item.project_id || '-') + '</span>'
          +     '<span class="pill">scope: ' + escapeHtml(item.scope || 'general') + '</span>'
          +     '<span class="pill ' + (item.allowed_for_ai ? 'good' : 'warn') + '">' + escapeHtml(item.allowed_for_ai ? 'AI diizinkan' : 'AI diblokir') + '</span>'
          +     (item.deleted_at ? '<span class="pill warn">deleted</span>' : '')
          +   '</div>'
          + '</article>';
      }).join('');

      Array.from(conversationList.querySelectorAll('.conversation')).forEach(function(node) {
        node.addEventListener('click', async function() {
          state.selectedConversationId = decodeURIComponent(node.dataset.id);
          renderConversationList();
          await loadTranscript();
        });
      });
    }

    function syncContextEditor(conversation) {
      if (!conversation) {
        contextProjectId.value = state.activeProjectId;
        contextScope.value = state.activeProjectId ? 'project' : 'general';
        contextAllowedForAi.checked = false;
        selectedContextSummary.textContent = 'Pilih percakapan dari kiri untuk mengatur pagar konteks.';
        return;
      }
      contextProjectId.value = conversation.project_id || '';
      contextScope.value = conversation.scope || (conversation.project_id ? 'project' : 'general');
      contextAllowedForAi.checked = Boolean(conversation.allowed_for_ai);
      selectedContextSummary.textContent = 'Percakapan: ' + (conversation.title || conversation.id) + ' | project: ' + (conversation.project_id || '-') + ' | AI: ' + (conversation.allowed_for_ai ? 'diizinkan' : 'diblokir');
    }

    function renderTranscript(payload) {
      state.selectedConversation = payload.conversation;
      transcriptTitle.textContent = payload.conversation.title || payload.conversation.id;
      transcriptMeta.textContent = payload.transcript.length + ' pesan · ' + payload.conversation.sync_status + ' · project ' + (payload.conversation.project_id || '-') + ' · scope ' + (payload.conversation.scope || 'general') + ' · AI ' + (payload.conversation.allowed_for_ai ? 'diizinkan' : 'diblokir');
      syncContextEditor(payload.conversation);

      if (!payload.transcript.length) {
        transcriptPane.innerHTML = '<div class="empty">Percakapan ini belum punya isi.</div>';
        return;
      }
      transcriptPane.innerHTML = payload.transcript.map(function(message) {
        return ''
          + '<article class="message ' + escapeHtml(message.role) + (message.deleted_at ? ' deleted' : '') + '">'
          +   '<div class="message-head"><strong>' + escapeHtml(message.source + ' / ' + message.role) + '</strong><span>' + escapeHtml(formatDate(message.created_at)) + '</span></div>'
          +   '<div class="message-body">' + escapeHtml(message.content) + '</div>'
          + '</article>';
      }).join('');
    }

    function renderCommands(payload) {
      state.commands = payload;
      if (!payload.presets.length) {
        commandGrid.innerHTML = '<div class="empty">Belum ada preset command.</div>';
      } else {
        commandGrid.innerHTML = payload.presets.map(function(preset) {
          return ''
            + '<article class="command-card">'
            +   '<div class="command-top">'
            +     '<div><h4>' + escapeHtml(preset.label) + '</h4><div class="job-note">' + escapeHtml(preset.description) + '</div></div>'
            +     '<div class="pill-row">'
            +       '<span class="pill">' + escapeHtml(preset.agent) + '</span>'
            +       '<span class="pill">' + escapeHtml(preset.category) + '</span>'
            +       '<span class="pill">' + escapeHtml(preset.kind) + '</span>'
            +     '</div>'
            +   '</div>'
            +   '<div class="command-note"><strong>Penjelasan:</strong> ' + escapeHtml(preset.help) + '</div>'
            +   '<button class="btn primary small block run-preset" data-id="' + escapeHtml(preset.id) + '">Jalankan preset</button>'
            + '</article>';
        }).join('');
      }
      Array.from(commandGrid.querySelectorAll('.run-preset')).forEach(function(button) {
        button.addEventListener('click', function() { runPreset(button.dataset.id); });
      });

      if (!payload.jobs.length) {
        jobList.innerHTML = '';
      } else {
        jobList.innerHTML = payload.jobs.map(function(job) {
          return ''
            + '<article class="job-card">'
            +   '<div class="job-top"><div><strong>' + escapeHtml(job.label) + '</strong><div class="job-note">' + escapeHtml(job.presetId) + ' · ' + escapeHtml(job.status) + ' · mulai ' + escapeHtml(formatDate(job.startedAt)) + '</div></div>'
            +   (job.status === 'running' ? '<button class="btn danger small stop-job" data-id="' + escapeHtml(job.id) + '">Stop</button>' : '')
            +   '</div>'
            +   (job.log ? '<div class="job-log">' + escapeHtml(job.log) + '</div>' : '')
            + '</article>';
        }).join('');
        Array.from(jobList.querySelectorAll('.stop-job')).forEach(function(button) {
          button.addEventListener('click', function() { stopJob(button.dataset.id); });
        });
      }
    }

    async function loadSummary() {
      renderSummary(await fetchJson('/api/summary?projectId=' + encodeURIComponent(state.activeProjectId)));
    }

    async function loadConversations() {
      const params = new URLSearchParams({
        query: searchInput.value.trim(),
        source: state.source,
        includeDeleted: String(state.includeDeleted),
        limit: '200',
        projectId: state.activeProjectId,
        scopeMode: state.scopeMode,
      });
      const payload = await fetchJson('/api/conversations?' + params.toString());
      state.conversations = payload.conversations;
      if (!state.selectedConversationId && state.conversations.length) state.selectedConversationId = state.conversations[0].id;
      if (state.selectedConversationId && !state.conversations.some(function(item) { return item.id === state.selectedConversationId; })) {
        state.selectedConversationId = state.conversations.length ? state.conversations[0].id : '';
      }
      renderConversationList();
      if (state.selectedConversationId) await loadTranscript();
      else { transcriptTitle.textContent = 'Transcript'; transcriptMeta.textContent = 'Pilih satu percakapan dari kiri untuk melihat isi dan konteksnya.'; transcriptPane.innerHTML = '<div class="empty">Belum ada percakapan terpilih.</div>'; syncContextEditor(null); }
    }

    async function loadTranscript() {
      if (!state.selectedConversationId) return;
      renderTranscript(await fetchJson('/api/conversations/' + encodeURIComponent(state.selectedConversationId) + '?includeDeleted=' + state.includeDeleted));
    }

    async function loadCommands() { renderCommands(await fetchJson('/api/commands')); }

    async function refreshAll() {
      clearNotice();
      localStorage.setItem('context-bridge:projectId', state.activeProjectId);
      localStorage.setItem('context-bridge:scopeMode', state.scopeMode);
      localStorage.setItem('context-bridge:includeDeleted', String(state.includeDeleted));
      localStorage.setItem('context-bridge:source', state.source);
      await Promise.all([loadSummary(), loadCommands()]);
      await loadConversations();
    }

    async function postAction(payload) {
      return fetchJson('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }

    async function runPreset(presetId) {
      try {
        showNotice('Menjalankan preset ' + presetId + '...', 'info');
        await fetchJson('/api/commands/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetId: presetId, conversationId: state.selectedConversationId || '', projectName: state.activeProjectId || '', full: false }),
        });
        showNotice('Preset berhasil dijalankan.', 'info');
        await loadCommands();
      } catch (error) { showNotice(error.message, 'error'); }
    }

    async function stopJob(jobId) {
      try {
        showNotice('Menghentikan job...', 'info');
        await fetchJson('/api/commands/' + encodeURIComponent(jobId) + '/stop', { method: 'POST' });
        showNotice('Job dihentikan.', 'info');
        await loadCommands();
      } catch (error) { showNotice(error.message, 'error'); }
    }

    activeProjectId.value = state.activeProjectId;
    scopeMode.value = state.scopeMode;
    sourceFilter.value = state.source;
    includeDeletedToggle.checked = state.includeDeleted;
    applyTheme();

    document.getElementById('openCommandCenter').addEventListener('click', function() { commandModal.classList.add('open'); });
    document.getElementById('quickCommandCenterButton').addEventListener('click', function() { commandModal.classList.add('open'); });
    document.getElementById('closeCommandCenter').addEventListener('click', function() { commandModal.classList.remove('open'); });
    commandModal.addEventListener('click', function(event) { if (event.target === commandModal) commandModal.classList.remove('open'); });
    themeToggle.addEventListener('click', function() { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme(); });

    activeProjectId.addEventListener('change', function() { state.activeProjectId = activeProjectId.value.trim(); refreshAll(); });
    scopeMode.addEventListener('change', function() { state.scopeMode = scopeMode.value; refreshAll(); });
    sourceFilter.addEventListener('change', function() { state.source = sourceFilter.value; refreshAll(); });
    includeDeletedToggle.addEventListener('change', function() { state.includeDeleted = includeDeletedToggle.checked; refreshAll(); });
    searchInput.addEventListener('input', function() { clearTimeout(window.__searchTimer); window.__searchTimer = setTimeout(refreshAll, 250); });

    document.getElementById('refreshButton').addEventListener('click', refreshAll);
    document.getElementById('syncNowButton').addEventListener('click', async function() {
      try { showNotice('Menjalankan sinkronisasi...', 'info'); await postAction({ action: 'sync' }); showNotice('Sinkronisasi selesai.', 'info'); await refreshAll(); }
      catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('quickSyncButton').addEventListener('click', async function() {
      try { showNotice('Menjalankan sinkronisasi...', 'info'); await postAction({ action: 'sync' }); showNotice('Sinkronisasi selesai.', 'info'); await refreshAll(); }
      catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('backfillButton').addEventListener('click', async function() {
      try { showNotice('Menjalankan backfill cepat...', 'info'); await postAction({ action: 'backfill', source: state.source || 'all', full: false }); showNotice('Backfill selesai.', 'info'); await refreshAll(); }
      catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('quickBackfillButton').addEventListener('click', async function() {
      try { showNotice('Menjalankan backfill cepat...', 'info'); await postAction({ action: 'backfill', source: state.source || 'all', full: false }); showNotice('Backfill selesai.', 'info'); await refreshAll(); }
      catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('useActiveProjectButton').addEventListener('click', function() { contextProjectId.value = state.activeProjectId || ''; if (state.activeProjectId && contextScope.value === 'general') contextScope.value = 'project'; });

    contextForm.addEventListener('submit', async function(event) {
      event.preventDefault();
      if (!state.selectedConversationId) return showNotice('Pilih percakapan terlebih dahulu.', 'error');
      try {
        showNotice('Menyimpan pagar konteks...', 'info');
        await postAction({
          action: 'update-conversation-context',
          conversation: state.selectedConversationId,
          projectId: contextProjectId.value.trim(),
          scope: contextScope.value,
          allowedForAi: contextAllowedForAi.checked,
        });
        showNotice('Pagar konteks berhasil disimpan.', 'info');
        await refreshAll();
      } catch (error) { showNotice(error.message, 'error'); }
    });

    refreshAll().catch(function(error) { showNotice(error.message, 'error'); });
  </script>
</body>
</html>`;
}

module.exports = { createDashboardServer };
