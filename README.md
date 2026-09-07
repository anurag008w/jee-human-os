# 🚀 LevelUp — L × Light × JEE

> **Ek high-performance, offline-first JEE prep system aur AI coach (Misa)** jo Android app ke roop me packaged hai. JEE 2026/2027 aspirants ke liye banaya gaya — study habits banane, mastery track karne, aur ek smart voice coach se baat karne ke liye.

---

## ✨ Highlights & Key Features

### 🎙️ Misa Live Voice & Multimodal AI
> **⚠️ Development (dev) features** — ye Misa **Live / Memory / Proactive** wali cheezein abhi *production-ready nahi* hain (details niche "Development Status" section me). Inhe production me laane ke liye abhi kaafi mehnat karni hogi.

- **Real-Time Bidirectional Voice** *(dev — live voice abhi under development me hai)*: Ultra-low-latency conversational AI native Audio Worklet streaming ke saath.
- **Stutter-Proof Playback (Jitter Buffer)**: Ek receiver-side jitter buffer decoded PCM chunks ko hardware pe smooth clock pe feeds karta hai (pre-roll lead + startup/underrun guard ke saath) — taaki weak network pe lambi replies bhi silky-smooth rahe, koi "cut-cut" click nahi.
- **Smart Notification Batching**: Streaming replies repeated live-notification rebuilds ko ek hi refresh me collapse kar deta hai per turn — main thread bridge/IPC churn se free rehta hai, low-signal links pe audio uninterrupted.
- **Proactive Silence Companion** *(dev)*: Agar call quiet ho jaye, toh Misa khud bolti hai — audio pe ~25s, background me ~22s, camera/screen active pe ~20s — escalating playful friend-like pacing ke saath (casual check-in se lekar good-natured "gussa" tak).
- **Voice Activity Detection (VAD) & Interruptions**: Naturally bolo; Misa pause karke sun leti hai jaise hi tum bolte ho.
- **Dynamic Audio Routing**: Device earpiece, speakerphone, wired headphones, aur Bluetooth earbuds ke beech seamless switching (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT`).
- **Camera & Vision Understanding**: Textbook problems ya handwritten equations ki photos snap karke instant step-by-step guidance lo.
- **Leak-Free Stream Sanitizer**: Built-in control-token scrubber BOS/EOS tokens (`<|begin_of_sentence|>`, `<|im_start|>`, etc.) ko real time me strip karta hai.

### 📋 Custom To-Dos & Modern Arrange Mode
- **Dual Study Tracks**: Structured **90-Day Curriculum** aur **Flexible Daily To-Do Track** ke beech effortlessly switch karo.
- **Intuitive Gestures**: Slide right = delete, slide left = edit, tap = task complete karna.
- **Modern Arrange Mode**: Daily priorities ko smooth drag-and-drop ya one-tap chevron buttons (`↑` / `↓`) se reorder karo.
- **Granular Tagging**: Priority pills (High, Med, Low), estimated durations (15m to 90m), aur subject filters (Physics, Chemistry, Maths, Revision, General).
- **Safety Confirmations**: Finished task ko uncomplete karna accidental clicks se bachane ke liye instant confirmation dialog maangta hai.

### 🤖 Autonomous AI Tools & Plan Manager
> **⚠️ Development (dev) features** — Autonomous tools, **Misa Memory** aur **Proactive Message/Call** flows abhi *production-ready nahi* (details niche "Development Status" section me).

- **Function Calling**: Misa tasks ko directly device pe create/edit/reschedule/delete kar sakta hai.
- **Safety-First Flow**: Destructive actions (jaise bulk deletions ya schedule overwrites) execute hone se pehle explicit confirmation maangte hain.
- **Transparent Status Badges**: Tool execution states exact details dikhate hain (`✅ Success`, `⏳ Approval Needed`, `❌ Failed`).
- **Proactive Study Nudges** *(dev — in development)*: Misa spontaneously check-in karti hai, aapke study struggles pe follow-up karti hai, aur momentum banaye rakhti hai — bina kisi ne type kiye bhi proactively message karti hai.
- **Proactive Incoming Live Calls** *(dev — in development)*: Misa scheduled study checks ke liye live call kar sakti hai (WhatsApp-style) — ye proactive calls abhi development me hain aur production-ready nahi.

### 📦 In-App Modular APK Updates
- **Automatic Version Detection**: GitHub Releases me signed APKs semantic/date tag comparisons se check karta hai.
- **Download & Install (1-Click)**: APK chunks me stream hota hai with live byte-level progress, phir system package installer turant khulta hai.
- **Download Only Mode**: APK ko install popup force kiye bina download & cache karta hai.
- **Storage Transparency & Share**: Exact file location (`updates/levelup.apk`) display karta hai — install/share (Google Drive/Downloads/WhatsApp native share sheet se) ya delete cached files.
- **Android 8.0 to Android 15+ Compatibility**: `REQUEST_INSTALL_PACKAGES` aur FileProvider content URIs ke saath fully configured.

### 🎯 90-Day Habit Engine & Exam Month Protocol
- **30 Levels Across 4 Phases**: Systematic habit progression — deep work, morning routines, error logging, aur revision cycles.
- **Mastery Placement**: Mastered tasks automatically permanent completed vaults me group ho jate hain, flexible re-scheduling allow karte hue.
- **Recovery Mode**: Daily completion 30% se niche girne pe automatically activate hota hai — essential core tasks se momentum rebuild karne ke liye.
- **Exam Month Mode**: JEE Main attempt date se 30 days pehle auto-trigger — revision aur mock test analysis pe focus switch karta hai.

### 🌐 Multi-Provider Architecture
- **Google Gemini API**: Direct support Gemini 2.0 Flash, Gemini 1.5 Pro, aur multimodal live sessions ke liye.
- **SmartRotator & OpenAI-Compatible Endpoints**: Custom proxy aur fallback support, auto-rotating keys aur resilient retry loops ke saath.

---

## 📱 Tech Stack & Architecture

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Framer Motion, Lucide Icons.
- **Native Runtime**: Capacitor 8 (Filesystem, Local Notifications, Intent Launcher, Share, App, Device).
- **Math & Markdown**: KaTeX (inline & display LaTeX math), Rehype/Remark GFM, Highlight.js.
- **State & Storage**: Offline-first LocalStorage & IndexedDB with optimistic UI updates aur reactive listeners.
- **Testing & Quality**: Vitest, React Testing Library, Oxlint (94 test suites / 1,100+ tests). Live audio, silence-proactive, aur jitter-buffer streaming pipelines dedicated suites se covered hain.

---

## 🛠️ Local Development & Build

### Prerequisites
- Node.js 20+ & npm
- Android Studio / Android SDK (native builds ke liye)
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
# Ultra-fast oxlint chalao
npm run lint

# Saare 94 test suites chalao (1,100+ tests)
npm test
```

### 4. Build & Sync to Android
```bash
# Production web bundle banao
npm run build

# Web assets aur plugins ko Android project me sync karo
npx cap sync android
```

### 5. Build Native APK
`android/` directory Android Studio me kholo, ya Gradle se build karo:
```bash
cd android
./gradlew assembleDebug
```
Output APK yahan milega:
`android/app/build/outputs/apk/debug/app-debug.apk`

---

## 🧪 Development Status — Misa (Live / Memory / Proactive)

Neeche diye **Misa** features abhi **development (dev)** me hain aur **production-ready nahi**
maane jane chahiye. Ye app me kaam karte hain, lekin inhe stable, hardened production state me
laane ke liye abhi kaafi kaam baaki hai — edge cases, error resilience, "no-answer" handling,
obsolescence, aur long-run stability.

| Feature | Area | Status |
| --- | --- | --- |
| **Misa Live voice** | Real-time bidirectional voice + multimodal streaming | 🟡 In development — app me stable, production hardening baaki hai |
| **Misa Memory** | Conversation/context memory across sessions | 🟡 In development — persistence kaam karta hai, long-run tuning chahiye |
| **Proactive study nudges (messages)** | Spontaneous auto check-ins & follow-ups | 🟡 In development — scheduling logic, quiet-hours/feedback tuning chahiye |
| **Proactive WhatsApp-style calls** | Live incoming calls for scheduled checks | 🟡 In development — call flow works, noise/reliability hardening chahiye |

> Ye features **fully functional** hain aur aaj hi usable hain, lekin dev flag isliye lagaya hai
> kyunki production scale pe abhi battle-tested nahi hain. High-stakes production environment me
> rely karne se pehle ensure kar lo.

---

## 🔐 Android Permissions Overview

App permissions strictly offline functionality aur user-selected AI features ke liye maangta hai:
- `android.permission.INTERNET`: AI chat, web search, aur GitHub APK updates ke liye.
- `android.permission.RECORD_AUDIO`: Real-time Misa voice chat aur audio streaming ke liye.
- `android.permission.CAMERA`: Textbook questions scan karne aur OCR analysis ke liye.
- `android.permission.MODIFY_AUDIO_SETTINGS` & `BLUETOOTH_CONNECT`: Speaker, headset, aur Bluetooth earbuds audio routing ke liye.
- `android.permission.REQUEST_INSTALL_PACKAGES`: Seamless in-app APK updates ke liye.
- `android.permission.POST_NOTIFICATIONS` & `RECEIVE_BOOT_COMPLETED`: Daily mission reminders aur study alarms ke liye.
- `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: Background sessions me live audio streaming uninterrupted rakhne ke liye.

---

## 🤝 Contribution & License

Contributions welcome hain! Ensure karo ki saara code `npm run lint` aur `npm test` pass kare PR submit karne se pehle.

Released under the **MIT License**.
