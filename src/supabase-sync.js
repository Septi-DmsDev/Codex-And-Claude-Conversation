const { createClient } = require("@supabase/supabase-js");

const REMOTE_CURSOR_START = "1970-01-01T00:00:00.000Z";

function chunk(items, size) {
  const groups = [];

  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }

  return groups;
}

function bumpIsoTimestamp(iso) {
  return new Date(new Date(iso).getTime() + 1).toISOString();
}

function createSupabaseClient({ supabaseUrl, supabaseKey }) {
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function createSupabaseSync({ supabaseUrl, supabaseKey }) {
  const client = createSupabaseClient({ supabaseUrl, supabaseKey });

  function formatSyncError(table, error) {
    if (error?.message && error.message.includes("deleted_at")) {
      return `Gagal push ${table}: schema Supabase belum punya kolom deleted_at. Jalankan ulang supabase/schema.sql terbaru di SQL Editor, lalu coba sync lagi.`;
    }

    return `Gagal push ${table}: ${error.message}`;
  }

  async function pushTable(table, rows, onSynced) {
    if (!rows.length) {
      return 0;
    }

    for (const batch of chunk(rows, 250)) {
      const { error } = await client.from(table).upsert(batch, { onConflict: "id" });

      if (error) {
        throw new Error(formatSyncError(table, error));
      }

      onSynced(batch.map((row) => row.id));
    }

    return rows.length;
  }

  async function pushLocalChanges(store) {
    const syncedAt = new Date().toISOString();
    const conversations = store.getPendingConversations();
    const messages = store.getPendingMessages();

    const pushedConversations = await pushTable("conversations", conversations, (ids) => {
      store.markConversationsSynced(ids, syncedAt);
    });

    const pushedMessages = await pushTable("messages", messages, (ids) => {
      store.markMessagesSynced(ids, syncedAt);
    });

    return {
      pushedConversations,
      pushedMessages,
    };
  }

  async function pullRemoteRows(table, cursor) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .gte("updated_at", cursor)
      .order("updated_at", { ascending: true })
      .limit(2000);

    if (error) {
      throw new Error(`Gagal pull ${table}: ${error.message}`);
    }

    return data || [];
  }

  async function pullRemoteChanges(store) {
    const cursor = store.getRemoteCursor() || REMOTE_CURSOR_START;
    const remoteConversations = await pullRemoteRows("conversations", cursor);
    const remoteMessages = await pullRemoteRows("messages", cursor);

    let maxUpdatedAt = cursor;
    let pulledConversations = 0;
    let pulledMessages = 0;

    for (const row of remoteConversations) {
      if (store.upsertConversationFromRemote(row)) {
        pulledConversations += 1;
      }

      if (row.updated_at > maxUpdatedAt) {
        maxUpdatedAt = row.updated_at;
      }
    }

    for (const row of remoteMessages) {
      if (store.upsertMessageFromRemote(row)) {
        pulledMessages += 1;
      }

      if (row.updated_at > maxUpdatedAt) {
        maxUpdatedAt = row.updated_at;
      }
    }

    if (maxUpdatedAt > cursor) {
      store.setRemoteCursor(bumpIsoTimestamp(maxUpdatedAt));
    }

    return {
      pulledConversations,
      pulledMessages,
      cursor: maxUpdatedAt,
    };
  }

  async function syncOnce(store) {
    const push = await pushLocalChanges(store);
    const pull = await pullRemoteChanges(store);

    return { push, pull };
  }

  async function watch(store, intervalMs, onCycle) {
    while (true) {
      const result = await syncOnce(store);

      if (onCycle) {
        onCycle(result);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async function close() {
    try {
      if (typeof client.removeAllChannels === "function") {
        await client.removeAllChannels();
      }
    } catch {}

    try {
      if (client.realtime && typeof client.realtime.disconnect === "function") {
        client.realtime.disconnect();
      }
    } catch {}
  }

  return {
    client,
    close,
    pullRemoteChanges,
    pushLocalChanges,
    syncOnce,
    watch,
  };
}

module.exports = {
  createSupabaseClient,
  createSupabaseSync,
};
