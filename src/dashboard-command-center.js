const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");

function buildPowerShellInvocation(projectRoot, scriptName, scriptArgs = []) {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(projectRoot, scriptName),
      ...scriptArgs,
    ],
    cwd: projectRoot,
    env: { ...process.env },
  };
}

function buildNodeInvocation(projectRoot, cliArgs = [], envOverrides = {}) {
  return {
    command: process.execPath,
    args: [path.join(projectRoot, "src", "cli.js"), ...cliArgs],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envOverrides,
    },
  };
}

function toScriptArgPairs(flag, value) {
  if (!value) {
    return [];
  }

  return [flag, value];
}

function appendLog(job, chunk, streamName) {
  const line = `[${new Date().toISOString()}] ${streamName}: ${chunk}`;
  job.log = `${job.log}${line}`;

  if (job.log.length > 120000) {
    job.log = job.log.slice(job.log.length - 120000);
  }
}

function buildPresetCatalog(projectRoot) {
  return [
    {
      id: "codex-backfill-local",
      label: "Codex Backfill Local",
      agent: "codex",
      category: "backfill",
      description: "Scan history native Codex ke database lokal tanpa push cloud.",
      help: "Pakai ini saat Anda ingin mengejar gap percakapan Codex ke .data lokal tanpa menyentuh cloud.",
      kind: "foreground",
      build() {
        return buildNodeInvocation(
          projectRoot,
          ["backfill-history", "--source", "codex"],
          {
            LOCAL_DB_PATH: ".data/codex-chat.sqlite",
            DEFAULT_SOURCE: "codex",
          },
        );
      },
    },
    {
      id: "claude-backfill-local",
      label: "Claude Backfill Local",
      agent: "claude",
      category: "backfill",
      description: "Scan history native Claude ke database lokal tanpa push cloud.",
      help: "Pakai ini saat Anda ingin menarik history Claude ke .data lokal lebih dulu tanpa sinkron cloud.",
      kind: "foreground",
      build() {
        return buildNodeInvocation(
          projectRoot,
          ["backfill-history", "--source", "claude"],
          {
            LOCAL_DB_PATH: ".data/claude-chat.sqlite",
            DEFAULT_SOURCE: "claude",
          },
        );
      },
    },
    {
      id: "codex-backfill-push",
      label: "Codex Backfill + Push",
      agent: "codex",
      category: "backfill",
      description: "Scan history native Codex lalu push gap baru ke cloud.",
      help: "Pakai ini saat Codex sempat dipakai tanpa script lalu Anda ingin mengejar selisih sampai ke Supabase.",
      kind: "foreground",
      build() {
        return buildNodeInvocation(
          projectRoot,
          ["backfill-history", "--source", "codex", "--push"],
          {
            LOCAL_DB_PATH: ".data/codex-chat.sqlite",
            DEFAULT_SOURCE: "codex",
          },
        );
      },
    },
    {
      id: "claude-backfill-push",
      label: "Claude Backfill + Push",
      agent: "claude",
      category: "backfill",
      description: "Scan history native Claude lalu push gap baru ke cloud.",
      help: "Pakai ini saat Claude punya history baru yang belum masuk ke cloud.",
      kind: "foreground",
      build() {
        return buildNodeInvocation(
          projectRoot,
          ["backfill-history", "--source", "claude", "--push"],
          {
            LOCAL_DB_PATH: ".data/claude-chat.sqlite",
            DEFAULT_SOURCE: "claude",
          },
        );
      },
    },
    {
      id: "codex-sync-once",
      label: "Codex Sync Once",
      agent: "codex",
      category: "sync",
      description: "Jalankan start-codex.ps1 dalam mode sync satu kali.",
      help: "Pakai ini untuk push dan pull satu putaran tanpa watcher terus-menerus.",
      kind: "foreground",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-codex.ps1", [
          "-Mode",
          "sync",
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
        ]);
      },
    },
    {
      id: "claude-sync-once",
      label: "Claude Sync Once",
      agent: "claude",
      category: "sync",
      description: "Jalankan start-claude.ps1 dalam mode sync satu kali.",
      help: "Pakai ini untuk sinkronisasi satu kali dari sisi Claude.",
      kind: "foreground",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-claude.ps1", [
          "-Mode",
          "sync",
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
        ]);
      },
    },
    {
      id: "codex-watch",
      label: "Codex Watch",
      agent: "codex",
      category: "watch",
      description: "Menjalankan watcher Codex secara background.",
      help: "Pakai ini jika Anda ingin Codex terus sync berkala dengan polling.",
      kind: "background",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-codex.ps1", [
          "-Mode",
          "watch",
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
        ]);
      },
    },
    {
      id: "claude-watch",
      label: "Claude Watch",
      agent: "claude",
      category: "watch",
      description: "Menjalankan watcher Claude secara background.",
      help: "Pakai ini jika Claude perlu polling sync terus-menerus di background.",
      kind: "background",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-claude.ps1", [
          "-Mode",
          "watch",
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
        ]);
      },
    },
    {
      id: "codex-realtime",
      label: "Codex Realtime",
      agent: "codex",
      category: "realtime",
      description: "Menjalankan listener realtime Codex secara background.",
      help: "Pakai ini untuk mendengar update cloud tanpa polling dari sisi Codex.",
      kind: "background",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-codex.ps1", [
          "-Mode",
          "realtime",
          ...toScriptArgPairs("-ConversationId", options.conversationId || "shared-thread"),
        ]);
      },
    },
    {
      id: "claude-realtime",
      label: "Claude Realtime",
      agent: "claude",
      category: "realtime",
      description: "Menjalankan listener realtime Claude secara background.",
      help: "Pakai ini untuk mendengar update cloud tanpa polling dari sisi Claude.",
      kind: "background",
      build(options = {}) {
        return buildPowerShellInvocation(projectRoot, "start-claude.ps1", [
          "-Mode",
          "realtime",
          ...toScriptArgPairs("-ConversationId", options.conversationId || "shared-thread"),
        ]);
      },
    },
    {
      id: "codex-pull-native",
      label: "Codex Pull Native",
      agent: "codex",
      category: "native",
      description: "Tarik cloud ke database lokal lalu tulis mirror ke native Codex.",
      help: "Pakai ini di PC lain saat Anda ingin percakapan dari cloud ditulis balik ke storage native Codex.",
      kind: "foreground",
      build(options = {}) {
        const args = [
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
          ...toScriptArgPairs("-CodexHome", options.codexHome || ""),
        ];

        if (options.full) {
          args.push("-Full");
        }

        return buildPowerShellInvocation(projectRoot, "pull-codex-native.ps1", args);
      },
    },
    {
      id: "claude-pull-native",
      label: "Claude Pull Native",
      agent: "claude",
      category: "native",
      description: "Tarik cloud ke database lokal lalu tulis mirror ke native Claude.",
      help: "Pakai ini saat Anda ingin project Claude native menerima hasil mirror dari cloud.",
      kind: "foreground",
      build(options = {}) {
        const args = [
          ...toScriptArgPairs("-ConversationId", options.conversationId || ""),
          ...toScriptArgPairs("-ProjectName", options.projectName || "cloud-sync"),
          ...toScriptArgPairs("-ClaudeHome", options.claudeHome || ""),
        ];

        if (options.full) {
          args.push("-Full");
        }

        return buildPowerShellInvocation(projectRoot, "pull-claude-native.ps1", args);
      },
    },
  ];
}

class DashboardCommandCenter {
  constructor({ projectRoot }) {
    this.projectRoot = projectRoot;
    this.presets = buildPresetCatalog(projectRoot);
    this.jobs = new Map();
    this.jobOrder = [];
  }

  listPresets() {
    return this.presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      agent: preset.agent,
      category: preset.category,
      description: preset.description,
      help: preset.help,
      kind: preset.kind,
    }));
  }

  listJobs() {
    return this.jobOrder
      .map((id) => this.jobs.get(id))
      .filter(Boolean)
      .map((job) => ({
        id: job.id,
        presetId: job.presetId,
        label: job.label,
        agent: job.agent,
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        pid: job.pid,
        exitCode: job.exitCode,
        options: job.options,
        log: job.log,
      }));
  }

  async runPreset(presetId, options = {}) {
    const preset = this.presets.find((item) => item.id === presetId);

    if (!preset) {
      throw new Error(`Preset command tidak dikenal: ${presetId}`);
    }

    const invocation = preset.build(options);
    const job = {
      id: crypto.randomUUID(),
      presetId: preset.id,
      label: preset.label,
      agent: preset.agent,
      kind: preset.kind,
      status: "starting",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pid: null,
      exitCode: null,
      options,
      log: "",
      child: null,
    };

    this.jobs.set(job.id, job);
    this.jobOrder.unshift(job.id);
    this.jobOrder = this.jobOrder.slice(0, 25);

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      windowsHide: true,
    });

    job.child = child;
    job.pid = child.pid || null;
    job.status = preset.kind === "background" ? "running" : "running";

    child.stdout.on("data", (chunk) => appendLog(job, String(chunk), "stdout"));
    child.stderr.on("data", (chunk) => appendLog(job, String(chunk), "stderr"));
    child.on("error", (error) => {
      appendLog(job, error.message, "error");
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
    });

    const waitForExit = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
        job.child = null;

        if (job.status === "stopping") {
          job.status = "stopped";
        } else if (code === 0) {
          job.status = "completed";
        } else {
          job.status = "failed";
          if (signal) {
            appendLog(job, `Process exited by signal ${signal}`, "system");
          }
        }

        resolve(job);
      });
    });

    if (preset.kind === "background") {
      appendLog(job, `Started PID ${job.pid || "-"}`, "system");
      return this.serializeJob(job);
    }

    await waitForExit;
    return this.serializeJob(job);
  }

  async stopJob(jobId) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error("Job tidak ditemukan.");
    }

    if (job.status !== "running" || !job.pid) {
      return this.serializeJob(job);
    }

    job.status = "stopping";
    appendLog(job, `Stopping PID ${job.pid}`, "system");

    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(job.pid), "/T", "/F"], {
        windowsHide: true,
      });

      killer.on("error", reject);
      killer.on("exit", (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`taskkill exit code ${code}`));
      });
    });

    return this.serializeJob(job);
  }

  serializeJob(job) {
    return {
      id: job.id,
      presetId: job.presetId,
      label: job.label,
      agent: job.agent,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      pid: job.pid,
      exitCode: job.exitCode,
      options: job.options,
      log: job.log,
    };
  }
}

module.exports = {
  DashboardCommandCenter,
};
