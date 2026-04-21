const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SYNC_PENDING = "pending";
const SYNC_SYNCED = "synced";

function toJson(value) {
  return JSON.stringify(value || {});
}

function fromJson(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function hasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

class LocalStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT '${SYNC_PENDING}',
        last_synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT '${SYNC_PENDING}',
        last_synced_at TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_sync_status ON conversations(sync_status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_sync_status ON messages(sync_status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    `);

    if (!hasColumn(this.db, "conversations", "deleted_at")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    }

    if (!hasColumn(this.db, "messages", "deleted_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN deleted_at TEXT");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at ON conversations(deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at, updated_at);
    `);
  }

  hasConversation(id) {
    const row = this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
    return Boolean(row);
  }

  hasMessage(id) {
    const row = this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
    return Boolean(row);
  }

  createConversation({ id, title, metadata = {}, createdAt, updatedAt, syncStatus = SYNC_PENDING }) {
    this.db
      .prepare(
        `
          INSERT INTO conversations (id, title, metadata, created_at, updated_at, sync_status, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            metadata = excluded.metadata,
            updated_at = excluded.updated_at,
            sync_status = excluded.sync_status,
            deleted_at = NULL
        `,
      )
      .run(id, title, toJson(metadata), createdAt, updatedAt, syncStatus);
  }

  upsertImportedConversation({ id, title, metadata = {}, createdAt, updatedAt }) {
    const existing = this.db
      .prepare("SELECT title, metadata, created_at, updated_at FROM conversations WHERE id = ?")
      .get(id);

    const metadataJson = toJson(metadata);

    if (
      existing &&
      existing.title === title &&
      existing.metadata === metadataJson &&
      existing.created_at === createdAt &&
      existing.updated_at === updatedAt
    ) {
      return false;
    }

    this.createConversation({
      id,
      title,
      metadata,
      createdAt,
      updatedAt,
      syncStatus: SYNC_PENDING,
    });

    return true;
  }

  addMessage({
    id,
    conversationId,
    source,
    role,
    content,
    metadata = {},
    createdAt,
    updatedAt,
    syncStatus = SYNC_PENDING,
  }) {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO messages (
              id, conversation_id, source, role, content, metadata, created_at, updated_at, sync_status, deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
              source = excluded.source,
              role = excluded.role,
              content = excluded.content,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at,
              sync_status = excluded.sync_status,
              deleted_at = NULL
          `,
        )
        .run(id, conversationId, source, role, content, toJson(metadata), createdAt, updatedAt, syncStatus);

      this.db
        .prepare(
          `
            UPDATE conversations
            SET updated_at = ?, sync_status = ?
            WHERE id = ?
          `,
        )
        .run(updatedAt, syncStatus, conversationId);
    });

    insert();
  }

  addImportedMessage(message) {
    if (this.hasMessage(message.id)) {
      return false;
    }

    this.addMessage({
      ...message,
      syncStatus: SYNC_PENDING,
    });

    return true;
  }

  getPendingConversations(limit = 500) {
    return this.db
      .prepare(
        `
          SELECT id, title, metadata, created_at, updated_at, deleted_at
          FROM conversations
          WHERE sync_status = ?
          ORDER BY updated_at ASC
          LIMIT ?
        `,
      )
      .all(SYNC_PENDING, limit)
      .map((row) => ({
        ...row,
        metadata: fromJson(row.metadata),
      }));
  }

  getPendingMessages(limit = 1000) {
    return this.db
      .prepare(
        `
          SELECT id, conversation_id, source, role, content, metadata, created_at, updated_at, deleted_at
          FROM messages
          WHERE sync_status = ?
          ORDER BY updated_at ASC
          LIMIT ?
        `,
      )
      .all(SYNC_PENDING, limit)
      .map((row) => ({
        ...row,
        metadata: fromJson(row.metadata),
      }));
  }

  markConversationsSynced(ids, syncedAt) {
    if (!ids.length) {
      return;
    }

    const stmt = this.db.prepare(
      "UPDATE conversations SET sync_status = ?, last_synced_at = ? WHERE id = ?",
    );
    const run = this.db.transaction((items) => {
      for (const id of items) {
        stmt.run(SYNC_SYNCED, syncedAt, id);
      }
    });

    run(ids);
  }

  markMessagesSynced(ids, syncedAt) {
    if (!ids.length) {
      return;
    }

    const stmt = this.db.prepare("UPDATE messages SET sync_status = ?, last_synced_at = ? WHERE id = ?");
    const run = this.db.transaction((items) => {
      for (const id of items) {
        stmt.run(SYNC_SYNCED, syncedAt, id);
      }
    });

    run(ids);
  }

  getRemoteCursor() {
    return this.getState("remote_cursor");
  }

  setRemoteCursor(value) {
    this.setState("remote_cursor", value);
  }

  getState(key) {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this.db
      .prepare(
        `
          INSERT INTO sync_state(key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      )
      .run(key, value);
  }

  upsertConversationFromRemote(row) {
    const local = this.db
      .prepare("SELECT updated_at, sync_status FROM conversations WHERE id = ?")
      .get(row.id);

    if (local && local.sync_status === SYNC_PENDING && local.updated_at > row.updated_at) {
      return false;
    }

    this.db
      .prepare(
        `
          INSERT INTO conversations (id, title, metadata, created_at, updated_at, sync_status, last_synced_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            metadata = excluded.metadata,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            sync_status = excluded.sync_status,
            last_synced_at = excluded.last_synced_at,
            deleted_at = excluded.deleted_at
        `,
      )
      .run(
        row.id,
        row.title,
        toJson(row.metadata),
        row.created_at,
        row.updated_at,
        SYNC_SYNCED,
        row.updated_at,
        row.deleted_at || null,
      );

    return true;
  }

  upsertMessageFromRemote(row) {
    const local = this.db.prepare("SELECT updated_at, sync_status FROM messages WHERE id = ?").get(row.id);

    if (local && local.sync_status === SYNC_PENDING && local.updated_at > row.updated_at) {
      return false;
    }

    this.db
      .prepare(
        `
          INSERT INTO messages (
            id, conversation_id, source, role, content, metadata, created_at, updated_at, sync_status, last_synced_at, deleted_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            source = excluded.source,
            role = excluded.role,
            content = excluded.content,
            metadata = excluded.metadata,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            sync_status = excluded.sync_status,
            last_synced_at = excluded.last_synced_at,
            deleted_at = excluded.deleted_at
        `,
      )
      .run(
        row.id,
        row.conversation_id,
        row.source,
        row.role,
        row.content,
        toJson(row.metadata),
        row.created_at,
        row.updated_at,
        SYNC_SYNCED,
        row.updated_at,
        row.deleted_at || null,
      );

    return true;
  }

  listConversations({ includeDeleted = true } = {}) {
    const whereClause = includeDeleted ? "" : "WHERE c.deleted_at IS NULL";
    return this.db
      .prepare(
        `
          SELECT
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            c.sync_status,
            c.deleted_at,
            COUNT(m.id) AS message_count
          FROM conversations c
          LEFT JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
          ${whereClause}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
        `,
      )
      .all();
  }

  listConversationsForDashboard({ query = "", source = "", includeDeleted = false, limit = 200 } = {}) {
    const where = [];
    const params = [];

    if (query) {
      where.push("(c.id LIKE ? OR c.title LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    if (source) {
      where.push(
        "EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id = c.id AND sm.source = ? AND sm.deleted_at IS NULL)",
      );
      params.push(source);
    }

    if (!includeDeleted) {
      where.push("c.deleted_at IS NULL");
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    return this.db
      .prepare(
        `
          SELECT
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            c.sync_status,
            c.last_synced_at,
            c.deleted_at,
            COUNT(m.id) AS message_count,
            MIN(m.created_at) AS first_message_at,
            MAX(m.created_at) AS last_message_at,
            GROUP_CONCAT(DISTINCT m.source) AS sources
          FROM conversations c
          LEFT JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
          ${whereClause}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)
      .map((row) => ({
        ...row,
        sources: row.sources ? row.sources.split(",").filter(Boolean) : [],
      }));
  }

  getConversation(conversationId, { includeDeleted = true } = {}) {
    const row = this.db
      .prepare(
        `
          SELECT id, title, metadata, created_at, updated_at, sync_status, last_synced_at, deleted_at
          FROM conversations
          WHERE id = ?
            ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        `,
      )
      .get(conversationId);

    if (!row) {
      return null;
    }

    return {
      ...row,
      metadata: fromJson(row.metadata),
    };
  }

  getConversationsForExport({ conversationId } = {}) {
    if (conversationId) {
      const conversation = this.getConversation(conversationId);
      return conversation && !conversation.deleted_at ? [conversation] : [];
    }

    return this.db
      .prepare(
        `
          SELECT id, title, metadata, created_at, updated_at, sync_status, last_synced_at
          FROM conversations
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC
        `,
      )
      .all()
      .map((row) => ({
        ...row,
        metadata: fromJson(row.metadata),
      }));
  }

  getSummary() {
    const counts = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM conversations WHERE deleted_at IS NULL) AS conversation_count,
            (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS message_count,
            (SELECT COUNT(*) FROM conversations WHERE deleted_at IS NOT NULL) AS deleted_conversation_count,
            (SELECT COUNT(*) FROM messages WHERE deleted_at IS NOT NULL) AS deleted_message_count,
            (SELECT COUNT(*) FROM conversations WHERE sync_status = '${SYNC_PENDING}') AS pending_conversations,
            (SELECT COUNT(*) FROM messages WHERE sync_status = '${SYNC_PENDING}') AS pending_messages,
            (SELECT MAX(updated_at) FROM conversations) AS last_conversation_update,
            (SELECT MAX(created_at) FROM messages WHERE deleted_at IS NULL) AS last_message_at
        `,
      )
      .get();

    const perSource = this.db
      .prepare(
        `
          SELECT source, COUNT(*) AS count
          FROM messages
          WHERE deleted_at IS NULL
          GROUP BY source
          ORDER BY count DESC, source ASC
        `,
      )
      .all();

    return {
      ...counts,
      per_source: perSource,
      remote_cursor: this.getRemoteCursor(),
      import_cursor_codex: this.getState("import_cursor:codex"),
      import_cursor_claude: this.getState("import_cursor:claude"),
    };
  }

  getTranscript(conversationId, { includeDeleted = false } = {}) {
    const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
    return this.db
      .prepare(
        `
          SELECT id, source, role, content, created_at, updated_at, metadata, deleted_at
          FROM messages
          WHERE conversation_id = ?
          ${deletedClause}
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(conversationId)
      .map((row) => ({
        ...row,
        metadata: fromJson(row.metadata),
      }));
  }

  deleteConversation(conversationId, deletedAt = new Date().toISOString()) {
    const run = this.db.transaction(() => {
      const conversation = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);

      if (!conversation) {
        throw new Error("Conversation tidak ditemukan.");
      }

      this.db
        .prepare(
          `
            UPDATE conversations
            SET deleted_at = ?, updated_at = ?, sync_status = ?
            WHERE id = ?
          `,
        )
        .run(deletedAt, deletedAt, SYNC_PENDING, conversationId);

      this.db
        .prepare(
          `
            UPDATE messages
            SET deleted_at = ?, updated_at = ?, sync_status = ?
            WHERE conversation_id = ?
          `,
        )
        .run(deletedAt, deletedAt, SYNC_PENDING, conversationId);
    });

    run();
  }

  restoreConversation(conversationId, restoredAt = new Date().toISOString()) {
    const run = this.db.transaction(() => {
      const conversation = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);

      if (!conversation) {
        throw new Error("Conversation tidak ditemukan.");
      }

      this.db
        .prepare(
          `
            UPDATE conversations
            SET deleted_at = NULL, updated_at = ?, sync_status = ?
            WHERE id = ?
          `,
        )
        .run(restoredAt, SYNC_PENDING, conversationId);

      this.db
        .prepare(
          `
            UPDATE messages
            SET deleted_at = NULL, updated_at = ?, sync_status = ?
            WHERE conversation_id = ?
          `,
        )
        .run(restoredAt, SYNC_PENDING, conversationId);
    });

    run();
  }
}

module.exports = {
  LocalStore,
  SYNC_PENDING,
  SYNC_SYNCED,
};
