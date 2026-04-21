const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function hashHex(...parts) {
  return crypto.createHash("sha1").update(parts.join("::")).digest("hex");
}

function deterministicUuid(seed) {
  const hex = hashHex(seed).slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function escapeProjectName(value) {
  return value
    .replace(/:/g, "-")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
}

function toIso(value, fallback) {
  const iso = new Date(value || fallback || Date.now()).toISOString();
  return iso === "Invalid Date" ? new Date().toISOString() : iso;
}

function formatCodexRolloutName(createdAt, sessionId) {
  const date = new Date(createdAt);
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/:/g, "-");

  return `rollout-${stamp}-${sessionId}.jsonl`;
}

function groupTranscriptIntoTurns(transcript) {
  const turns = [];
  let current = null;

  for (const message of transcript) {
    if (!current || message.role === "user") {
      current = {
        turnId: deterministicUuid(`${message.id}:turn`),
        startedAt: message.created_at,
        messages: [],
      };
      turns.push(current);
    }

    current.messages.push(message);
  }

  return turns;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
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

function writeJsonLines(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function updateCodexSessionIndex(indexPath, entry) {
  const rows = readJsonLines(indexPath);
  const map = new Map();

  for (const row of rows) {
    if (row && row.id) {
      map.set(row.id, row);
    }
  }

  map.set(entry.id, entry);
  const merged = Array.from(map.values()).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  writeJsonLines(indexPath, merged);
}

function buildCodexRows({ nativeSessionId, conversation, transcript, cwd }) {
  const createdAt = toIso(conversation.created_at, transcript[0]?.created_at);
  const turns = groupTranscriptIntoTurns(transcript);
  const rows = [
    {
      timestamp: createdAt,
      type: "session_meta",
      payload: {
        id: nativeSessionId,
        timestamp: createdAt,
        cwd,
        originator: "cloud_sync",
        cli_version: "cloud-sync",
        source: "cloud_sync",
        model_provider: "supabase",
      },
    },
    {
      timestamp: createdAt,
      type: "event_msg",
      payload: {
        type: "thread_name_updated",
        thread_id: nativeSessionId,
        thread_name: `[Cloud Sync] ${conversation.title}`,
      },
    },
  ];

  for (const turn of turns) {
    rows.push({
      timestamp: toIso(turn.startedAt, createdAt),
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turn.turnId,
        started_at: Math.floor(new Date(turn.startedAt).getTime() / 1000),
        model_context_window: 0,
        collaboration_mode_kind: "default",
      },
    });

    let lastAssistantMessage = null;

    for (const message of turn.messages) {
      if (message.role === "user") {
        rows.push({
          timestamp: toIso(message.created_at, createdAt),
          type: "event_msg",
          payload: {
            type: "user_message",
            message: message.content,
            images: [],
            local_images: [],
            text_elements: [],
          },
        });
        continue;
      }

      rows.push({
        timestamp: toIso(message.created_at, createdAt),
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: message.content,
          phase: "final_answer",
          memory_citation: null,
        },
      });

      lastAssistantMessage = message.content;
    }

    if (lastAssistantMessage) {
      const lastTimestamp = turn.messages[turn.messages.length - 1]?.created_at || turn.startedAt;
      rows.push({
        timestamp: toIso(lastTimestamp, createdAt),
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turn.turnId,
          last_agent_message: lastAssistantMessage,
          completed_at: Math.floor(new Date(lastTimestamp).getTime() / 1000),
          duration_ms: Math.max(new Date(lastTimestamp).getTime() - new Date(turn.startedAt).getTime(), 0),
        },
      });
    }
  }

  return rows;
}

function writeCodexMirror(store, options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), ".codex");
  const conversations = store.getConversationsForExport({
    conversationId: options.conversationId,
    projectId: options.projectId || "",
    scopeMode: options.scopeMode || "",
    onlyAllowedForAi: options.onlyAllowedForAi !== false,
  });

  let exported = 0;
  let skipped = 0;

  for (const conversation of conversations) {
    const exportScope = hashHex("codex", path.resolve(codexHome));
    const stateKey = `native_export:codex:${exportScope}:${conversation.id}`;
    const exportedAt = store.getState(stateKey);

    if (!options.full && exportedAt && exportedAt >= conversation.updated_at) {
      skipped += 1;
      continue;
    }

    const transcript = store.getTranscript(conversation.id);

    if (!transcript.length) {
      skipped += 1;
      continue;
    }

    const nativeSessionId = deterministicUuid(`codex-native:${conversation.id}`);
    const createdAt = toIso(conversation.created_at, transcript[0].created_at);
    const date = new Date(createdAt);
    const sessionDir = path.join(
      codexHome,
      "sessions",
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    const rolloutName = formatCodexRolloutName(createdAt, nativeSessionId);
    const sessionPath = path.join(sessionDir, rolloutName);
    const cwd = conversation.metadata.cwd || process.cwd();

    writeJsonLines(
      sessionPath,
      buildCodexRows({
        nativeSessionId,
        conversation,
        transcript,
        cwd,
      }),
    );

    updateCodexSessionIndex(path.join(codexHome, "session_index.jsonl"), {
      id: nativeSessionId,
      thread_name: `[Cloud Sync] ${conversation.title}`,
      updated_at: conversation.updated_at,
    });

    store.setState(stateKey, conversation.updated_at);
    store.setState(`${stateKey}:path`, sessionPath);
    exported += 1;
  }

  return {
    target: "codex",
    destination: codexHome,
    conversationsConsidered: conversations.length,
    conversationsExported: exported,
    conversationsSkipped: skipped,
  };
}

function createClaudeMessageRow({ sessionId, cwd, gitBranch, previousUuid, message, index }) {
  const uuid = deterministicUuid(`claude-native:${sessionId}:${message.id}:${index}`);
  const role = message.role;

  if (role === "assistant") {
    return {
      row: {
        parentUuid: previousUuid,
        isSidechain: false,
        type: "assistant",
        uuid,
        timestamp: toIso(message.created_at),
        userType: "external",
        entrypoint: "cloud-sync",
        cwd,
        sessionId,
        version: "cloud-sync",
        gitBranch,
        message: {
          id: uuid,
          container: null,
          model: "cloud-sync",
          role: "assistant",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          type: "message",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: {
              web_search_requests: 0,
              web_fetch_requests: 0,
            },
            service_tier: null,
            cache_creation: {
              ephemeral_1h_input_tokens: 0,
              ephemeral_5m_input_tokens: 0,
            },
            inference_geo: null,
            iterations: null,
            speed: null,
          },
          content: [
            {
              type: "text",
              text: message.content,
            },
          ],
          context_management: null,
        },
      },
      uuid,
    };
  }

  return {
    row: {
      parentUuid: previousUuid,
      isSidechain: false,
      type: "user",
      uuid,
      timestamp: toIso(message.created_at),
      userType: "external",
      entrypoint: "cloud-sync",
      cwd,
      sessionId,
      version: "cloud-sync",
      gitBranch,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: message.content,
          },
        ],
      },
    },
    uuid,
  };
}

function writeClaudeMirror(store, options = {}) {
  const claudeHome = options.claudeHome || path.join(os.homedir(), ".claude");
  const projectName = escapeProjectName(options.projectName || "cloud-sync");
  const projectDir = path.join(claudeHome, "projects", projectName);
  const conversations = store.getConversationsForExport({
    conversationId: options.conversationId,
    projectId: options.projectId || "",
    scopeMode: options.scopeMode || "",
    onlyAllowedForAi: options.onlyAllowedForAi !== false,
  });

  let exported = 0;
  let skipped = 0;

  for (const conversation of conversations) {
    const exportScope = hashHex("claude", path.resolve(projectDir));
    const stateKey = `native_export:claude:${exportScope}:${conversation.id}`;
    const exportedAt = store.getState(stateKey);

    if (!options.full && exportedAt && exportedAt >= conversation.updated_at) {
      skipped += 1;
      continue;
    }

    const transcript = store.getTranscript(conversation.id);

    if (!transcript.length) {
      skipped += 1;
      continue;
    }

    const sessionId = deterministicUuid(`claude-native:${conversation.id}`);
    const cwd = conversation.metadata.cwd || process.cwd();
    const gitBranch = conversation.metadata.git_branch || "";
    const rows = [
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: toIso(conversation.created_at, transcript[0].created_at),
        sessionId,
      },
      {
        type: "queue-operation",
        operation: "dequeue",
        timestamp: toIso(conversation.created_at, transcript[0].created_at),
        sessionId,
      },
    ];

    let previousUuid = null;

    transcript.forEach((message, index) => {
      const next = createClaudeMessageRow({
        sessionId,
        cwd,
        gitBranch,
        previousUuid,
        message,
        index,
      });
      rows.push(next.row);
      previousUuid = next.uuid;
    });

    const targetPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeJsonLines(targetPath, rows);

    store.setState(stateKey, conversation.updated_at);
    store.setState(`${stateKey}:path`, targetPath);
    exported += 1;
  }

  return {
    target: "claude",
    destination: projectDir,
    conversationsConsidered: conversations.length,
    conversationsExported: exported,
    conversationsSkipped: skipped,
  };
}

function writeNativeMirror(store, options = {}) {
  if (options.target === "codex") {
    return writeCodexMirror(store, options);
  }

  if (options.target === "claude") {
    return writeClaudeMirror(store, options);
  }

  throw new Error(`Target native tidak dikenal: ${options.target}`);
}

module.exports = {
  writeNativeMirror,
};
