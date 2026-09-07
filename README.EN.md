# 🚀 LevelUp — L × Light × JEE

> A high-performance, offline-first JEE prep system and AI coach (Misa) packaged as an Android application. Built for JEE 2026/2027 aspirants to build unstoppable study habits, track mastery, and converse with an intelligent voice coach.

---

## ✨ Highlights & Key Features

### 🎙️ Misa Live Voice & Multimodal AI
> **⚠️ Development (dev) features** — these Misa **Live / Memory / Proactive** capabilities are **not production-ready yet** (see the "Development Status" section below). Bringing them to production still requires significant work.

- **Real-Time Bidirectional Voice** *(dev — live voice still under development)*: Ultra-low-latency conversational AI with native Audio Worklet streaming.
- **Stutter-Proof Playback (Jitter Buffer)**: A receiver-side jitter buffer feeds decoded PCM chunks to the hardware on a smooth clock with pre-roll lead + startup/underrun guard — so long replies on weak networks stay silky-smooth with no "cut-cut" clicks.
- **Smart Notification Batching**: Streaming replies collapse repeated live-notification rebuilds into a single refresh per turn, keeping the main thread free of bridge/IPC churn for uninterrupted audio on low-signal links.
- **Proactive Silence Companion** *(dev)*: If the call falls quiet, Misa naturally speaks up on her own — ~25s on audio, ~22s in background, ~20s with camera/screen active — with escalating playful friend-like pacing (from a casual check-in to a good-natured "gussa").
- **Voice Activity Detection (VAD) & Interruptions**: Speak naturally; Misa pauses and listens the moment you talk.
- **Dynamic Audio Routing**: Seamless switching between device earpiece, speakerphone, wired headphones, and Bluetooth earbuds (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT`).
- **Camera & Vision Understanding**: Snap photos of textbook problems or handwritten equations for instant step-by-step guidance.
- **Leak-Free Stream Sanitizer**: Built-in control-token scrubber strips BOS/EOS tokens (`<|begin_of_sentence|>`, `<|im_start|>`, etc.) in real time.

### 📋 Custom To-Dos & Modern Arrange Mode
- **Dual Study Tracks**: Switch effortlessly between the structured **90-Day Curriculum** and the **Flexible Daily To-Do Track**.
- **Intuitive Gestures**: Slide right to delete, slide left to edit, and tap to mark tasks as completed.
- **Modern Arrange Mode**: Reorder your daily priorities with smooth drag-and-drop or one-tap chevron buttons (`↑` / `↓`).
- **Granular Tagging**: Priority pills (High, Med, Low), estimated durations (15m to 90m), and subject filters (Physics, Chemistry, Maths, Revision, General).
- **Safety Confirmations**: Uncompleting a finished task prompts an instant confirmation dialog to prevent accidental clicks.

### 🤖 Autonomous AI Tools & Plan Manager
> **⚠️ Development (dev) features** — Autonomous tools, **Misa Memory**, and the **Proactive Message/Call** flows are **not production-ready yet** (see the "Development Status" section below).

- **Function Calling**: Misa can create, edit, reschedule, and delete tasks directly on your device.
- **Safety-First Flow**: Destructive actions (like bulk deletions or schedule overwrites) require explicit confirmation before execution.
- **Transparent Status Badges**: Tool execution states show exact details (`✅ Success`, `⏳ Approval Needed`, `❌ Failed`).
- **Proactive Study Nudges** *(dev — in development)*: Misa spontaneously checks in, follows up on your study struggles, and keeps momentum going — proactively messaging the student even when no one has typed.
- **Proactive Incoming Live Calls** *(dev — in development)*: Misa can call you live (WhatsApp-style) for scheduled study checks — these proactive calls are still under development and not production-ready yet.

### 📦 In-App Modular APK Updates
- **Automatic Version Detection**: Checks GitHub Releases for signed APKs with semantic/date tag comparisons.
- **Download & Install (1-Click)**: Streams APK in chunks with live byte-level progress and immediately opens the system package installer.
- **Download Only Mode**: Downloads and caches the APK without forcing an instant installer popup.
- **Storage Transparency & Share**: Displays the exact file location (`updates/levelup.apk`) with options to install, share to Google Drive/Downloads/WhatsApp via native share sheet, or delete cached files.
- **Android 8.0 to Android 15+ Compatibility**: Fully configured with `REQUEST_INSTALL_PACKAGES` and FileProvider content URIs.

### 🎯 90-Day Habit Engine & Exam Month Protocol
- **30 Levels Across 4 Phases**: Systematic habit progression covering deep work, morning routines, error logging, and revision cycles.
- **Mastery Placement**: Automatically groups mastered tasks into permanent completed vaults while allowing flexible re-scheduling.
- **Recovery Mode**: Automatically activates if daily completion drops below 30% to rebuild momentum with essential core tasks.
- **Exam Month Mode**: Auto-triggers 30 days before your JEE Main attempt date, switching the daily focus to revision and mock test analysis.

### 🌐 Multi-Provider Architecture
- **Google Gemini API**: Direct support for Gemini 2.0 Flash, Gemini 1.5 Pro, and multimodal live sessions.
- **SmartRotator & OpenAI-Compatible Endpoints**: Custom proxy and fallback support with auto-rotating keys and resilient retry loops.

---

## 📱 Tech Stack & Architecture

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Framer Motion, Lucide Icons.
- **Native Runtime**: Capacitor 8 (Filesystem, Local Notifications, Intent Launcher, Share, App, Device).
- **Math & Markdown**: KaTeX (inline & display LaTeX math), Rehype/Remark GFM, Highlight.js.
- **State & Storage**: Offline-first LocalStorage & IndexedDB with optimistic UI updates and reactive listeners.
- **Testing & Quality**: Vitest, React Testing Library, Oxlint (94 test suites / 1,100+ tests). Live audio, silence-proactive, and jitter-buffer streaming pipelines are covered by dedicated suites.

---

## 🛠️ Local Development & Build

### Prerequisites
- Node.js 20+ & npm
- Android Studio / Android SDK (for native builds)
- Java JDK 21

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/anurag008w/levelup.git
cd levelup
npm install
```

### 2. Run Web Development Server
```bash
npm run dev
```

### 3. Run Linter & Tests
```bash
# Run ultra-fast oxlint
npm run lint

# Run all 94 test suites (1,100+ tests)
npm test
```

### 4. Build & Sync to Android
```bash
# Build production web bundle
npm run build

# Sync web assets and plugins to Android project
npx cap sync android
```

### 5. Build Native APK
Open the `android/` directory in Android Studio, or build via Gradle:
```bash
cd android
./gradlew assembleDebug
```
The output APK will be located at:
`android/app/build/outputs/apk/debug/app-debug.apk`

---

## 🧪 Development Status — Misa (Live / Memory / Proactive)

The following **Misa** features are currently **in development** and should be treated as
**not production-ready**. They function in the app, but hardening them into a stable,
production-grade state still requires meaningful engineering work (edge cases, error
resilience, "no-answer" handling, obsolescence, and long-run stability).

| Feature | Area | Status |
| --- | --- | --- |
| **Misa Live voice** | Real-time bidirectional voice + multimodal streaming | 🟡 In development — stable in-app, needs production hardening |
| **Misa Memory** | Conversation/context memory across sessions | 🟡 In development — persistence works, needs long-run tuning |
| **Proactive study nudges (messages)** | Spontaneous auto check-ins & follow-ups | 🟡 In development — scheduling logic, needs quiet-hours/feedback tuning |
| **Proactive WhatsApp-style calls** | Live incoming calls for scheduled checks | 🟡 In development — call flow works, needs noise/reliability hardening |

> These features are **fully functional** and usable today, but they are flagged as dev
> because they have not yet been battle-tested at production scale. Ensure this before
> relying on them in a high-stakes production environment.

---

## 🔐 Android Permissions Overview

The app requests permissions strictly for offline functionality and user-selected AI features:
- `android.permission.INTERNET`: For AI chat, web search, and GitHub APK updates.
- `android.permission.RECORD_AUDIO`: For real-time Misa voice chat and audio streaming.
- `android.permission.CAMERA`: For scanning textbook questions and OCR analysis.
- `android.permission.MODIFY_AUDIO_SETTINGS` & `BLUETOOTH_CONNECT`: For speaker, headset, and Bluetooth earbuds audio routing.
- `android.permission.REQUEST_INSTALL_PACKAGES`: For seamless in-app APK updates.
- `android.permission.POST_NOTIFICATIONS` & `RECEIVE_BOOT_COMPLETED`: For daily mission reminders and study alarms.
- `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: To keep live audio streaming uninterrupted in background sessions.

---

## 🤝 Contribution & License

Contributions are welcome! Please ensure all code passes `npm run lint` and `npm test` before submitting pull requests.

Released under the **MIT License**.
