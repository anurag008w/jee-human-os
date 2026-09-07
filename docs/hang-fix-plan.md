# Hang-Fix Plan — Poori App Freeze / Jank Mitigation

> Status: **IN PROGRESS** (build in-flight).
> Covers: whole-app hang (`aise bhi`, non-live), chat typing/reply lag, tab-switch hang,
> time-degrade, live-call audio glitch, proactive calls during live call.

## Root cause cluster

Sab symptoms ek hi story se aate hain: **main-thread long tasks + unbounded growth**.

| Symptom (user report) | Root cause |
|---|---|
| Chat typing / reply-time hang | `ChatScreen.tsx:1763` — `messages.map(...)` renders the ENTIRE history as DOM every render (no windowing). Long chats ⇒ every streamed chunk re-renders the whole list. |
| App open / tab-switch hang | ChatScreen stays mounted (`App.tsx:398`); tab switch re-renders full message list + heavy DOM mount. |
| Time ke saath worse | Message-list DOM + chat storage both grow unboundedly ⇒ every interaction gets heavier. |
| Reply-end freeze (big chat) | `ChatService.persist()` (`chat.service.ts:2108`) → `LocalChatRepository.save()` (`chat-repository.ts:30`) — full `JSON.stringify` + synchronous `localStorage.setItem` on EVERY turn. No debounce (state store already has one). |
| Polling smell | `useAppState.ts:32` polls `container.store.get()` every 100ms + `ChatScreen.tsx:231/253` polls 2× per 300ms. Cheap each, but renders lag real mutations by up to 100ms and fires constantly. |
| Live call "tinn toon pii pooo" robotic audio | Main-thread stalls delay outbound audio chunks (base64 built ON main thread per chunk, `audio-streamer.ts:267`) ⇒ jitter/dropped chunk timing ⇒ distorted playback. |
| Proactive calls DURING live call | `proactive-agent.service.ts` has NO knowledge of an active live call — scheduled/inactivity `triggerIncomingCall` (1601) fires while call is running → duplicate incoming-call modal over the live overlay. |
| Live time-degrade | `live-client.ts` keeps transcripts unbounded; hot path does full-array spread per chunk. |

## Status table

| # | Item | Status | Files |
|---|---|---|---|
| P1 | Chat windowing + scroll-up load (older load on scroll up) | ✅ done | `ChatScreen.tsx`, new helper (tested) |
| P2 | Chat persist trailing-debounce + flush | ✅ done | `chat.service.ts`, `ChatScreen.tsx` (repo write path untouched) |
| P3 | Event-driven store subscription (kill 100ms poll) | ✅ done | `state-repository.ts`, `useAppState.ts`, `ChatScreen.tsx` |
| P4 | Live audio: base64 encode in AudioWorklet thread + transcripts cap | ✅ done | `audio-streamer.ts`, `audio-worklet-processor.ts`, `live-client.ts` |
| P5 | Proactive calls/nudges suppressed while a live call is active | ✅ done | `live-call-state.ts` (new), `LiveCompanionOverlay.tsx`, `proactive-agent.service.ts` |
| V | Verify: typecheck + full suite + new tests | ✅ done | — |
| M1 | Mid-call fixes: P1 stale-drop, P2 typing reset, P3 redial snapshot, P4 auto-retry on user activity | ✅ done | `live-client.ts`, `LiveCompanionOverlay.tsx`, `live-midcall-fixes.test.ts` (12) |
| M2 | Console-error storm fixes + voice-clarity + model self-heal | ✅ done | see "Mid-call & model round" below |

## Detailed design

### P1 — Chat message windowing (primary, biggest win)

**Problem:** `messages.map` renders all history; time-degrade + typing/tab-switch hang.

**Design (hand-rolled, no new deps):**
- `const [windowStart, setWindowStart] = useState<number>(tailStart(messages.length))`
  - `tailStart(n) = Math.max(0, n - WINDOW)` with `WINDOW = 120`.
- Rendered list: `messages.slice(windowStart)` — bounded DOM (~120-240 bubbles) no matter the history length.
- **Scroll-up load:** `chat-thread` `onScroll` — when `scrollTop < 120 && windowStart > 0`, load previous `STEP = 120` old messages via rAF-gated bump of `windowStart`.
- **Anchor preserve:** capture `scrollHeight` before the bump; in a layout effect set `el.scrollTop = newScrollHeight - prevHeight` so the viewport doesn't jump.
- **Stick-to-bottom:** `stuckToBottom` state (default true). `onScroll` sets false when >80px above bottom, true when near bottom / user sends / new message. Existing auto-scroll effect (`ChatScreen.tsx:362-365`) is gated on `stuckToBottom`.
- **Window slide on new messages:** while stuck, when `messages.length` grows (stream/append), re-base `windowStart = tailStart(newLength)` so the newest stay visible.
- **Session switch:** reset `windowStart` to tail + `stuckToBottom = true`.
- **Live streaming:** always tail + stuck (existing behaviour preserved).
- `MessageBubble` is already `React.memo` (2214) and messages are mutated in place (`chat.service.ts:278/280`), so unchanged bubbles skip re-render.
- **Pure helpers (unit-tested):** `tailStart(total)`, `windowStartForLoadOlder(current)`, `visibleMessages(messages, windowStart)`.

### P2 — Chat persistence debounce

**Problem:** every `persist()` does full sync serialize+write; reply ends freeze on big chats.

**Design (mirror `CachedStateStore`):**
- Add trailing debounce (≈500ms) inside `ChatService.persist()`.
- `ChatService.flush()` forces an immediate write.
- Flush points: assistant-turn completion, session switch, logout (`App.tsx handleLogout`), backup, `pagehide`/`visibilitychange:hidden` (listener in `ChatScreen`).
- In-memory state stays authoritative (same contract as state store).

### P3 — Event-driven store subscription

**Problem:** 100ms global poll + lagged whole-tree re-render.

**Design:**
- `subscribe(fn): () => void` added to `CachedStateStore` + the `container.store` wrapper **only** (NOT the `StateStore` interface — 2 test mocks `implements StateStore` + several literal typed stores exist; widening the interface would break them all).
- `CachedStateStore` keeps a listener set; `save()` and `reload()` emit — **deferred to a microtask** (`queueMicrotask`/`setTimeout` fallback) so a `save()` called from inside a React state updater (e.g. `useAppState.update`) can never call `setState` during the render phase.
- `useAppState` replaces the 100ms interval with the subscription (plus one initial check).
- `ChatScreen` liveConfig 300ms poll → store subscription (provider-list poll stays — no event source exists).

### P4 — Live audio glitch + live time-degrade

**Design:**
- `audio-streamer.ts` + `audio-worklet-processor.ts`: the worklet processor now base64-encodes the PCM chunk **inside the processor** (audio render thread) and `postMessage`es the ready string; the main thread only forwards it to `onAudioChunk`. Removes the per-chunk `Uint8Array` view + string build from the main thread (~23/sec during calls). No transfer list anymore (strings clone by value).
- `live-client.ts`: cap `this.transcripts` at 400 items (drop oldest); clears `activeAssistantTurnId`/`activeUserTurnId` when pruning ever drops the active turn so the next chunk starts fresh. Transcript spread-copies stay bounded. Overlay already coalesces DOM commits at 200ms.
- `audio-worklet-processor.test.ts` hermetic tests updated to the new `{ kind, b64, outLen, rms }` contract (incl. a real-MessagePort clone test, no DataCloneError path); `audio-streamer.test.ts` worklet route test now asserts verbatim forwarding.

### P5 — Proactive suppression during live call

**Problem:** scheduled/inactivity incoming calls (+ nudges) fire while a live call is active.

**Design:**
- New tiny module `src/features/ai/live-call-state.ts`: `setLiveCallActive(v)` / `isLiveCallActive()` (module boolean).
- `LiveCompanionOverlay.tsx`: set `true` when the call overlay opens (isOpen effect); set `false` in cleanup only when no other owner remains (`!activeLiveClient`).
- `proactive-agent.service.ts`: early-return `if (isLiveCallActive()) return;` in `triggerIncomingCall` (single choke point for ALL call paths) and in every proactive dispatch loop (`checkAndDispatchDueTriggers`, `checkScheduledMessages`, `checkInactivityAndFire`, `checkSpontaneousMemoryMessage`, `checkMissedInteractionFollowUp`). Natural re-check continues after the call ends.

## Verification
- `npm run typecheck` — clean.
- Full suite (`npm test` / `vitest run`) — **106 files / 1300 tests, all passing** (was 105 files / 1285 tests).
- New tests: windowing helpers (5); debounce-flush persistence (chat suite, 75); live-call-state guard in proactive service; audio-worklet b64 contract (hermetic, 7); **`live-client-transcript.test.ts` (2)** pinning the P4 transcript cap AND the `GeminiLiveClient.MAX_TRANSCRIPTS` symbol (a bare `LiveClient` there threw `ReferenceError: LiveClient is not defined` on EVERY transcript chunk — the exact root cause of "live messages never appear" + glitch/ping-pong audio on stale bundles; tsc can't catch it because `LiveClient` resolves as an ambient global type); **`silence-token.test.ts` (6)** pinning the `[silence]` no-op token (only the exact token counts; pure-silence turns create no live transcript item and no chat message); **`live-midcall-fixes.test.ts` (15)** pinning the mid-call + model-fallback behavior.
- Manual: DevTools Performance long-tasks before/after; audio glitch repro; big-session scroll-up UX.
- Runtime notes from live testing:
  - Hard-reload after this work (Ctrl+Shift+R / restart dev server) — half-applied HMR bundles produced the `LiveClient is not defined` crash loop.
  - `smartrotator.onrender.com/sync/* 401` errors in the console are the sync gateway's auth, unrelated to these fixes.
  - Double-greeting guard: the 500ms greeting SYSTEM EVENT now checks `activeAssistantTurnId || currentAssistantMessage`, so a fast model that already started the call-origin greeting (from the system prompt) isn't prompted a second time.

## Mid-call & model round

### M1 — Console-error storms (production, mobile + PC)
- `WebSocket is already in CLOSING or CLOSED state` floods came from forwarding outbound audio/video to a session whose socket had died. `sendAudioChunk`/`sendVideoFrame` (`live-client.ts`) now gate on live status (`listening`/`speaking`) and return early when the session is gone.
- `NotSupportedError: An AudioWorkletProcessor with name "misa-audio-processor" is already registered` came from `tryInitWorklet` running `addModule` twice on the same AudioContext (e.g. startRecording called again on the same context). New `workletModuleLoadedCtx` bookkeeping skips the second `addModule`.

### M1 — Voice clarity / echo ("mera voice usko clear nahi jaa raha")
- Worklet input block is now sample-rate-aware ~40ms (`block = max(640, round(sampleRate*0.04))`) — the Google Live 20–40ms input-chunk window at ANY context (24k/44.1k/48k), not 85ms at 24k.
- Post-speech echo cooldown (GoNoGo two-tier RMS gate): after her reply/interruption, room echo decays for ~1.5s — during that window the user-speech threshold rises (`rmsLevel > 0.055 || isUserTalkingOverThreshold` vs `0.032` normally) so the model never hears her own words as student speech. `playbackCooldownUntil` set in `onPlaybackEnded` wiring + interruption path. Does NOT gate sending, only speech classification → no extra latency.

### M1 — Redial "silent mode me chale gaye" complaint
- The silent/nudge/call-end filler lines leaked into the redial snapshot → next call "continued" the complaint. `MISA_FILLER_LINE_RE` filters them from the snapshot.
- Redial greeting ALWAYS seeds `prevContext` from `lastCallTranscriptSnapshot` (both hangup and drop-redial) — that's what made "call cut karke firse lagaya toh bhul gyi" impossible. The filler filter is what keeps silent-mode complaints out.
- Mid-call reconnect (`reconnectWithNewConfig`, auto-reconnect, model-fallback recursion) NEVER re-greets: the reconnect path returns before the greeting timer, and `reconnectWithNewConfig` sets `continueCallWithoutRegreeting` (consumed in the greeting timer → "settings changed, continue" event instead of "student phoned you!").

### M1 — Auto-reconnect after a failed connect (user activity)
- Fields `retryStashedStream`, `lastConnectionErrorAt`, `lastSpeechRetryKickAt`; methods `recordConnectionFailure`, `hasFailedConnection`, `stashRetryMicStream`, `retryConnectIfNeeded`.
- Wired: connect() catch, SDK onerror, auto-reconnect exhaustion, `sendTextMessage` (before queueing), `sendAudioChunk` (first audible speech, 2500ms throttle), `reportUserTyping` (typing is activity too).
- Reconnect success feeds the stashed mic stream to `startVoiceStreaming`; explicit hangup clears everything.
- Flush-on-reconnect now ALSO runs when `pendingTextQueue.length > 0` (not just `reconnectAttempts > 0`) — covers the dead-model fallback path where buffered messages were previously never delivered ("maine type kiya, reply nahi aaya").
- `sendTextMessage` failure on a half-dead session now BUFFERS + kicks retry instead of silently dropping the message.

### M1 — Dead-model self-heal (model fallback chain)
- Root cause of "na message na reply", "proactive band", apparent lateness: the selected `gemini-2.5-flash-native-audio-preview-09-2025` was dead on the gateway → every connect (calls + proactive check-ins) failed. The gateway/exact id can also be `gemini-2.5-flash-native-audio-latest` — both are in the chain.
- `LIVE_MODEL_FALLBACK_CHAIN = [gemini-3.1-flash-live-preview, gemini-2.5-flash-native-audio-latest, gemini-2.5-flash]`.
- `tryModelFallback` shared by connect() catch AND SDK onerror (a dead model can surface on either); the chain CASCADES one step per failure (no in-flight dedupe — that blocked cascade B→C); `modelFallbackInFlight` is now reserved ONLY to stop `retryConnectIfNeeded` from double-advancing during the recursive connect. Bounded (stops at chain end); surfaces a clear notice; user keeps full control in Live Settings.
- Model lists updated: `fetchLiveModels` defaults, live-model merge set, `LiveSettingsModal` preconfigured list — all now include `gemini-2.5-flash-native-audio-latest`.
- `isModelAvailabilityError` intentionally broad (`/model|not found|unsupported/i`) — any message mentioning "model" advances the chain once, which is safe AND bounded.

## Audit round 2 — live + proactive (independent agents, 2 passes)

Round-1 consequence fixes (verified in pass 2, all confirmed correct):
- `removeVisibilityHandler()` now called in `disconnect(false)`; `continueCallWithoutRegreeting` reset in `disconnect(false)` AND on connect error path; reconnect-cap entry guard passes a real error to `recordConnectionFailure`.
- Scheduled messages now gate on `validateProactiveDelivery` like nudge triggers (grace/DND/fatigue/duplicate) and re-schedule +5 min — capped at 3 retries so a permanently-blocked item can't zombie the sync scope; scheduled **calls** re-schedule too (`triggerIncomingCall` now returns boolean fired).
- `sessionIdleTimer` evaluates the 5-min follow-up BEFORE flipping `isUserCurrentlyInChat=false` (the 5-min follow-up was silently delayed to ~30 min).
- `destroy()` clears `debounceTimer`, `sessionIdleTimer`, and the 4 one-shot timers (celebration/chat-call/missed-call/offline-call).

New bugs found in pass 2 and fixed:
- `injectMessageIntoChat` is now a P5 choke-point (`if (isLiveCallActive()) return`) closing 5 bypass paths (celebration, session follow-up, missed-call 90s, offline-call 1s, notification-tap).
- `checkSpontaneousMemoryMessage` now RESERVES `nextSpontaneousAt` before the LLM await (was release-at-end → 5s platformTimeout + 4-min interval could both pass the guard → duplicate spontaneous messages).
- `checkInactivityAndFire` wrapped in `inactivityCheckInFlight` re-entrancy guard with try/finally; a validation-blocked daytime nudge no longer falls through to a spontaneous CALL in the same tick.
- `retryConnectIfNeeded` no longer advances the model chain while `tryModelFallback`'s recursive connect is in flight (was skipping a good model when user activity landed mid-fallback).

Tests: 106 files / **1303 tests** green (3 new: injected-blocked-during-live-call, scheduled-message retry cap, fallback in-flight no double-advance).