const crypto = require("crypto");
const { dbPath, defaultSource, getSupabaseKey, pollIntervalMs, requireSupabaseEnv, supabaseUrl } = require("./config");
const { createDashboardServer } = require("./dashboard-server");
const { importHistory } = require("./history-import");
const { LocalStore } = require("./local-store");
const { writeNativeMirror } = require("./native-writeback");
const { createSupabaseClient, createSupabaseSync } = require("./supabase-sync");
const { startRealtimeSync } = require("./realtime");

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : true;
    args[key] = value;

    if (value !== true) {
      index += 1;
    }
  }

  return args;
}

function parseMetadata(raw) {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Metadata harus JSON valid. Detail: ${error.message}`);
  }
}

function createStore() {
  const store = new LocalStore(dbPath);
  store.init();
  return store;
}

function ensureConversation(store, conversationId, title) {
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
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function addMessageToStore(store, args) {
  const conversationId = args.conversation;
  const content = args.content;

  if (!conversationId || !content) {
    throw new Error("--conversation dan --content wajib diisi.");
  }

  ensureConversation(store, conversationId, args.title);

  const timestamp = nowIso();

  store.addMessage({
    id: args.id || crypto.randomUUID(),
    conversationId,
    source: args.source || defaultSource,
    role: args.role || "assistant",
    content,
    metadata: parseMetadata(args.metadata),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    conversationId,
  };
}

function printHelp() {
  console.log(`
Perintah:
  npm run init
  npm run conversation:create -- --id shared-thread --title "Shared Thread"
  npm run delete:conversation -- --conversation shared-thread
  npm run history:backfill -- --source codex
  npm run dashboard
  npm run native:writeback -- --target codex
  npm run message:add -- --conversation shared-thread --content "Halo dari Codex"
  npm run message:send -- --conversation shared-thread --content "Halo cloud"
  npm run sync
  npm run watch
  npm run realtime -- --conversation shared-thread
  npm run transcript -- --conversation shared-thread
  npm run conversations
  `);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const store = createStore();

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "init") {
    console.log(`Local database siap di ${dbPath}`);
    return;
  }

  if (command === "create-conversation") {
    const id = args.id || crypto.randomUUID();
    const title = args.title || id;
    const timestamp = nowIso();

    store.createConversation({
      id,
      title,
      metadata: parseMetadata(args.metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    console.log(`Conversation dibuat: ${id}`);
    return;
  }

  if (command === "delete-conversation") {
    const conversationId = args.conversation;

    if (!conversationId) {
      throw new Error("--conversation wajib diisi.");
    }

    store.deleteConversation(conversationId);

    if (args.push) {
      requireSupabaseEnv();
      const sync = createSupabaseSync({
        supabaseUrl,
        supabaseKey: getSupabaseKey(),
      });
      try {
        const push = await sync.pushLocalChanges(store);
        console.log(
          `Conversation dihapus secara soft delete dan dipush: ${conversationId} | pushed conversations=${push.pushedConversations} messages=${push.pushedMessages}`,
        );
      } finally {
        await sync.close();
      }
      return;
    }

    console.log(`Conversation dihapus secara soft delete: ${conversationId}`);
    return;
  }

  if (command === "restore-conversation") {
    const conversationId = args.conversation;

    if (!conversationId) {
      throw new Error("--conversation wajib diisi.");
    }

    store.restoreConversation(conversationId);

    if (args.push) {
      requireSupabaseEnv();
      const sync = createSupabaseSync({
        supabaseUrl,
        supabaseKey: getSupabaseKey(),
      });
      try {
        const push = await sync.pushLocalChanges(store);
        console.log(
          `Conversation direstore dan dipush: ${conversationId} | pushed conversations=${push.pushedConversations} messages=${push.pushedMessages}`,
        );
      } finally {
        await sync.close();
      }
      return;
    }

    console.log(`Conversation direstore: ${conversationId}`);
    return;
  }

  if (command === "backfill-history") {
    const source = args.source || "all";
    const full = Boolean(args.full);
    const result = importHistory(store, {
      source,
      full,
    });

    if (args.push) {
      requireSupabaseEnv();
      const sync = createSupabaseSync({
        supabaseUrl,
        supabaseKey: getSupabaseKey(),
      });
      try {
        const push = await sync.pushLocalChanges(store);
        console.log(JSON.stringify({ ...result, push }, null, 2));
      } finally {
        await sync.close();
      }
      return;
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "dashboard") {
    const port = Number(args.port || 3030);
    const server = createDashboardServer({ port });
    server.listen();
    return;
  }

  if (command === "native-writeback") {
    const target = args.target;

    if (!target) {
      throw new Error("--target wajib diisi dengan codex atau claude.");
    }

    const result = writeNativeMirror(store, {
      target,
      conversationId: args.conversation || "",
      full: Boolean(args.full),
      codexHome: args["codex-home"] || "",
      claudeHome: args["claude-home"] || "",
      projectName: args["project-name"] || "",
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "add-message") {
    const { conversationId } = addMessageToStore(store, args);

    console.log(`Message masuk ke conversation ${conversationId}`);
    return;
  }

  if (command === "send-message") {
    requireSupabaseEnv();
    const { conversationId } = addMessageToStore(store, args);
    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });
    try {
      const push = await sync.pushLocalChanges(store);

      console.log(
        `Message terkirim ke conversation ${conversationId} | pushed conversations=${push.pushedConversations} messages=${push.pushedMessages}`,
      );
    } finally {
      await sync.close();
    }
    return;
  }

  if (command === "list-conversations") {
    const conversations = store.listConversations();

    if (!conversations.length) {
      console.log("Belum ada conversation.");
      return;
    }

    for (const conversation of conversations) {
      console.log(
        `${conversation.id} | ${conversation.title} | ${conversation.message_count} messages | ${conversation.sync_status} | ${conversation.updated_at}`,
      );
    }

    return;
  }

  if (command === "transcript") {
    const conversationId = args.conversation;

    if (!conversationId) {
      throw new Error("--conversation wajib diisi.");
    }

    const transcript = store.getTranscript(conversationId);

    if (!transcript.length) {
      console.log("Conversation kosong atau belum ada.");
      return;
    }

    for (const message of transcript) {
      console.log(`[${message.created_at}] ${message.source}/${message.role}: ${message.content}`);
    }

    return;
  }

  if (command === "sync") {
    requireSupabaseEnv();
    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });
    try {
      const result = await sync.syncOnce(store);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await sync.close();
    }
    return;
  }

  if (command === "watch") {
    requireSupabaseEnv();
    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });

    console.log(`Watch sync aktif. Interval ${pollIntervalMs} ms.`);

    await sync.watch(store, pollIntervalMs, (result) => {
      console.log(`[${nowIso()}] ${JSON.stringify(result)}`);
    });
    return;
  }

  if (command === "realtime") {
    requireSupabaseEnv();

    const sync = createSupabaseSync({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });
    const client = createSupabaseClient({
      supabaseUrl,
      supabaseKey: getSupabaseKey(),
    });

    const controller = await startRealtimeSync({
      client,
      store,
      sync,
      conversationId: args.conversation,
      onReady: ({ initial, conversationId }) => {
        const scope = conversationId ? `conversation=${conversationId}` : "all conversations";
        console.log(
          `Realtime aktif untuk ${scope} | initial push=${initial.push.pushedMessages} pull=${initial.pull.pulledMessages}`,
        );
      },
      onEvent: ({ table, payload, applied }) => {
        if (!applied) {
          return;
        }

        if (table === "messages" && payload.new) {
          console.log(
            `[${payload.new.created_at}] realtime/${payload.new.source}/${payload.new.role}: ${payload.new.content}`,
          );
          return;
        }

        if (table === "conversations" && payload.new) {
          console.log(`[${payload.new.updated_at}] realtime/conversation: ${payload.new.id}`);
        }
      },
    });

    const shutdown = async () => {
      await controller.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise(() => {});
  }

  throw new Error(`Perintah tidak dikenal: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
