const { REALTIME_SUBSCRIBE_STATES } = require("@supabase/supabase-js");

function buildChannelName(table, conversationId) {
  const suffix = conversationId || "all";
  return `chat-sync:${table}:${suffix}:${process.pid}:${Date.now()}`;
}

function buildFilter(table, conversationId) {
  if (!conversationId) {
    return null;
  }

  if (table === "conversations") {
    return `id=eq.${conversationId}`;
  }

  if (table === "messages") {
    return `conversation_id=eq.${conversationId}`;
  }

  return null;
}

function applyRemotePayload(store, table, payload) {
  if (payload.eventType === "DELETE" || !payload.new) {
    return false;
  }

  if (table === "conversations") {
    return store.upsertConversationFromRemote(payload.new);
  }

  if (table === "messages") {
    return store.upsertMessageFromRemote(payload.new);
  }

  return false;
}

async function subscribeToTable({ client, store, table, conversationId, onEvent }) {
  const filter = buildFilter(table, conversationId);
  const channel = client.channel(buildChannelName(table, conversationId));

  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table,
      ...(filter ? { filter } : {}),
    },
    (payload) => {
      const applied = applyRemotePayload(store, table, payload);

      if (onEvent) {
        onEvent({
          applied,
          payload,
          table,
        });
      }
    },
  );

  await new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        resolve();
        return;
      }

      if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR) {
        reject(error || new Error(`Realtime channel error untuk tabel ${table}.`));
        return;
      }

      if (status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
        reject(new Error(`Realtime subscribe timeout untuk tabel ${table}.`));
      }
    });
  });

  return channel;
}

async function startRealtimeSync({ client, store, sync, conversationId, onEvent, onReady }) {
  const conversationChannel = await subscribeToTable({
    client,
    store,
    table: "conversations",
    conversationId,
    onEvent,
  });

  try {
    const messageChannel = await subscribeToTable({
      client,
      store,
      table: "messages",
      conversationId,
      onEvent,
    });

    const initial = await sync.syncOnce(store);

    if (onReady) {
      onReady({
        conversationId: conversationId || null,
        initial,
      });
    }

    return {
      stop: async () => {
        await Promise.all([
          client.removeChannel(messageChannel),
          client.removeChannel(conversationChannel),
        ]);
      },
    };
  } catch (error) {
    await client.removeChannel(conversationChannel);
    throw error;
  }
}

module.exports = {
  startRealtimeSync,
};
