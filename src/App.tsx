import { Suspense, lazy, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Capacitor } from '@capacitor/core';
import TabBar, { type Tab } from './components/TabBar';
import TodayScreen from './screens/TodayScreen';
import LoginScreen from './screens/LoginScreen';
import PermissionOnboarding from './components/PermissionOnboarding';
import { useAppState } from './lib/useAppState';
import { clearSession, ensureV1Base, loadSession, saveSession, type AuthSession } from './lib/auth';
import { container } from './di/container';
import { emptyAppState } from './core/domain/state';
import { setupNotificationActions } from './lib/notification-actions';
import { setChatTabActive } from './lib/notifications';
import { getNotificationPermission } from './lib/notifications';
import { getBackgroundPermissionStatus } from './lib/background-permission';
import ScreenSkeleton from './components/ScreenSkeleton';
import { IncomingCallModal } from './components/live/IncomingCallModal';
import { proactiveAgentService, type IncomingCallEvent } from './features/ai/proactive-agent.service';
import { ringtonePlayer } from './lib/ringtone-player';
import { resetNativeAudioRoute } from './lib/native-audio-route';

function lazyRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (error: any) {
      const msg = String(error?.message || '');
      const isChunkError =
        msg.includes('dynamically imported module') ||
        msg.includes('Loading chunk') ||
        msg.includes('Failed to fetch') ||
        msg.includes('Importing a module script failed');

      if (isChunkError) {
        const key = 'levelup_chunk_reload';
        const lastReload = Number(sessionStorage.getItem(key) || '0');
        if (Date.now() - lastReload > 8000) {
          sessionStorage.setItem(key, String(Date.now()));
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
      }
      throw error;
    }
  });
}

const LevelsScreen = lazyRetry(() => import('./screens/LevelsScreen'));
const ProgressScreen = lazyRetry(() => import('./screens/ProgressScreen'));
const ReviewScreen = lazyRetry(() => import('./screens/ReviewScreen'));
const TaskBankScreen = lazyRetry(() => import('./screens/TaskBankScreen'));
const PlannersScreen = lazyRetry(() => import('./screens/PlannersScreen'));
const AISettingsScreen = lazyRetry(() => import('./screens/AISettingsScreen'));
const UpdatesScreen = lazyRetry(() => import('./screens/UpdatesScreen'));
const ChatScreen = lazyRetry(() => import('./screens/ChatScreen'));

const pageSpring = { type: 'tween', duration: 0.14, ease: 'easeOut' } as const;

/**
 * Which account the local data (state + chat) belongs to. 'guest' for offline
 * mode, otherwise the account username. Kept OUTSIDE AppState so it survives
 * state resets and never leaks into backups. Used to isolate accounts on a
 * shared device: local data is wiped only when a DIFFERENT owner takes over,
 * so one account's progress/chat/keys never surface for another account.
 */
const DATA_OWNER_KEY = 'levelup.data-owner';

function readDataOwner(): string | null {
  try {
    return localStorage.getItem(DATA_OWNER_KEY);
  } catch {
    return null;
  }
}

function writeDataOwner(owner: string): void {
  try {
    localStorage.setItem(DATA_OWNER_KEY, owner);
  } catch {
    /* storage blocked/full — owner tracking is best-effort */
  }
}

/**
 * Wipes local state + chat when a different owner starts using the device.
 * - account A → account B, or account → guest: wipe (A's data is server-backed
 *   and restored on A's next login via pull).
 * - guest → account: keep (the guest's work is the same human's own work and
 *   intentionally carries into their new account).
 * - same account, or fresh install (null owner): keep.
 */
function wipeForNewOwner(previousOwner: string | null, nextOwner: string): void {
  if (previousOwner === null || previousOwner === nextOwner) return;
  if (previousOwner === 'guest' && nextOwner !== 'guest') return;
  container.chat.replaceStore([]);
  container.store.save(emptyAppState());
}

export default function App() {
  const { state, today, update, refresh, resetAll, adminUnlocked, unlockAdmin, autoUnlock, lockAdmin, setAdminDay, pruneNotice, dismissPruneNotice } = useAppState();
  const [tab, setTab] = useState<Tab>('today');
  // Once the user has opened the coach, keep it mounted across tab switches so
  // an in-flight AI stream survives (a fresh chat reply must not die just
  // because the user peeked at another tab). Hidden screens keep running.
  const [chatVisited, setChatVisited] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [guest, setGuest] = useState(() => localStorage.getItem('levelup:guest') === 'true');
  // Notification tap/reply se aaya target session — ChatScreen isse activeId
  // bana leta hai aur App value clear kar deta hai (onTargetConsumed).
  const [targetChatSessionId, setTargetChatSessionId] = useState<string | null>(null);
  // Permissions onboarding popup (Android): har app open pe check hota hai —
  // agar permissions missing hain aur user ne pehle "no" nahi bola, popup aata
  // hai. Ek baar dismiss karne pe hamesha ke liye band (localStorage flag).
  const [showPermissionOnboarding, setShowPermissionOnboarding] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCallEvent | null>(null);

  // Android autoplay unlock — kisi bhi user-interaction (tap/scroll/key) pe
  // AudioContext resume karte hain taaki proactive incoming-call ringtone
  // bina gesture ke baaj sake (Web Audio by-default suspended hota hai).
  //
  // NOTE: hum mic ko yahan per-touch unlock NAHI karte. Pehle yeh har touch pe
  // `getUserMedia({audio:true})` kholta tha jo Android/WebView ko "audio capture
  // started" samjha deta tha → user ka chalta hua music har tap pe duck/pause ho
  // jata tha (real-device report: 'jab app on kiya music band 1 sec, jab bhi
  // touch karta band ho raha tha'). Live call apna mic khud acquire karta hai
  // jab call actually start hoti hai (ChatScreen → getUserMedia), isliye yahan
  // sirf WebAudio ringtone unlock kaafi hai.
  useEffect(() => {
    const unlock: EventListener = () => {
      try {
        ringtonePlayer.unlock();
      } catch {
        // no-op
      }
    };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    evs.forEach((e) => window.addEventListener(e, unlock, true));
    return () => evs.forEach((e) => window.removeEventListener(e, unlock, true));
  }, []);

  useEffect(() => {
    // Clean audio state on app launch: release any lingering audio focus or communication mode
    void resetNativeAudioRoute().catch(() => undefined);
    void proactiveAgentService.init();
    const unsubscribe = proactiveAgentService.onIncomingCall((callEvent) => {
      setIncomingCall(callEvent);
    });
    // StrictMode/HMR double-mount se duplicate intervals + listeners na bane —
    // teardown pe destroy() sab cleanup karta hai (initPlatformNotifications
    // gaye listeners aur timers hata deta hai), phir rebuild fresh hota hai.
    return () => {
      unsubscribe();
      proactiveAgentService.destroy();
    };
  }, []);

  const handleAcceptCall = (callEvent: IncomingCallEvent) => {
    setIncomingCall(null);
    setChatVisited(true);
    setTab('chat');
    window.dispatchEvent(
      new CustomEvent('levelup:start-live-call', {
        detail: { reason: callEvent.reason, isIncomingCall: true, origin: callEvent.origin || 'auto' },
      })
    );
  };

  const handleDeclineCall = (_callEvent: IncomingCallEvent) => {
    setIncomingCall(null);
  };

  useEffect(() => {
    if (tab === 'chat') setChatVisited(true);
  }, [tab]);

  useEffect(() => {
    if (state.enable90DayTrack === false && (tab === 'levels' || tab === 'task-bank')) {
      setTab('today');
    }
  }, [state.enable90DayTrack, tab]);

  // Tell the notifications service whether the user is looking at the Chat
  // tab, so AI-reply alerts are suppressed while the chat is the active tab
  // (they fire again as soon as the user switches to any other tab or the app
  // goes to the background).
  useEffect(() => {
    setChatTabActive(tab === 'chat');
  }, [tab]);

  // Other tabs (.screen) rely on the normal page/body scroll — they have no
  // internal scroll container. Misa (chat) is the opposite: .chat-shell owns
  // a fixed-height flex layout and .chat-thread does its own internal
  // overflow-y scroll, with the topbar/composer meant to stay put. If body
  // is ever allowed to scroll too (a rounding/viewport-unit hiccup on some
  // WebViews can make chat-shell's content a hair taller than the screen),
  // the WHOLE screen — topbar, messages, composer — scrolls together as one
  // block, and the fixed hamburger handle (position: fixed) stays pinned to
  // the viewport while everything slides underneath it, so it visually
  // overlaps message text. Locking body scroll only while chat is the active
  // tab forces all scrolling back into .chat-thread, where it belongs.
  useEffect(() => {
    if (tab === 'chat') {
      document.body.classList.add('chat-scroll-lock');
    } else {
      document.body.classList.remove('chat-scroll-lock');
    }
    return () => document.body.classList.remove('chat-scroll-lock');
  }, [tab]);

  // Notification actions (native): inline reply / tap → chat kholo.
  // Listen `levelup:open-chat` from notification-actions and jump to Chat tab.
  useEffect(() => {
    setupNotificationActions();
    const onOpenChat = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail?.sessionId) return;
      setTargetChatSessionId(detail.sessionId);
      setChatVisited(true);
      setTab('chat');
    };
    window.addEventListener('levelup:open-chat', onOpenChat);
    return () => window.removeEventListener('levelup:open-chat', onOpenChat);
  }, []);

  // Auto-wire the app's DEFAULT (hidden) provider to the logged-in server:
  // baseUrl = server/v1, apiKey = the user's own sk- key, so the gateway can
  // enforce per-user quotas. The provider stays hidden — no visible card, no
  // URL or key anywhere in the UI. Runs on login and on restart (self-healing).
  useEffect(() => {
    if (!session) return;
    container.providerSettings.configureServerAuth(ensureV1Base(session.serverUrl), session.apiKey);
    container.syncCoordinator.attach(session);
  }, [session]);

  // Permissions onboarding (Android): login ke baad aur har app open pe check —
  // agar permissions missing hain aur user ne pehle "no" nahi bola to popup
  // aata hai. Ek baar dismiss karne pe localStorage flag hamesha ke liye
  // popup band kar deta hai (user ka explicit "no").
  useEffect(() => {
    if (!session && !guest) return;
    let cancelled = false;
    (async () => {
      if (!Capacitor.isNativePlatform()) return;
      if (localStorage.getItem('levelup:perm-prompt-dismissed') === 'true') return;
      const [perm, bg] = await Promise.all([getNotificationPermission(), getBackgroundPermissionStatus()]);
      if (cancelled) return;
      const missing = perm !== 'granted' || (bg !== null && !bg.batteryWhitelisted);
      if (missing) setShowPermissionOnboarding(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, guest]);

  function handlePermissionOnboardingDone() {
    localStorage.setItem('levelup:perm-prompt-dismissed', 'true');
    setShowPermissionOnboarding(false);
  }

  function handleLoggedIn(next: AuthSession) {
    const prevOwner = readDataOwner();
    wipeForNewOwner(prevOwner, next.username);
    writeDataOwner(next.username);
    saveSession(next);
    localStorage.removeItem('levelup:guest');
    setGuest(false);
    setSession(next);
    setTab('today');
    refresh();
  }

  // Guest (skipped login): app runs fully offline — data stays in localStorage,
  // no server model, no sync. Server auth is disabled so nothing leaks.
  function handleGuestMode() {
    container.providerSettings.disableServerAuth();
    const prevOwner = readDataOwner();
    wipeForNewOwner(prevOwner, 'guest');
    writeDataOwner('guest');
    localStorage.setItem('levelup:guest', 'true');
    setGuest(true);
    setTab('today');
    refresh();
  }

  function handleLogout() {
    container.syncCoordinator.detach();
    clearSession();
    localStorage.removeItem('levelup:guest');
    setSession(null);
    setGuest(false);
    setTab('today');
  }

  // App-start login gate: levelup content only appears after authentication
  // (or after the user explicitly skips into offline/guest mode).
  if (!session && !guest) {
    return <LoginScreen onLoggedIn={handleLoggedIn} onSkip={handleGuestMode} />;
  }

  function renderScreen() {
    switch (tab) {
      case 'today':
        return (
          <TodayScreen
            state={state}
            today={today}
            update={update}
            adminUnlocked={adminUnlocked}
            canAutoUnlock={session?.isSuperAdmin ?? false}
            onAutoUnlock={autoUnlock}
            onUnlockAdmin={unlockAdmin}
            onLockAdmin={lockAdmin}
            onSetAdminDay={setAdminDay}
            onNavigate={(tab) => {
              setTab(tab);
            }}
          />
        );
      case 'levels':
        return <LevelsScreen state={state} today={today} update={update} />;
      case 'progress':
        return <ProgressScreen state={state} today={today} />;
      case 'review':
        return (
          <ReviewScreen state={state} today={today} update={update} resetAll={resetAll} />
        );
      case 'task-bank':
        return <TaskBankScreen state={state} update={update} />;
      case 'planners':
        return <PlannersScreen state={state} update={update} />;
      case 'ai':
        return <AISettingsScreen state={state} update={update} session={session} onLogout={handleLogout} />;
      case 'updates':
        return <UpdatesScreen />;
      case 'chat':
        // Rendered separately below so it never unmounts on tab switch.
        return null;
    }
  }

  return (
    <div className="min-h-screen bg-bg text-text">
      {pruneNotice && (
        <div
          role="status"
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2000,
            maxWidth: '92vw',
            background: 'var(--color-surface, #1e1e2e)',
            color: 'var(--color-text, #eee)',
            border: '1px solid rgba(250, 204, 21, 0.45)',
            borderRadius: 12,
            padding: '10px 14px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
          }}
        >
          <span>{pruneNotice}</span>
          <button
            onClick={dismissPruneNotice}
            aria-label="Dismiss"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              fontSize: 16,
              cursor: 'pointer',
              lineHeight: 1,
              padding: '2px 4px',
            }}
          >
            ×
          </button>
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        {tab !== 'chat' && (
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={pageSpring}
          >
            <Suspense fallback={<ScreenSkeleton />}>{renderScreen()}</Suspense>
          </motion.div>
        )}
      </AnimatePresence>
      {(chatVisited || tab === 'chat') && (
        <div style={{ display: tab === 'chat' ? undefined : 'none' }} aria-hidden={tab !== 'chat'}>
          <ChatScreen
            targetSessionId={targetChatSessionId}
            onTargetConsumed={() => setTargetChatSessionId(null)}
          />
        </div>
      )}
      <TabBar
        active={tab}
        state={state}
        update={update}
        onChange={(next) => {
          if (next !== tab) {
            setTab(next);
            proactiveAgentService.setInChatSession(next === 'chat');
          }
        }}
      />
      {showPermissionOnboarding && <PermissionOnboarding onDone={handlePermissionOnboardingDone} />}
      <IncomingCallModal
        callEvent={incomingCall}
        onAccept={handleAcceptCall}
        onDecline={handleDeclineCall}
      />
    </div>
  );
}
