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
      label: "Ambil riwayat Codex ke lokal",
      agent: "codex",
      category: "backfill",
      description: "Membaca riwayat native Codex lalu menyimpannya ke database lokal tanpa mengirim ke cloud.",
      help: "Pakai ini saat riwayat Codex di komputer lokal belum masuk ke database dashboard, tetapi Anda belum ingin sinkron ke cloud.",
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
      label: "Ambil riwayat Claude ke lokal",
      agent: "claude",
      category: "backfill",
      description: "Membaca riwayat native Claude lalu menyimpannya ke database lokal tanpa mengirim ke cloud.",
      help: "Pakai ini saat Anda ingin mengambil data Claude ke dashboard lebih dulu tanpa perubahan ke cloud.",
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
      label: "Ambil riwayat Codex lalu kirim ke cloud",
      agent: "codex",
      category: "backfill",
      description: "Membaca riwayat native Codex lalu mengirim selisih barunya ke cloud.",
      help: "Pakai ini saat ada percakapan Codex yang tertinggal dan Anda ingin menyamakan data lokal dengan cloud.",
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
      label: "Ambil riwayat Claude lalu kirim ke cloud",
      agent: "claude",
      category: "backfill",
      description: "Membaca riwayat native Claude lalu mengirim selisih barunya ke cloud.",
      help: "Pakai ini saat Claude memiliki riwayat baru yang belum tersinkron ke cloud.",
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
      label: "Sinkronkan Codex sekali",
      agent: "codex",
      category: "sync",
      description: "Menjalankan proses sinkron Codex satu putaran, lalu berhenti sendiri.",
      help: "Cocok untuk pengecekan cepat saat Anda hanya ingin sinkron sekali tanpa mode pemantauan terus-menerus.",
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
      label: "Sinkronkan Claude sekali",
      agent: "claude",
      category: "sync",
      description: "Menjalankan proses sinkron Claude satu putaran, lalu berhenti sendiri.",
      help: "Cocok untuk sinkron Claude satu kali tanpa proses tambahan di belakang layar.",
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
      label: "Pantau Codex di latar belakang",
      agent: "codex",
      category: "watch",
      description: "Menjalankan pemantauan Codex berkala di latar belakang.",
      help: "Pakai ini bila Codex perlu terus dipantau agar perubahan baru cepat ikut tersinkron.",
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
      label: "Pantau Claude di latar belakang",
      agent: "claude",
      category: "watch",
      description: "Menjalankan pemantauan Claude berkala di latar belakang.",
      help: "Pakai ini bila Claude perlu terus dipantau agar perubahan baru cepat ikut tersinkron.",
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
      label: "Dengarkan Codex realtime",
      agent: "codex",
      category: "realtime",
      description: "Membuka pendengar realtime Codex di latar belakang untuk menerima pembaruan lebih cepat.",
      help: "Cocok bila Anda ingin Codex segera menerima perubahan dari cloud tanpa menunggu jadwal polling.",
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
      label: "Dengarkan Claude realtime",
      agent: "claude",
      category: "realtime",
      description: "Membuka pendengar realtime Claude di latar belakang untuk menerima pembaruan lebih cepat.",
      help: "Cocok bila Anda ingin Claude segera menerima perubahan dari cloud tanpa menunggu jadwal polling.",
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
      label: "Tarik cloud lalu tulis ke native Codex",
      agent: "codex",
      category: "native",
      description: "Mengambil data terbaru dari cloud ke lokal lalu menuliskannya kembali ke penyimpanan native Codex.",
      help: "Pakai ini saat komputer lain perlu menerima salinan percakapan ke folder native Codex.",
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
      label: "Tarik cloud lalu tulis ke native Claude",
      agent: "claude",
      category: "native",
      description: "Mengambil data terbaru dari cloud ke lokal lalu menuliskannya kembali ke penyimpanan native Claude.",
      help: "Pakai ini saat project Claude di komputer lokal perlu diisi ulang dari data cloud.",
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
      throw new Error(`Starter pack atau perintah tidak dikenal: ${presetId}`);
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
