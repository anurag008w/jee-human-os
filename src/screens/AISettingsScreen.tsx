import { Suspense, useEffect, useRef, useState, lazy } from 'react';
import { AlertTriangle, Bell, BellOff, Check, ChevronRight, Database, Download, ExternalLink, Globe, KeyRound, LayoutList, ListChecks, LogIn, LogOut, Music, Pause, PhoneCall, PhoneIncoming, Play, Plug, RefreshCw, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, Square, Trash2, Upload, Wifi, WifiOff, X } from 'lucide-react';
import type { AppState } from '../types';
import type { ProviderConfig, ModelInfo } from '../core/domain/llm';
import type { AuthSession } from '../lib/auth';
import type { LiveSettingsConfig } from '../core/domain/live-types';
import { DEFAULT_LIVE_SETTINGS } from '../core/domain/live-types';
import { container } from '../di/container';
import { getCurrentDayNumber, isoAddDays } from '../lib/engine';
import ScreenHeader from '../components/ui/ScreenHeader';
import SectionHeader from '../components/ui/SectionHeader';
import EmptyState from '../components/ui/EmptyState';
import AddProviderForm from '../components/AddProviderForm';
import LiveSettingsModal from '../components/live/LiveSettingsModal';
import { haptic } from '../lib/haptics';
import { proactiveAgentService } from '../features/ai/proactive-agent.service';
import { ringtonePlayer, RINGTONE_PRESETS } from '../lib/ringtone-player';
import {
  getNotificationPermission,
  getNotificationPreference,
  getNotificationSupport,
  isNativePlatform,
  notifyTest,
  openNotificationSettings,
  requestNotificationPermission,
  setNotificationPreference,
  type NotificationPermissionStatus,
  type NotificationUnsupportedReason,
} from '../lib/notifications';
import { formatBytes, normalizeChatSessions, parseBackup, summarizeBackup, type BackupScope, type BackupSummary } from '../features/backup/backup.service';
import { normalizeState } from '../infra/storage/state-repository';
import { deleteAllData } from '../features/sync/delete-all';
import { exportTextFile } from '../lib/exportFile';

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

const ChatSettingsScreen = lazyRetry(() => import('./ChatSettingsScreen'));

export default function AISettingsScreen({
  state,
  update,
  session,
  onLogout,
}: {
  state: AppState;
  update: (fn: (s: AppState) => AppState) => void;
  session: AuthSession | null;
  onLogout: () => void;
}) {
  const settings = state.aiSettings;
  const providers = Object.values(settings.providers);
  const hiddenEnabled = container.providerSettings.isHiddenEnabled();
  const hiddenDefault = container.providerSettings.getHiddenDefaultFull();
  // Default (env) provider renders as a full card too — same UI as added ones.
  const visibleProviders = hiddenDefault ? [hiddenDefault, ...providers] : providers;
  const effectiveActive = container.providerSettings.getActiveProvider()?.id ?? null;
  const aiEnabled = settings.aiEnabled;
  const ws = settings.websearch;

  const updateWebsearch = (patch: Partial<AppState['aiSettings']['websearch']>) => {
    haptic();
    update((s) => ({ ...s, aiSettings: { ...s.aiSettings, websearch: { ...s.aiSettings.websearch, ...patch } } }));
  };

  // Navigation state for sub-screens
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [showLiveModal, setShowLiveModal] = useState(false);

  const handleSaveLiveConfig = (newCfg: LiveSettingsConfig) => {
    haptic();
    update((s) => ({
      ...s,
      aiSettings: {
        ...s.aiSettings,
        live: newCfg,
      },
    }));
    try {
      localStorage.setItem('levelup.live.settings.v1', JSON.stringify(newCfg));
    } catch {}
  };

  // Notifications state
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifSupported, setNotifSupported] = useState(false);
  const [notifReason, setNotifReason] = useState<NotificationUnsupportedReason | undefined>(undefined);
  const [notifPermission, setNotifPermission] = useState<NotificationPermissionStatus>('prompt');
  const [notifPopup, setNotifPopup] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifTesting, setNotifTesting] = useState(false);
  const [notifMessage, setNotifMessage] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [trackMessage, setTrackMessage] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  // Proactive Autonomous Agent & Incoming Calls state
  const [proactivePrefs, setProactivePrefs] = useState(() => proactiveAgentService.getPreferences());
  const [isPlayingRingtone, setIsPlayingRingtone] = useState(false);
  const customAudioInputRef = useRef<HTMLInputElement | null>(null);

  const updateProactive = (patch: Partial<typeof proactivePrefs>) => {
    haptic();
    const next = { ...proactivePrefs, ...patch };
    setProactivePrefs(next);
    proactiveAgentService.updatePreferences(next);
  };

  const handlePreviewRingtone = () => {
    haptic();
    if (isPlayingRingtone) {
      ringtonePlayer.stop();
      setIsPlayingRingtone(false);
    } else {
      setIsPlayingRingtone(true);
      ringtonePlayer.start({
        preset: proactivePrefs.ringtonePreset,
        customAudioUrl: proactivePrefs.customRingtoneUrl,
      });
      setTimeout(() => {
        ringtonePlayer.stop();
        setIsPlayingRingtone(false);
      }, 4000);
    }
  };

  const handleCustomAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target?.result as string;
      if (dataUrl) {
        updateProactive({
          ringtonePreset: 'custom',
          customRingtoneUrl: dataUrl,
        });
      }
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const support = getNotificationSupport();
      if (cancelled) return;
      setNotifSupported(support.supported);
      setNotifReason(support.reason);
      if (!support.supported) return;
      const [pref, perm] = await Promise.all([getNotificationPreference(), getNotificationPermission()]);
      if (cancelled) return;
      setNotifEnabled(pref);
      setNotifPermission(perm);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggleNotifications(checked: boolean) {
    haptic();
    if (checked) {
      // Consent popup pehle — "100% chalu" flow: popup → system dialog → (deny pe) Settings redirect
      setNotifPopup(true);
      return;
    }
    await setNotificationPreference(false);
    setNotifEnabled(false);
    setNotifMessage({ type: 'info', text: 'Notifications band kar di hain.' });
  }

  async function confirmEnableNotifications() {
    setNotifPopup(false);
    setNotifBusy(true);
    try {
      const perm = await requestNotificationPermission();
      setNotifPermission(perm);
      if (perm === 'granted') {
        await setNotificationPreference(true);
        setNotifEnabled(true);
        setNotifMessage({ type: 'ok', text: 'Notifications ON — AI reply aate hi alert milega.' });
      } else if (perm === 'unsupported') {
        setNotifEnabled(false);
        setNotifMessage({ type: 'error', text: 'Is device pe notifications supported nahi hain.' });
      } else {
        await setNotificationPreference(false);
        setNotifEnabled(false);
        setNotifMessage({ type: 'error', text: 'Permission nahi mili — neeche diye steps se Settings se ON karo.' });
      }
    } finally {
      setNotifBusy(false);
    }
  }

  async function openSettingsFromApp() {
    haptic();
    const ok = await openNotificationSettings();
    if (!ok) setNotifMessage({ type: 'info', text: 'Settings khul nahi payi — upar diye steps manually follow karo.' });
  }

  // Data & Backup state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupScope, setBackupScope] = useState<BackupScope>('full');
  const [backupStatus, setBackupStatus] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ json: string; fileName: string; preview: BackupSummary } | null>(null);
  const [importing, setImporting] = useState(false);

  // Sync status (offline-first backup to server)
  const [_syncVersion, setSyncVersion] = useState(0);
  const [syncingNow, setSyncingNow] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  useEffect(() => container.syncCoordinator.subscribe(() => setSyncVersion((v) => v + 1)), []);
  const syncState = (scope: 'state' | 'chat') => container.syncCoordinator.getScopeState(scope);
  const syncOnline = container.syncCoordinator.isOnline();
  const syncAttached = container.syncCoordinator.isAttached;

  async function handleSyncNow() {
    setSyncingNow(true);
    try {
      await container.syncCoordinator.syncNow();
    } finally {
      setSyncingNow(false);
      setSyncVersion((v) => v + 1);
    }
  }

  function handleLogoutClick() {
    if (!session) {
      onLogout();
      return;
    }
    const wipe = window.confirm('Logout pe server ka backup bhi delete karein? "OK" = delete, "Cancel" = backup rehne de.');
    setLogoutBusy(true);
    void (async () => {
      if (wipe) {
        try {
          await container.sync.wipe(session);
        } catch {
          // Wipe is best-effort — logout must still proceed even offline.
        }
      }
      container.syncCoordinator.detach();
      setLogoutBusy(false);
      onLogout();
    })();
  }

  /**
   * "Delete all data": wipes progress, chat, memory, providers and settings —
   * locally and on the server — then returns the app to its default stage.
   * The login session and default server AI credentials are preserved, so the
   * user stays signed in and the hidden provider keeps working.
   */
  async function handleDeleteAllData() {
    if (!confirmDeleteAll) return;
    setDeletingAll(true);
    try {
      await deleteAllData(container, session);
      // Re-read the freshly restored state so every mounted screen re-renders,
      // and let the chat screen swap in the (now empty) session list too.
      update(() => container.store.get());
      window.dispatchEvent(new Event('levelup:backup-imported'));
      setBackupStatus({ type: 'ok', text: 'Sab data delete ho gaya — app default stage pe wapas aa gaya.' });
    } catch (err) {
      setBackupStatus({ type: 'error', text: shortError(err) });
      // A mid-sequence failure rolled the wipe back to the pre-delete data —
      // re-read the restored store so every screen shows the real (intact)
      // data instead of the half-wiped state.
      update(() => container.store.get());
    } finally {
      setDeletingAll(false);
      setConfirmDeleteAll(false);
    }
  }

  // Chat Settings sub-screen
  if (showChatSettings) {
    return (
      <Suspense fallback={<div className="screen"><ScreenHeader eyebrow="" title="Loading..." /></div>}>
        <ChatSettingsScreen state={state} update={update} onBack={() => setShowChatSettings(false)} />
      </Suspense>
    );
  }

  function setAiEnabled(enabled: boolean) {
    haptic();
    update((s) => ({ ...s, aiSettings: { ...s.aiSettings, aiEnabled: enabled } }));
  }

  function upsert(config: ProviderConfig) {
    update((s) => {
      const usable = container.providerSettings.isUsable(config);
      const activeProviderId = usable && s.aiSettings.activeProviderId === null ? config.id : s.aiSettings.activeProviderId;
      return {
        ...s,
        aiSettings: {
          ...s.aiSettings,
          aiEnabled: s.aiSettings.aiEnabled || usable,
          activeProviderId,
          providers: { ...s.aiSettings.providers, [config.id]: config },
        },
      };
    });
  }

  function setActive(id: string | null) {
    haptic();
    update((s) => ({ ...s, aiSettings: { ...s.aiSettings, activeProviderId: id } }));
  }

  async function handleExport() {
    haptic();
    try {
      const json = container.backup.export(backupScope);
      const fileName = `levelup-backup-${backupScope === 'full' ? '' : `${backupScope}-`}${new Date().toISOString().slice(0, 10)}.json`;
      const result = await exportTextFile(json, fileName);
      if (!result.ok) {
        setBackupStatus({ type: 'error', text: result.message });
        return;
      }
      const payload = parseBackup(json);
      const preview = summarizeBackup(
        normalizeState(payload.data.state),
        payload.scope === 'full' ? container.chat.listSessions() : [],
        json.length,
        payload.scope,
      );
      setBackupStatus({ type: 'ok', text: `${result.message} · ${formatBytes(preview.bytes)} · ${describeSummary(preview)}` });
    } catch (err) {
      setBackupStatus({ type: 'error', text: shortError(err) });
    }
  }

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    haptic();
    try {
      const text = await file.text();
      const payload = parseBackup(text);
      const preview = summarizeBackup(
        normalizeState(payload.data.state),
        payload.scope === 'full' ? normalizeChatSessions(payload.data.chat) : [],
        text.length,
        payload.scope,
      );
      setPendingImport({ json: text, fileName: file.name, preview });
      setBackupStatus(null);
    } catch (err) {
      setPendingImport(null);
      setBackupStatus({ type: 'error', text: shortError(err) });
    }
  }

  function confirmImport() {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const summary = container.backup.import(pendingImport.json);
      // Re-read the freshly restored state so every mounted screen re-renders,
      // and let the chat screen swap in the restored sessions too (full only —
      // scoped imports never touch chat, so the event is harmless either way).
      update(() => container.store.get());
      window.dispatchEvent(new Event('levelup:backup-imported'));
      setBackupStatus({ type: 'ok', text: `Backup restore ho gaya — ${describeSummary(summary)}` });
      setPendingImport(null);
    } catch (err) {
      setBackupStatus({ type: 'error', text: shortError(err) });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="screen fade-up">
      <ScreenHeader eyebrow="CONTROL CENTER" title="Settings" subtitle="AI planning, chat memory aur provider connections — sab yahan." />

      <section className="relative mb-5 overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-24 h-44 w-44 rounded-full bg-l/10 blur-3xl" aria-hidden="true" />
        <div className="relative flex items-start justify-between gap-4">
          <span
            className="badge"
            style={{ backgroundColor: aiEnabled ? 'rgba(163,19,19,0.13)' : 'rgba(92,88,78,0.18)', color: aiEnabled ? 'var(--color-success)' : 'var(--color-muted)' }}
          >
            <Sparkles size={11} /> {aiEnabled ? 'AI online' : 'Manual mode'}
          </span>
          <label className="toggle" title="Toggle AI planning">
            <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} aria-label="Toggle AI planning" />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>
        <p className="relative mt-2.5 max-w-sm text-sm leading-relaxed text-muted">
          Off = stable deterministic planning. Data stays local.
        </p>
        <div className="stat-strip relative mt-4">
          <MiniStat label="Providers" value={String(visibleProviders.length)} />
          <MiniStat label="Enabled" value={String(visibleProviders.filter((p) => p.enabled).length)} />
          <MiniStat label="Active" value={effectiveActive ? 'Set' : 'None'} />
        </div>
      </section>

      {/* Quick Settings: Live Voice & Chat Experience */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => {
            haptic();
            setShowLiveModal(true);
          }}
          className="card group flex items-center justify-between p-4 text-left transition-colors hover:border-border-strong active:scale-[0.99]"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l transition-transform group-hover:scale-105">
              <PhoneCall size={18} />
            </span>
            <div>
              <p className="font-display text-sm font-bold text-text">Live Companion</p>
              <p className="text-xs text-muted">Voice, speed, camera & screen FPS</p>
            </div>
          </div>
          <ChevronRight size={16} className="text-muted-dim transition-transform group-hover:translate-x-0.5" />
        </button>

        <button
          type="button"
          onClick={() => {
            haptic();
            setShowChatSettings(true);
          }}
          className="card group flex items-center justify-between p-4 text-left transition-colors hover:border-border-strong active:scale-[0.99]"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l transition-transform group-hover:scale-105">
              <SlidersHorizontal size={18} />
            </span>
            <div>
              <p className="font-display text-sm font-bold text-text">Chat Experience</p>
              <p className="text-xs text-muted">Persona, models, prompts & style</p>
            </div>
          </div>
          <ChevronRight size={16} className="text-muted-dim transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      {session ? (
        <>
          <div className="mb-2.5">
            <SectionHeader
              icon={<ShieldCheck size={14} color="var(--color-l)" />}
              accent="var(--color-l)"
              title="Account"
              meta="signed in"
            />
          </div>

          <div className="card mb-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
                  <ShieldCheck size={19} />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-display text-[15px] font-bold">
                    {session.username}
                    {session.role === 'admin' && (
                      <span className="badge" style={{ backgroundColor: 'rgba(239,233,223,0.14)', color: 'var(--color-light)' }}>
                        admin
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <button type="button" onClick={handleLogoutClick} disabled={logoutBusy} className="btn btn-ghost min-h-9 shrink-0 gap-1.5 px-3 text-xs">
                <LogOut size={13} /> {logoutBusy ? 'Logging out…' : 'Logout'}
              </button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-dim">
              Chat server se chalti hai — per-user quota server pe track hoti hai.
            </p>
          </div>

          <div className="mb-2.5">
            <SectionHeader
              icon={<RefreshCw size={14} color="var(--color-l)" />}
              accent="var(--color-l)"
              title="Data Sync"
              meta="offline-first backup"
            />
          </div>

          <div className="card mb-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
                  {syncOnline ? <Wifi size={19} /> : <WifiOff size={19} />}
                </span>
                <div className="min-w-0">
                  <p className="font-display text-[15px] font-bold">{syncOnline ? 'Synced' : 'Offline'}</p>
                  <p className="text-xs leading-snug text-muted">
                    {!syncOnline
                      ? 'Internet nahi hai — badla hua data push hone ka wait kar raha hai.'
                      : !syncAttached
                        ? 'Sync ready.'
                        : `State: ${describeSyncState(syncState('state').state)} · Chat: ${describeSyncState(syncState('chat').state)}`}
                  </p>
                  {syncAttached && (syncState('state').lastSyncedAt || syncState('chat').lastSyncedAt) && (
                    <p className="mt-1 text-[11px] text-muted-dim">
                      Last sync: {syncState('state').lastSyncedAt ?? syncState('chat').lastSyncedAt}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncingNow || !syncOnline || !syncAttached}
                className="btn btn-ghost min-h-9 shrink-0 gap-1.5 px-3 text-xs"
              >
                <RefreshCw size={13} className={syncingNow ? 'animate-spin' : ''} /> {syncingNow ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-dim">
              Server pe encrypted backup — login karke naye device pe restore karo.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2.5">
            <SectionHeader
              icon={<ShieldCheck size={14} color="var(--color-l)" />}
              accent="var(--color-l)"
              title="Account"
              meta="offline mode"
            />
          </div>

          <div className="card mb-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
                  <WifiOff size={19} />
                </span>
                <div className="min-w-0">
                  <p className="font-display text-[15px] font-bold">Offline mode</p>
                </div>
              </div>
              <button type="button" onClick={handleLogoutClick} className="btn btn-ghost min-h-9 shrink-0 gap-1.5 px-3 text-xs">
                <LogIn size={13} /> Login
              </button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-dim">
              Login skip — data sirf is device pe, AI server model aur backup band hain.
            </p>
          </div>
        </>
      )}

      {hiddenEnabled && hiddenDefault && (
        <div className="card mb-4 flex items-start gap-2.5 p-3.5 text-sm text-muted">
          <ShieldCheck size={16} color="var(--color-light)" className="mt-0.5 shrink-0" />
          <span>
            Built-in default provider. Manage API key, Base URL, Model here — Models button fetches the server
            <span className="font-mono text-[11px] text-text">/models</span> catalog.
          </span>
        </div>
      )}


      {/* Misa Proactive & Incoming Calls — dev features (in development) */}
      <div className="mb-2.5">
        <SectionHeader
          icon={<PhoneIncoming size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Misa Autonomous Calls & Proactivity"
          meta={proactivePrefs.enabled ? 'active ✨' : 'off ✨'}
        />
      </div>

      <div className="card mb-4 p-4 space-y-4">
        {/* Toggle Proactive Messages */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
              <Sparkles size={19} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-display text-[15px] font-bold">Proactive study nudges</p>
                <Sparkles size={14} className="text-peak" aria-label="In development" />
              </div>
              <p className="text-xs leading-snug text-muted">
                Misa spontaneously checks in, follows up on your study struggles, and keeps momentum going (100% Offline & Online).
              </p>
            </div>
          </div>
          <label className="toggle mt-1 shrink-0" title="Toggle proactive messages">
            <input
              type="checkbox"
              checked={proactivePrefs.enabled}
              onChange={(e) => updateProactive({ enabled: e.target.checked })}
              aria-label="Toggle proactive study nudges"
            />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>

        {/* Toggle Incoming Calls */}
        <div className="border-t border-border/60 pt-3 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
              <PhoneCall size={19} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-display text-[15px] font-bold">WhatsApp-style incoming live calls</p>
                <Sparkles size={14} className="text-peak" aria-label="In development" />
              </div>
              <p className="text-xs leading-snug text-muted">
                Misa can call you live for scheduled study checks or quick verbal problem-solving (rare & spam-free).
              </p>
            </div>
          </div>
          <label className="toggle mt-1 shrink-0" title="Toggle incoming calls">
            <input
              type="checkbox"
              checked={proactivePrefs.callsEnabled}
              onChange={(e) => updateProactive({ callsEnabled: e.target.checked })}
              aria-label="Toggle WhatsApp-style incoming live calls"
            />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>

        {/* Call Frequency */}
        {proactivePrefs.callsEnabled && (
          <div className="border-t border-border/60 pt-3 space-y-1.5">
            <label className="text-xs font-semibold text-muted">Spontaneous calling frequency</label>
            <select
              value={proactivePrefs.callFrequency}
              onChange={(e) => updateProactive({ callFrequency: e.target.value as any })}
              className="w-full rounded-xl border border-border bg-panel px-3 py-2 text-sm font-medium text-text focus:outline-none"
            >
              <option value="balanced">Balanced (1 call every 2–3 days)</option>
              <option value="rare">Rare (1 call every 4 days)</option>
              <option value="request_only">Only when I ask ("Misa call karo")</option>
            </select>
          </div>
        )}

        {/* Ringtone Selector & Custom Upload */}
        {proactivePrefs.callsEnabled && (
          <div className="border-t border-border/60 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-muted flex items-center gap-1.5">
                <Music size={13} className="text-l" />
                <span>Call Ringtone</span>
              </label>
              <button
                type="button"
                onClick={handlePreviewRingtone}
                className="inline-flex items-center gap-1 text-xs font-bold text-l hover:underline focus:outline-none"
              >
                {isPlayingRingtone ? <Square size={11} className="fill-current" /> : <Play size={11} className="fill-current" />}
                <span>{isPlayingRingtone ? 'Stop Preview' : 'Play Ringtone'}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {RINGTONE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    if (preset.id === 'custom' && !proactivePrefs.customRingtoneUrl) {
                      customAudioInputRef.current?.click();
                    } else {
                      updateProactive({ ringtonePreset: preset.id });
                    }
                  }}
                  className={`flex flex-col items-start p-2.5 rounded-xl border text-left transition-all ${
                    proactivePrefs.ringtonePreset === preset.id
                      ? 'border-l bg-l/10 text-text font-bold'
                      : 'border-border bg-panel text-muted hover:border-border-strong'
                  }`}
                >
                  <span className="text-xs font-semibold text-text">{preset.name}</span>
                  <span className="text-[10px] text-muted line-clamp-1">{preset.description}</span>
                </button>
              ))}
            </div>

            {/* Custom file upload input */}
            <input
              ref={customAudioInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleCustomAudioUpload}
            />

            {proactivePrefs.ringtonePreset === 'custom' && (
              <button
                type="button"
                onClick={() => customAudioInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-dashed border-border hover:border-l text-xs font-semibold text-muted hover:text-l transition-colors"
              >
                <Upload size={13} />
                <span>{proactivePrefs.customRingtoneUrl ? 'Change custom audio file' : 'Upload custom audio file (.mp3, .wav)'}</span>
              </button>
            )}
          </div>
        )}

        {/* Quiet Hours */}
        <div className="border-t border-border/60 pt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-semibold text-muted">Quiet hours start (DND)</label>
            <input
              type="time"
              value={proactivePrefs.quietHoursStart}
              onChange={(e) => updateProactive({ quietHoursStart: e.target.value })}
              className="w-full mt-1 rounded-xl border border-border bg-panel px-3 py-1.5 text-xs text-text font-mono focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-muted">Quiet hours end</label>
            <input
              type="time"
              value={proactivePrefs.quietHoursEnd}
              onChange={(e) => updateProactive({ quietHoursEnd: e.target.value })}
              className="w-full mt-1 rounded-xl border border-border bg-panel px-3 py-1.5 text-xs text-text font-mono focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="mb-2.5">
        <SectionHeader
          icon={<Globe size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Web Search"
          meta={ws.enabled ? 'on' : 'off'}
        />
      </div>

      <div className="card mb-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
              <Globe size={19} />
            </span>
            <div className="min-w-0">
              <p className="font-display text-[15px] font-bold">Live web search</p>
              <p className="text-xs leading-snug text-muted">ON → AI khud live search karega jab current info chahiye (news, results, syllabus). @websearch mention se guaranteed search. OFF → koi search nahi.</p>
            </div>
          </div>
          <label className="toggle mt-1 shrink-0" title="Toggle live web search">
            <input
              type="checkbox"
              checked={ws.enabled}
              onChange={(e) => updateWebsearch({ enabled: e.target.checked, providerId: e.target.checked ? ws.providerId ?? 'google' : ws.providerId })}
              aria-label="Toggle live web search"
            />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>

        {ws.enabled && (
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <span className="field-label">Search provider</span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {(
                  [
                    { id: 'google', label: 'Google (Gemini)' },
                    { id: 'smartrotator', label: 'SmartRotator' },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => updateWebsearch({ providerId: p.id })}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                      ws.providerId === p.id ? 'text-white' : 'text-muted'
                    }`}
                    style={
                      ws.providerId === p.id
                        ? { backgroundColor: 'var(--color-l)' }
                        : { backgroundColor: 'rgba(239,233,223,0.08)' }
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {ws.providerId === 'google' ? (
              <>
                <Field label="Google API key">
                  <input
                    type="password"
                    className="field"
                    value={ws.apiKey}
                    placeholder="AIzaSy..."
                    onChange={(e) => updateWebsearch({ apiKey: e.target.value })}
                  />
                </Field>
                <Field label="Model">
                  <input
                    className="field"
                    list="ws-gemini-models"
                    value={ws.model}
                    placeholder="gemini-2.5-flash"
                    onChange={(e) => updateWebsearch({ model: e.target.value })}
                  />
                  <datalist id="ws-gemini-models">
                    <option value="gemini-2.5-flash" />
                    <option value="gemini-2.5-pro" />
                    <option value="gemini-2.5-flash-lite" />
                    <option value="gemini-3.1-flash-live-preview" />
                  </datalist>
                </Field>
                <Field label="Base URL (optional)">
                  <input
                    className="field"
                    value={ws.baseUrl}
                    placeholder="https://generativelanguage.googleapis.com"
                    onChange={(e) => updateWebsearch({ baseUrl: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="SmartRotator API key">
                  <input
                    type="password"
                    className="field"
                    value={session?.apiKey || ws.apiKey || ''}
                    placeholder={session ? 'Login key (auto)' : 'Login karke key milegi'}
                    disabled={!!session}
                    onChange={(e) => updateWebsearch({ apiKey: e.target.value })}
                  />
                  {session ? (
                    <p className="mt-1 text-[11px] leading-snug text-muted">
                      Login key auto-use ho rahi hai — fresh login ke saath update hoti hai. Manual key daalne ki zaroorat nahi.
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] leading-snug text-muted">
                      Manual key daal sakte ho, ya login karke auto key use karo.
                    </p>
                  )}
                </Field>
                <Field label="Model (optional)">
                  <input
                    className="field"
                    value={ws.model}
                    placeholder="e.g. gemini-2.5-flash"
                    onChange={(e) => updateWebsearch({ model: e.target.value })}
                  />
                </Field>
                {!session && (
                  <p className="rounded-xl px-3 py-2 text-xs" style={{ backgroundColor: 'rgba(216,31,20,0.1)', color: 'var(--color-danger)' }}>
                    SmartRotator web search ke liye login karna padega — login key se search chalti hai.
                  </p>
                )}
              </>
            )}

            <p className="text-[11px] leading-relaxed text-muted-dim">
              ON = har reply se pehle live search chalta hai (thoda slow ho sakta hai). Raw results kabhi nahi dikhte — Misa sirf current
              facts ke liye use karti hai.
            </p>
          </div>
        )}
      </div>

      <div className="mb-2.5">
        <SectionHeader
          icon={<Bell size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Notifications"
          meta={notifEnabled ? 'on' : 'off'}
        />
      </div>

      <div className="card mb-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
              {notifEnabled ? <Bell size={19} /> : <BellOff size={19} />}
            </span>
            <div className="min-w-0">
              <p className="font-display text-[15px] font-bold">AI reply notifications</p>
              <p className="text-xs leading-snug text-muted">
                Alert on every AI reply — even when locked or in background.
              </p>
            </div>
          </div>
          <label className="toggle mt-1 shrink-0" title="Toggle AI reply notifications">
            <input
              type="checkbox"
              checked={notifEnabled}
              disabled={!notifSupported || notifBusy}
              onChange={(e) => void onToggleNotifications(e.target.checked)}
              aria-label="Toggle AI reply notifications"
            />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>

        {!notifSupported && (
          <p className="mt-3 rounded-xl px-3 py-2 text-xs" style={{ backgroundColor: 'rgba(216,31,20,0.1)', color: 'var(--color-danger)' }}>
            {notifReason === 'insecure'
              ? 'Browser notifications ke liye secure connection chahiye — app ko localhost ya HTTPS se kholo (http://192.168.x.x jaise LAN address pe browser ye feature band kar deta hai).'
              : 'Is browser/device pe notifications supported nahi hain — best experience ke liye Android app (APK) use karo.'}
          </p>
        )}

        {notifMessage && (
          <p
            className="mt-3 rounded-xl px-3 py-2 text-xs"
            style={
              notifMessage.type === 'error'
                ? { backgroundColor: 'rgba(216,31,20,0.12)', color: 'var(--color-danger)' }
                : notifMessage.type === 'ok'
                  ? { backgroundColor: 'rgba(163,19,19,0.13)', color: 'var(--color-success)' }
                  : { backgroundColor: 'rgba(163,19,19,0.13)', color: 'var(--color-l)' }
            }
          >
            {notifMessage.text}
          </p>
        )}

        {notifPermission === 'denied' && (
          <div className="mt-3 rounded-xl border border-border bg-bg/60 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-danger">
              <ShieldAlert size={14} /> Permission denied
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">Android Settings se manually ON karni padegi:</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-muted">
              <li>Settings → Apps → LevelUp kholo</li>
              <li>Notifications par tap karo</li>
              <li>"Allow notifications" (ya "Show notifications") ko ON karo</li>
            </ol>
            {isNativePlatform() && (
              <button type="button" onClick={() => void openSettingsFromApp()} className="btn btn-primary mt-3 min-h-10 w-full gap-2 text-xs">
                <ExternalLink size={13} /> Open Settings
              </button>
            )}
          </div>
        )}

        {notifEnabled && notifPermission === 'granted' && (
          <div className="mt-3">
            <p className="flex items-center gap-1.5 text-xs text-success">
              <Check size={13} /> Notifications chalu hain — AI reply aate hi alert milega.
            </p>
            <button
              type="button"
              onClick={() => {
                haptic();
                setNotifTesting(true);
                setNotifMessage(null);
                void notifyTest()
                  .then((ok) =>
                    setNotifMessage(
                      ok
                        ? { type: 'ok', text: 'Test notification bhej di — phone pe check karo! Notification me "Reply" se seedha Misa ko likh sakte ho.' }
                        : { type: 'error', text: 'Test notification nahi bhej paye — permission ya channel check karo.' },
                    ),
                  )
                  .finally(() => setNotifTesting(false));
              }}
              disabled={notifTesting}
              className="btn btn-ghost mt-2 min-h-9 gap-1.5 px-3 text-xs"
            >
              <Bell size={13} /> {notifTesting ? 'Bhej rahe…' : 'Test notification bhejo'}
            </button>
          </div>
        )}
      </div>

      <div className="mb-2.5">
        <SectionHeader
          icon={<ListChecks size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Track & Curriculum Mode"
          meta={state.enable90DayTrack !== false ? '90-day track' : 'flexible mode'}
        />
      </div>

      <div className="card mb-4 p-4 space-y-4">
        {/* Toggle 1: 90-Day Challenge Mode */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
              <LayoutList size={19} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-display text-[15px] font-bold">90-Day Challenge Track</p>
                {state.pausedTrackDay && (
                  <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-400">
                    ⏸ Paused at Day {state.pausedTrackDay}
                  </span>
                )}
              </div>
              <p className="text-xs leading-snug text-muted mt-0.5">
                {state.enable90DayTrack !== false
                  ? `ON (Day ${getCurrentDayNumber(state, today) || 1}): 90 Days JEE curriculum with Levels growth map & Task bank active.`
                  : state.pausedTrackDay
                  ? `OFF (Paused at Day ${state.pausedTrackDay}): Wapas ON karne par exact Day ${state.pausedTrackDay} se resume hoga.`
                  : 'OFF: Flexible Daily Planner mode (Levels & Task bank hidden). Use for custom to-dos & general study.'}
              </p>
            </div>
          </div>
          <label className="toggle mt-1 shrink-0" title="Toggle 90-Day Challenge Track">
            <input
              type="checkbox"
              checked={state.enable90DayTrack !== false}
              onChange={(e) => {
                const checked = e.target.checked;
                haptic();
                if (!checked) {
                  setShowPauseModal(true);
                } else {
                  if (state.pausedTrackDay) {
                    const resumeDay = state.pausedTrackDay;
                    const newStartDate = isoAddDays(today, -(resumeDay - 1));
                    update((s) => ({
                      ...s,
                      enable90DayTrack: true,
                      startDateISO: newStartDate,
                      pausedTrackDay: undefined,
                    }));
                    setTrackMessage({ type: 'ok', text: `90-Day Challenge Day ${resumeDay} se resume ho gaya!` });
                  } else {
                    update((s) => ({
                      ...s,
                      enable90DayTrack: true,
                      startDateISO: s.startDateISO || today,
                    }));
                    setTrackMessage({ type: 'ok', text: '90-Day Challenge Track ON ho gaya.' });
                  }
                }
              }}
              aria-label="Toggle 90-Day Challenge Track"
            />
            <span className="track">
              <span className="thumb" />
            </span>
          </label>
        </div>

        {trackMessage && (
          <div
            className={`rounded-xl border p-3 text-xs leading-relaxed ${
              trackMessage.type === 'ok'
                ? 'border-green-500/30 bg-green-500/10 text-green-300'
                : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
            }`}
          >
            {trackMessage.text}
          </div>
        )}

        {/* Toggle 2: Advanced curriculum controls (only when 90-day is ON) */}
        {state.enable90DayTrack !== false && (
          <div className="flex items-start justify-between gap-4 border-t border-border/50 pt-3">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-muted">
                <ListChecks size={16} />
              </span>
              <div className="min-w-0">
                <p className="font-display text-sm font-bold">Advanced curriculum editing</p>
                <p className="text-[11px] leading-snug text-muted">
                  ON: full edit controls on Levels tab (add/edit/delete blocks, tasks, habits).
                </p>
              </div>
            </div>
            <label className="toggle mt-0.5 shrink-0" title="Toggle advanced curriculum controls">
              <input
                type="checkbox"
                checked={state.curriculumEditing}
                onChange={(e) => {
                  haptic();
                  update((s) => ({ ...s, curriculumEditing: e.target.checked }));
                }}
                aria-label="Toggle advanced curriculum controls"
              />
              <span className="track">
                <span className="thumb" />
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Pause / Delete 90-Day Track Confirmation Modal */}
      {showPauseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm fade-in">
          <div className="card w-full max-w-md p-5 space-y-4 border-l/40 bg-panel-raised shadow-2xl">
            <div className="flex items-center gap-2.5 text-amber-400">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3 className="font-display text-base font-bold text-text">90-Day Track Off Karein?</h3>
                <p className="text-xs text-muted">Aap abhi Day {getCurrentDayNumber(state, today) || 1} par hain.</p>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-muted">
              90-Day Track band karne par Levels map aur Task Bank hide ho jayenge aur app Flexible To-Dos mode me switch ho jayega. Apna progress choose karein:
            </p>

            <div className="space-y-2.5 pt-1">
              {/* Pause Option */}
              <button
                type="button"
                onClick={() => {
                  haptic();
                  const day = getCurrentDayNumber(state, today) || 1;
                  update((s) => ({
                    ...s,
                    enable90DayTrack: false,
                    pausedTrackDay: day,
                  }));
                  setShowPauseModal(false);
                  setTrackMessage({
                    type: 'info',
                    text: `90-Day Track Day ${day} pe pause ho gaya. Jab bhi wapas ON karoge, exact Day ${day} se resume hoga!`,
                  });
                }}
                className="w-full flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left transition-all hover:border-amber-500/60 active:scale-[0.98]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 mt-0.5">
                  <Pause size={16} />
                </span>
                <div className="min-w-0">
                  <p className="font-display text-xs font-bold text-text flex items-center gap-1.5">
                    Pause Track (Recommended)
                    <span className="text-[10px] rounded bg-amber-500/20 text-amber-300 px-1.5 py-0.2">Freeze Day {getCurrentDayNumber(state, today) || 1}</span>
                  </p>
                  <p className="text-[11px] text-muted mt-0.5 leading-snug">
                    Progress save rahegi. Jab bhi wapas ON karoge, exact <b>Day {getCurrentDayNumber(state, today) || 1}</b> se bina kisi progress loss ke chalu hoga.
                  </p>
                </div>
              </button>

              {/* Reset/Delete Option */}
              <button
                type="button"
                onClick={() => {
                  haptic();
                  update((s) => ({
                    ...s,
                    enable90DayTrack: false,
                    startDateISO: null,
                    pausedTrackDay: undefined,
                    clearedLevels: [],
                    bonusDaysUsed: 0,
                    taskLogs: {},
                    masteryPlacement: {},
                    planCache: {},
                  }));
                  setShowPauseModal(false);
                  setTrackMessage({
                    type: 'info',
                    text: '90-Day Challenge data reset ho gaya. Flexible mode active.',
                  });
                }}
                className="w-full flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-left transition-all hover:border-rose-500/60 active:scale-[0.98]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-400 mt-0.5">
                  <Trash2 size={16} />
                </span>
                <div className="min-w-0">
                  <p className="font-display text-xs font-bold text-rose-300">
                    Delete & Reset 90-Day Progress
                  </p>
                  <p className="text-[11px] text-muted mt-0.5 leading-snug">
                    90-Day track start date, level clears aur curriculum logs reset ho jayenge.
                  </p>
                </div>
              </button>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setShowPauseModal(false)}
                className="btn btn-ghost text-xs px-4"
              >
                Cancel (Keep ON)
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-2.5">
        <SectionHeader
          icon={<Database size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Data & Backup"
          meta="export / import"
        />
      </div>

      <div className="card mb-4 p-4">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-l/10 text-l">
            <Database size={19} />
          </span>
          <div className="min-w-0">
            <p className="font-display text-[15px] font-bold">Sab data, ek file mein</p>
            <p className="text-xs leading-snug text-muted">Full backup = everything (plan, tasks, progress, memory, chats, providers). Tasks/Levels export only that data.</p>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-1.5">
          {([
            { id: 'full', label: 'Full', hint: 'sab kuch' },
            { id: 'tasks', label: 'Tasks', hint: 'tasks + habits + plans' },
            { id: 'levels', label: 'Levels', hint: 'levels + reviews' },
          ] as { id: BackupScope; label: string; hint: string }[]).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                haptic(6);
                setBackupScope(opt.id);
              }}
              className="min-h-12 rounded-xl border px-2 py-1.5 text-center transition-colors"
              style={
                backupScope === opt.id
                  ? { borderColor: 'var(--color-l)', backgroundColor: 'rgba(163,19,19,0.12)' }
                  : { borderColor: 'var(--color-border)', backgroundColor: 'transparent' }
              }
            >
              <span className="block text-xs font-bold text-text">{opt.label}</span>
              <span className="block text-[10px] text-muted">{opt.hint}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={handleExport} className="btn btn-primary min-h-10 gap-2">
            <Download size={15} /> Export
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="btn btn-ghost min-h-10 gap-2">
            <Upload size={15} /> Import
          </button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={onFileSelected} aria-label="Import backup file" />
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-muted-dim">
          Full backup includes API keys — keep it safe. Model cache and env provider are not exported.
        </p>

        {backupStatus && (
          <p
            className="mt-3 rounded-xl px-3 py-2 text-xs"
            style={
              backupStatus.type === 'error'
                ? { backgroundColor: 'rgba(216,31,20,0.12)', color: 'var(--color-danger)' }
                : backupStatus.type === 'ok'
                  ? { backgroundColor: 'rgba(163,19,19,0.13)', color: 'var(--color-success)' }
                  : { backgroundColor: 'rgba(163,19,19,0.13)', color: 'var(--color-l)' }
            }
          >
            {backupStatus.text}
          </p>
        )}

        {pendingImport && (
          <div className="mt-3 rounded-xl border border-border bg-bg/60 p-3">
            <p className="flex items-start gap-2 text-xs font-semibold text-text">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
              "{pendingImport.fileName}" restore karna hai?
              {pendingImport.preview.scope === 'full'
                ? ' Abhi ka saara data replace ho jayega.'
                : pendingImport.preview.scope === 'tasks'
                  ? ' Sirf tasks/habits/plans ka data merge hoga — baaki sab waisa hi rahega.'
                  : ' Sirf levels/reviews ka data merge hoga — baaki sab waisa hi rahega.'}
            </p>
            <p className="mt-1 text-[11px] text-muted">{describeSummary(pendingImport.preview)}</p>
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => setPendingImport(null)} className="btn btn-ghost min-h-9 flex-1 text-xs">
                Cancel
              </button>
              <button type="button" onClick={confirmImport} disabled={importing} className="btn min-h-9 flex-1 border border-danger/40 text-xs text-danger" style={{ backgroundColor: 'rgba(216,31,20,0.1)' }}>
                {importing ? 'Restoring…' : 'Confirm Import'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card mb-4 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <Trash2 size={19} />
          </span>
          <div className="min-w-0">
            <p className="font-display text-[15px] font-bold">Delete all data</p>
            <p className="text-xs leading-snug text-muted">
              Sab data delete + server backup. Login aur default AI credentials safe.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={deletingAll}
            className="btn btn-ghost min-h-9 shrink-0 gap-1.5 px-3 text-xs text-danger"
          >
            <Trash2 size={13} /> Delete all
          </button>
        </div>
      </div>

      <div className="mb-2.5">
        <SectionHeader
          icon={<Plug size={14} color="var(--color-l)" />}
          accent="var(--color-l)"
          title="Providers"
          meta={visibleProviders.filter((p) => p.enabled).length > 0 ? `${visibleProviders.filter((p) => p.enabled).length} on` : 'none on'}
        />
      </div>

      {visibleProviders.length === 0 && (
        <div className="mb-4">
          <EmptyState
            icon={<WifiOff size={24} color="var(--color-muted)" />}
            title="Koi provider configure nahi"
            hint="Neeche se OpenRouter, Gemini ya custom provider add karo — phir Test dabake verify karo."
          />
        </div>
      )}

      {visibleProviders.map((p) => (
        <ProviderCard
          key={p.id}
          config={p}
          active={effectiveActive === p.id}
          onActive={() => setActive(p.id)}
          onUpdate={
            p.hidden
              ? (c) => {
                  container.providerSettings.updateHiddenDefault(c);
                  // Re-render so the card reflects the edit immediately.
                  update((s) => ({ ...s }));
                }
              : upsert
          }
          onRemove={
            p.hidden
              ? undefined
              : () =>
                  update((s) => {
                    const providers = { ...s.aiSettings.providers };
                    delete providers[p.id];
                    return { ...s, aiSettings: { ...s.aiSettings, providers, activeProviderId: settings.activeProviderId === p.id ? null : s.aiSettings.activeProviderId } };
                  })
          }
        />
      ))}

      <AddProviderForm onAdd={(config) => upsert(config)} />

      {confirmDeleteAll && (
        <div className="settings-modal-layer" role="dialog" aria-modal="true" aria-label="Delete all data">
          <button type="button" className="settings-modal-scrim" aria-label="Close" onClick={() => setConfirmDeleteAll(false)} />
          <div className="settings-modal">
            <header className="settings-modal-head">
              <div>
                <p className="eyebrow">Danger zone</p>
                <h2 className="font-display text-xl font-bold text-text">Sab data delete karna hai?</h2>
              </div>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setConfirmDeleteAll(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="settings-modal-body">
              <p className="text-sm leading-relaxed text-muted">
                Sab data + server backup delete. Login aur default AI credentials safe. Undo nahi.
              </p>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => setConfirmDeleteAll(false)} disabled={deletingAll} className="btn btn-ghost min-h-10 flex-1 text-xs">
                  No, cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteAllData()}
                  disabled={deletingAll}
                  className="btn min-h-10 flex-1 border border-danger/40 text-xs text-danger"
                  style={{ backgroundColor: 'rgba(216,31,20,0.1)' }}
                >
                  {deletingAll ? 'Deleting…' : 'Yes, delete all'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {notifPopup && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-5">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setNotifPopup(false)} aria-hidden="true" />
          <div role="dialog" aria-modal="true" aria-label="Enable notifications" className="gradient-border w-full max-w-sm rounded-2xl p-px">
            <div className="rounded-[calc(var(--radius-2xl)-1px)] bg-panel p-5">
              <div className="mb-4 flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: 'rgba(239,233,223,0.15)', color: 'var(--color-peak)' }}>
                    <Bell size={17} />
                  </div>
                  <div>
                    <p className="font-display text-[15px] font-bold">Notifications chalu karein?</p>
                    <p className="text-xs text-muted">AI replies ka alert</p>
                  </div>
                </div>
                <button type="button" onClick={() => setNotifPopup(false)} aria-label="Close" className="icon-btn">
                  <X size={16} />
                </button>
              </div>

              <p className="text-sm leading-relaxed text-muted">
                Jab Misa ka naya reply aayega, phone pe notification milega — app background me ho ya phone locked, tab
                bhi pata chal jayega.
              </p>

              <div className="mt-4 flex gap-2">
                <button type="button" className="btn btn-ghost min-h-10 flex-1 text-xs" onClick={() => setNotifPopup(false)}>
                  Abhi nahi
                </button>
                <button type="button" className="btn btn-primary min-h-10 flex-1 gap-2 text-xs" onClick={() => void confirmEnableNotifications()}>
                  <Bell size={14} /> Haan, chalu karo
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showLiveModal && (
        <LiveSettingsModal
          isOpen={showLiveModal}
          onClose={() => setShowLiveModal(false)}
          config={settings.live ?? DEFAULT_LIVE_SETTINGS}
          defaultApiKey={container.providerSettings.getActiveProvider()?.apiKey || ''}
          onSave={handleSaveLiveConfig}
        />
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-strip-item items-start text-left">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-dim">{label}</p>
      <p className="mt-1 font-display text-lg font-bold">{value}</p>
    </div>
  );
}

function ProviderCard({
  config,
  active,
  onActive,
  onUpdate,
  onRemove,
}: {
  config: ProviderConfig;
  active: boolean;
  onActive: () => void;
  onUpdate: (c: ProviderConfig) => void;
  onRemove?: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [health, setHealth] = useState<{ ok: boolean; latencyMs?: number; message?: string } | null>(null);

  async function loadModels(force = false) {
    setLoadingModels(true);
    setModelsError('');
    try {
      const list = await container.modelCache.getModels(config, force);
      setModels(list);
      if (list.length === 0) setModelsError('Provider ne koi model list nahi di. Base URL + API key check karo.');
    } catch (err) {
      setModels([]);
      setModelsError(shortError(err));
    } finally {
      setLoadingModels(false);
    }
  }

  async function runHealth() {
    const res = await container.providerSettings.healthCheck(config);
    setHealth({ ok: res.ok, latencyMs: res.latencyMs, message: res.message });
  }

  const usable = container.providerSettings.isUsable(config);
  const missingKey = !config.apiKey;
  const sorted = models ? [...models].sort((a, b) => Number(b.isFree) - Number(a.isFree) || a.name.localeCompare(b.name)) : null;
  const healthMsg = health && !health.ok && health.message ? health.message : null;
  const zenCorsHint = isZenId(config.id) && (!!modelsError || healthMsg !== null);

  return (
    <div className="gradient-border mb-3 rounded-2xl p-px" style={{ background: active ? undefined : 'var(--color-border)' }}>
      <div className="rounded-[calc(var(--radius-2xl)-1px)] bg-panel p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: active ? 'rgba(163,19,19,0.14)' : 'var(--color-panel-raised)' }}
          >
            {active ? <Sparkles size={16} color="var(--color-l)" /> : <KeyRound size={16} color="var(--color-muted)" />}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-[15px] font-bold">{config.label}</p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted">
              {usable ? (
                <>
                  <Wifi size={11} color="var(--color-success)" /> Ready
                </>
              ) : (
                <>
                  <WifiOff size={11} color="var(--color-muted-dim)" /> Not usable
                </>
              )}
              {health && health.ok && <span className="text-success">· {health.latencyMs}ms</span>}
            </p>
          </div>
        </div>
          <div className="flex shrink-0 items-center gap-1">
            {config.hidden && (
              <span className="badge" style={{ backgroundColor: 'rgba(239,233,223,0.12)', color: 'var(--color-light)' }}>
                Default
              </span>
            )}
            <button
              type="button"
              onClick={onActive}
              className={`badge shrink-0 cursor-pointer transition-colors ${active ? '' : 'hover:!text-text'}`}
              style={active ? { backgroundColor: 'rgba(163,19,19,0.16)', color: 'var(--color-l)' } : { backgroundColor: 'var(--color-panel-raised)', color: 'var(--color-muted)' }}
              aria-pressed={active}
            >
              {active ? <Check size={10} /> : null}
              {active ? 'Active' : 'Set active'}
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="icon-btn"
                style={{ minWidth: '2rem', minHeight: '2rem' }}
                aria-label={`Remove ${config.label}`}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
      </div>

      {/* enabled toggle */}
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-bg/60 px-3 py-2.5">
        <span className="text-sm text-muted">Enabled</span>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => onUpdate({ ...config, enabled: e.target.checked })}
            aria-label={`Toggle ${config.label}`}
          />
          <span className="track">
            <span className="thumb" />
          </span>
        </label>
      </div>

      <div className="space-y-3 text-sm">
        <Field label="API key">
          <input
            type="password"
            className="field"
            value={config.apiKey ?? ''}
            placeholder="sk-..."
            onChange={(e) => onUpdate({ ...config, apiKey: e.target.value || undefined })}
          />
        </Field>
        <Field label="Base URL">
          <input
            className="field"
            value={config.baseUrl ?? ''}
            placeholder={placeholderFor(config.id)}
            onChange={(e) => onUpdate({ ...config, baseUrl: e.target.value || undefined })}
          />
        </Field>
        <Field label="Model">
          <div className="space-y-1.5">
            <input
              className="field"
              value={config.model ?? ''}
              placeholder="e.g. gpt-4o-mini"
              onChange={(e) => onUpdate({ ...config, model: e.target.value || undefined })}
            />
            {sorted && sorted.length > 0 && (
              <select className="field" value={config.model ?? ''} onChange={(e) => onUpdate({ ...config, model: e.target.value || undefined })}>
                <option value="">— pick from catalog —</option>
                {sorted.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.isFree ? 'FREE ' : ''}
                    {m.name} · {m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : 'ctx?'}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => loadModels()} className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs">
            <RefreshCw size={12} className={loadingModels ? 'animate-spin' : ''} /> Models
          </button>
          <button type="button" onClick={() => loadModels(true)} className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs">
            Refresh catalog
          </button>
          <button type="button" onClick={runHealth} className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs">
            <Plug size={12} /> Test
          </button>
          {health && (
            <span className={`flex items-center gap-1 font-mono text-xs ${health.ok ? 'text-success' : 'text-danger'}`}>
              {health.ok ? <Wifi size={11} /> : <WifiOff size={11} />}
              {health.ok ? `ok (${health.latencyMs}ms)` : 'failed'}
            </span>
          )}
        </div>

        {!usable && (
          <p className="text-xs text-muted">
            {missingKey ? 'API key daalo — tabhi test/models kaam karenge.' : 'Provider usable nahi — base URL check karo.'}
          </p>
        )}

        <p className="break-all font-mono text-[10px] text-muted-dim">→ GET {resolvedModelsUrl(config.id, config.baseUrl)}</p>

        {zenCorsHint && (
          <p className="text-xs leading-relaxed text-light">
            Zen browser me CORS se fail hoga; APK me chalega. Preview me OpenRouter/Gemini use karo.
          </p>
        )}
        {modelsError && <p className="break-words text-xs text-danger">models: {modelsError}</p>}
        {healthMsg && <p className="break-words text-xs text-danger">test: {healthMsg}</p>}
      </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function placeholderFor(id: string): string {
  switch (id) {
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'opencode':
      return 'https://opencode.ai/zen/v1';
    default:
      return 'https://your-server/v1';
  }
}

function isZenId(id: string): boolean {
  return id === 'opencode' || id === 'opencode-zen';
}

function defaultBaseUrl(id: string): string {
  switch (id) {
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'opencode':
    case 'opencode-zen':
      return 'https://opencode.ai/zen/v1';
    default:
      return '';
  }
}

function resolvedModelsUrl(id: string, baseUrl: string | undefined): string {
  const base = (baseUrl || defaultBaseUrl(id)).replace(/\/+$/, '');
  if (!base) return '(base URL missing)';
  if (id === 'gemini') return `${base}/v1beta/models`;
  return `${base}/models`;
}

function shortError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
  }
  return String(err);
}

function describeSyncState(s: string): string {
  switch (s) {
    case 'syncing':
      return 'syncing…';
    case 'offline':
      return 'offline';
    case 'error':
      return 'error';
    case 'online':
      return 'synced';
    default:
      return 'idle';
  }
}

function describeSummary(s: BackupSummary): string {
  if (s.scope === 'tasks') {
    return [
      `Tasks · ${s.state.dynamicTasks} custom tasks`,
      `${s.state.totalDone} tasks done`,
      `${s.state.planDays} din ke plans`,
      s.state.dynamicPhases.length > 0 ? `phases: ${s.state.dynamicPhases.join(', ')}` : '',
    ].filter(Boolean).join(' · ');
  }
  if (s.scope === 'levels') {
    return [
      `Levels · ${s.state.clearedLevels} cleared`,
      `${s.state.weeklyReviews} weekly reviews`,
      `${s.state.monthlyAssessments} monthly assessments`,
    ].filter(Boolean).join(' · ');
  }
  const parts = [
    s.state.journeyStarted ? 'journey active' : 'journey abhi nahi',
    `${s.state.totalDone} tasks done`,
    `${s.state.dynamicTasks} custom tasks`,
    `${s.state.planDays} din ke plans`,
    s.state.dynamicPhases.length > 0 ? `phases: ${s.state.dynamicPhases.join(', ')}` : '',
    `${s.state.clearedLevels} levels cleared`,
    `${s.state.memoryEntries} memory entries`,
    `${s.chat.sessions} chats (${s.chat.messages} msgs)`,
  ];
  return parts.filter(Boolean).join(' · ');
}
