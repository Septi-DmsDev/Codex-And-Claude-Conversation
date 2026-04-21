const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAFETY_WINDOW_MS = 12 * 60 * 60 * 1000;

function hashId(...parts) {
  return crypto.createHash("sha1").update(parts.join("::")).digest("hex");
}

function safeReadJsonLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureIso(value, fallback) {
  if (!value) {
    return fallback;
  }

  const iso = new Date(value).toISOString();
  return iso === "Invalid Date" ? fallback : iso;
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean).join("\n\n").trim();
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }

    if (typeof value.content === "string") {
      return value.content.trim();
    }

    if (Array.isArray(value.content)) {
      return normalizeText(value.content);
    }
  }

  return "";
}

function getFileMtimeIso(filePath) {
  return fs.statSync(filePath).mtime.toISOString();
}

function listFilesRecursive(rootDir, predicate) {
  const results = [];

  if (!fs.existsSync(rootDir)) {
    return results;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath, predicate));
      continue;
    }

    if (!predicate || predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function getEligibleFiles(files, cursor, full) {
  if (full || !cursor) {
    return files;
  }

  const cursorMs = new Date(cursor).getTime() - SAFETY_WINDOW_MS;
  return files.filter((filePath) => fs.statSync(filePath).mtime.getTime() >= cursorMs);
}

function parseCodexIndex(indexPath) {
  const titles = new Map();

  if (!fs.existsSync(indexPath)) {
    return titles;
  }

  for (const row of safeReadJsonLines(indexPath)) {
    if (!row || !row.id) {
      continue;
    }

    titles.set(row.id, {
      title: row.thread_name || row.id,
      updatedAt: ensureIso(row.updated_at, new Date(0).toISOString()),
    });
  }

  return titles;
}

function parseCodexSession(filePath, titleMap) {
  const rows = safeReadJsonLines(filePath);
  const turns = [];
  let activeTurn = null;
  let sessionMeta = null;
  let latestTitle = null;

  for (const row of rows) {
    if (!row || !row.type) {
      continue;
    }

    if (row.type === "session_meta") {
      sessionMeta = row.payload || null;
      continue;
    }

    if (row.type !== "event_msg" || !row.payload) {
      continue;
    }

    if (row.payload.type === "task_started") {
      activeTurn = {
        id: row.payload.turn_id || `turn-${turns.length + 1}`,
        startedAt: ensureIso(row.timestamp, new Date().toISOString()),
        messages: [],
      };
      turns.push(activeTurn);
      continue;
    }

    if (row.payload.type === "thread_name_updated") {
      latestTitle = row.payload.thread_name || latestTitle;
      continue;
    }

    if (row.payload.type === "thread_rolled_back") {
      const toRemove = Number(row.payload.num_turns || 0);

      if (toRemove > 0) {
        turns.splice(Math.max(turns.length - toRemove, 0), toRemove);
        activeTurn = turns[turns.length - 1] || null;
      }

      continue;
    }

    if (!activeTurn) {
      continue;
    }

    if (row.payload.type === "user_message") {
      const content = normalizeText(row.payload.message);

      if (content) {
        activeTurn.messages.push({
          role: "user",
          content,
          createdAt: ensureIso(row.timestamp, activeTurn.startedAt),
          metadata: {
            imported_from: "codex",
            phase: "user_message",
          },
        });
      }
      continue;
    }

    if (row.payload.type === "agent_message") {
      const content = normalizeText(row.payload.message);

      if (content) {
        activeTurn.messages.push({
          role: "assistant",
          content,
          createdAt: ensureIso(row.timestamp, activeTurn.startedAt),
          metadata: {
            imported_from: "codex",
            phase: row.payload.phase || "assistant",
          },
        });
      }
    }
  }

  const sessionId = sessionMeta?.id || path.basename(filePath, ".jsonl");
  const indexed = titleMap.get(sessionId);
  const messages = turns.flatMap((turn) =>
    turn.messages.map((message, index) => ({
      ...message,
      id: hashId("codex-message", sessionId, turn.id, message.role, String(index)),
      conversationId: `codex:${sessionId}`,
      source: "codex",
      updatedAt: message.createdAt,
    })),
  );

  const createdAt = sessionMeta?.timestamp
    ? ensureIso(sessionMeta.timestamp, messages[0]?.createdAt || getFileMtimeIso(filePath))
    : messages[0]?.createdAt || getFileMtimeIso(filePath);
  const updatedAt = indexed?.updatedAt || messages[messages.length - 1]?.updatedAt || getFileMtimeIso(filePath);
  const title = latestTitle || indexed?.title || sessionId;

  return {
    conversation: {
      id: `codex:${sessionId}`,
      title,
      createdAt,
      updatedAt,
      metadata: {
        imported_from: "codex",
        session_id: sessionId,
        session_file: filePath,
        cwd: sessionMeta?.cwd || "",
        source: sessionMeta?.source || "",
        originator: sessionMeta?.originator || "",
        model_provider: sessionMeta?.model_provider || "",
      },
    },
    messages,
  };
}

function getClaudeProjectFiles(claudeHome) {
  const projectsRoot = path.join(claudeHome, "projects");

  if (!fs.existsSync(projectsRoot)) {
    return [];
  }

  const files = [];

  for (const projectDir of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(projectsRoot, projectDir.name);

    for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") {
        continue;
      }

      files.push(path.join(projectPath, entry.name));
    }
  }

  return files;
}

function parseClaudeSession(filePath) {
  const rows = safeReadJsonLines(filePath);
  const sessionId = path.basename(filePath, ".jsonl");
  const projectDir = path.dirname(filePath);
  const projectName = path.basename(projectDir);
  const messages = [];

  let cwd = "";
  let entrypoint = "";
  let gitBranch = "";

  for (const row of rows) {
    if (!row || row.isSidechain) {
      continue;
    }

    cwd = cwd || row.cwd || "";
    entrypoint = entrypoint || row.entrypoint || "";
    gitBranch = gitBranch || row.gitBranch || "";

    if (row.type !== "user" && row.type !== "assistant") {
      continue;
    }

    if (row.isMeta) {
      continue;
    }

    const role = row.type === "user" ? "user" : "assistant";
    const content = normalizeText(row.message?.content);

    if (!content) {
      continue;
    }

    messages.push({
      id: hashId("claude-message", sessionId, row.uuid || row.message?.id || String(messages.length)),
      conversationId: `claude:${sessionId}`,
      source: "claude",
      role,
      content,
      metadata: {
        imported_from: "claude",
        uuid: row.uuid || "",
        user_type: row.userType || "",
        entrypoint: row.entrypoint || "",
      },
      createdAt: ensureIso(row.timestamp, getFileMtimeIso(filePath)),
      updatedAt: ensureIso(row.timestamp, getFileMtimeIso(filePath)),
    });
  }

  const createdAt = messages[0]?.createdAt || getFileMtimeIso(filePath);
  const updatedAt = messages[messages.length - 1]?.updatedAt || getFileMtimeIso(filePath);
  const firstUser = messages.find((message) => message.role === "user")?.content || "";
  const title = firstUser ? firstUser.slice(0, 80) : `${projectName}:${sessionId}`;

  return {
    conversation: {
      id: `claude:${sessionId}`,
      title,
      createdAt,
      updatedAt,
      metadata: {
        imported_from: "claude",
        session_id: sessionId,
        session_file: filePath,
        project_name: projectName,
        cwd,
        entrypoint,
        git_branch: gitBranch,
      },
    },
    messages,
  };
}

function importParsedConversation(store, parsed) {
  if (!parsed.messages.length) {
    return {
      conversationsImported: 0,
      messagesImported: 0,
    };
  }

  const conversationChanged = store.upsertImportedConversation({
    id: parsed.conversation.id,
    title: parsed.conversation.title,
    metadata: parsed.conversation.metadata,
    createdAt: parsed.conversation.createdAt,
    updatedAt: parsed.conversation.updatedAt,
  });

  let importedMessages = 0;

  for (const message of parsed.messages) {
    const inserted = store.addImportedMessage({
      id: message.id,
      conversationId: message.conversationId,
      source: message.source,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });

    if (inserted) {
      importedMessages += 1;
    }
  }

  return {
    conversationsImported: conversationChanged ? 1 : 0,
    messagesImported: importedMessages,
  };
}

function updateImportCursor(store, stateKey, files) {
  if (!files.length) {
    return;
  }

  const latest = files.reduce((max, filePath) => {
    const iso = getFileMtimeIso(filePath);
    return iso > max ? iso : max;
  }, "1970-01-01T00:00:00.000Z");

  store.setState(stateKey, latest);
}

function importCodexHistory(store, options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), ".codex");
  const stateKey = "import_cursor:codex";
  const titleMap = parseCodexIndex(path.join(codexHome, "session_index.jsonl"));
  const files = listFilesRecursive(path.join(codexHome, "sessions"), (filePath) => filePath.endsWith(".jsonl"));
  const eligible = getEligibleFiles(files, store.getState(stateKey), options.full);

  let conversationsImported = 0;
  let messagesImported = 0;

  for (const filePath of eligible.sort()) {
    const parsed = parseCodexSession(filePath, titleMap);
    const result = importParsedConversation(store, parsed);
    conversationsImported += result.conversationsImported;
    messagesImported += result.messagesImported;
  }

  updateImportCursor(store, stateKey, eligible);

  return {
    source: "codex",
    filesScanned: eligible.length,
    conversationsImported,
    messagesImported,
  };
}

function importClaudeHistory(store, options = {}) {
  const claudeHome = options.claudeHome || path.join(os.homedir(), ".claude");
  const stateKey = "import_cursor:claude";
  const files = getClaudeProjectFiles(claudeHome);
  const eligible = getEligibleFiles(files, store.getState(stateKey), options.full);

  let conversationsImported = 0;
  let messagesImported = 0;

  for (const filePath of eligible.sort()) {
    const parsed = parseClaudeSession(filePath);
    const result = importParsedConversation(store, parsed);
    conversationsImported += result.conversationsImported;
    messagesImported += result.messagesImported;
  }

  updateImportCursor(store, stateKey, eligible);

  return {
    source: "claude",
    filesScanned: eligible.length,
    conversationsImported,
    messagesImported,
  };
}

function importHistory(store, options = {}) {
  const source = options.source || "all";
  const results = [];

  if (source === "codex" || source === "all") {
    results.push(importCodexHistory(store, options));
  }

  if (source === "claude" || source === "all") {
    results.push(importClaudeHistory(store, options));
  }

  const totals = results.reduce(
    (accumulator, result) => {
      accumulator.filesScanned += result.filesScanned;
      accumulator.conversationsImported += result.conversationsImported;
      accumulator.messagesImported += result.messagesImported;
      return accumulator;
    },
    {
      filesScanned: 0,
      conversationsImported: 0,
      messagesImported: 0,
    },
  );

  return {
    source,
    results,
    totals,
  };
}

module.exports = {
  importHistory,
};
