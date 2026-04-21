.

🧠 Codex & Claude Conversation Sync Dashboard










A local dashboard to manage, store, and synchronize conversations from Codex and Claude — with full control over what AI is allowed to read using a built-in Context Guard system.

📸 Preview
Dashboard UI

Command Center

🎬 Demo

💡 Tip: Replace the images above with real screenshots/GIFs from your project
Suggested folder:

docs/
├── screenshot-dashboard.png
├── screenshot-command-center.png
└── demo.gif
🚀 Features
🔄 Conversation Sync
Sync conversations from Codex & Claude
Backfill historical data
One-way & two-way sync support
🖥️ Visual Dashboard
Clean and user-friendly interface
Filter by source (Codex / Claude)
Search by title or conversation ID
Sync status & metadata visibility
🧠 Context Guard (🔥 Core Feature)

Prevent AI from reading irrelevant or sensitive conversations.

Restrict AI to specific projects
Whitelist which conversations AI can access
Separate project, general, and private data
⚡ Starter Packs (One-Click Automation)

Run multiple actions at once:

Beginner Codex setup
Beginner Claude setup
Two-way sync
Realtime monitoring
Native recovery mode
🏷️ Project-Based Organization
Assign project_id to conversations
Define scope:
project
general
private
Control AI access per conversation
🛡️ Why Context Guard Matters

Without proper filtering, AI systems may read all stored conversations.

This project ensures:

❌ No uncontrolled context access
✅ Only relevant conversations are used
🔒 Sensitive data stays protected
🧱 Project Structure
src/
├── dashboard-server.js         # Main dashboard server
├── dashboard-command-center.js # Actions & starter packs
├── local-store.js              # Local database (SQLite)
├── supabase-sync.js            # Cloud sync
├── realtime.js                 # Realtime listener
├── history-import.js           # Import history
├── native-writeback.js         # Write back to native apps
├── cli.js                      # CLI interface
⚙️ Getting Started
1. Install dependencies
npm install
2. Run dashboard
node src/dashboard-server.js

Open in browser:

http://localhost:3000
🧭 Quick Start (Beginner Friendly)
1. Set Active Project

Example:

sync-codex-claude
2. Use Safe Mode
Active Project + AI Allowed
3. Select Conversations

Choose only relevant ones.

4. Enable AI Access

From Context Guard Panel:

Set project_id
Set scope = project
Enable ✅ "Allow AI access"
🧪 Operation Modes
Mode	Description
Active Project + AI	✅ Safest
Active Project Only	All project conversations
AI Allowed Only	Whitelisted only
General	Non-project data
All Conversations	⚠️ Not recommended
🧰 Starter Packs
🔰 Codex Beginner

Backfill → Store locally → Push to cloud

🔰 Claude Beginner

Fetch → Store → Sync

🔁 Two-Way Sync

Local ↔ Cloud

👀 Realtime Mode

Continuous sync

♻️ Native Recovery

Restore to original apps

🗄️ Database

Uses SQLite (local)

Key fields:

project_id
scope
allowed_for_ai
⚠️ Important Notes
Default behavior is safe (restricted AI access)
Always use project_id
Avoid using “All Conversations” mode
Use whitelist for sensitive workflows
🧩 Roadmap
 Beginner onboarding wizard
 Auto project tagging (AI-based)
 Drag & drop context manager
 Multi-project workspace
 Role-based access control
🤝 Contributing

Pull requests are welcome 🙌

Focus areas:

Dashboard UX improvements
AI context safety
Sync performance
⭐ Support

If you find this useful:

⭐ Star this repo
🛠️ Contribute improvements
🧠 Share ideas
📄 License

MIT License