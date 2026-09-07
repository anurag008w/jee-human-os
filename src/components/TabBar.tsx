import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, BookOpen, CalendarCheck, Check, ChevronRight, Download, LayoutList, LineChart, ListTodo, Menu, MessageCircle, NotebookPen, PenLine, Pin, PinOff, Settings, Sparkles, Trash2, Upload, User, X } from 'lucide-react';
import type { AppState, UserProfile } from '../types';
import type { MemoryEntry } from '../core/domain/memory';
import { container } from '../di/container';
import { haptic } from '../lib/haptics';
import { exportTextFile } from '../lib/exportFile';
import MemorySummaryPanel from './MemorySummaryPanel';

export type Tab = 'today' | 'levels' | 'progress' | 'review' | 'task-bank' | 'ai' | 'chat' | 'updates' | 'planners';

const TABS: { id: Tab; label: string; hint: string; icon: typeof CalendarCheck; tone: 'l' | 'gold' | 'silver' | 'blood' | 'slate' | 'teal' | 'blue' | 'amber' | 'neutral' }[] = [
  { id: 'today', label: 'Today', hint: 'Daily mission', icon: CalendarCheck, tone: 'l' },
  { id: 'levels', label: 'Levels', hint: 'Growth map', icon: LayoutList, tone: 'gold' },
  { id: 'progress', label: 'Progress', hint: 'Analytics', icon: LineChart, tone: 'silver' },
  { id: 'review', label: 'Review', hint: 'Reflect', icon: NotebookPen, tone: 'slate' },
  { id: 'task-bank', label: 'Tasks', hint: 'Bank', icon: ListTodo, tone: 'teal' },
  { id: 'chat', label: 'Misa', hint: 'Doubts & maths', icon: MessageCircle, tone: 'blood' },
  { id: 'planners', label: 'Planners', hint: 'Subject uploads', icon: BookOpen, tone: 'blue' },
  { id: 'ai', label: 'Settings', hint: 'App & AI', icon: Settings, tone: 'neutral' },
  { id: 'updates', label: 'Updates', hint: 'Install new version', icon: Download, tone: 'amber' },
];

const sidebarSpring = { type: 'tween', duration: 0.32, ease: [0.2, 0, 0, 1] } as const;
const SWIPE_EDGE_PX = 32;
const SWIPE_DISTANCE_PX = 64;

interface TabBarProps {
  active: Tab;
  state: AppState;
  onChange: (t: Tab) => void;
  update: (fn: (s: AppState) => AppState) => void;
}

export default function TabBar({ active, state, onChange, update }: TabBarProps) {
  const [open, setOpen] = useState(false);
  const [handleVisible, setHandleVisible] = useState(true);
  const [settingsPanel, setSettingsPanel] = useState<'profile' | 'memory' | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const visibleTabs = useMemo(() => {
    const is90Day = state.enable90DayTrack !== false;
    return TABS.filter((t) => {
      if (!is90Day && (t.id === 'levels' || t.id === 'task-bank')) {
        return false;
      }
      return true;
    });
  }, [state.enable90DayTrack]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (settingsPanel) setSettingsPanel(null);
      else setOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsPanel]);

  // Auto-hide the floating hamburger while scrolling down, reveal it when the
  // user scrolls back up or returns to the top. Works for both the document
  // scroller and inner scroll containers (e.g. the chat thread).
  //
  // Each scroll target keeps its OWN last position: nested scrollers (the
  // chat's horizontal attachment strip fires scroll events with scrollTop 0)
  // must never reset another scroller's baseline, or a scroll-up on the main
  // thread computes a wrong delta and the handle stays hidden forever.
  //
  // Misa (chat) tab pe auto-hide band hai: wahan hamburger ke liye reserved
  // strip hamesha rehti hai, isliye scroll ke saath handle chhupana broken
  // lagta hai — chat pe kabhi hide nahi hota.
  useEffect(() => {
    const positions = new Map<EventTarget, number>();

    function scrollTopOf(target: EventTarget | null): number {
      if (!target || target === document) {
        return window.scrollY || document.documentElement.scrollTop || 0;
      }
      return (target as HTMLElement).scrollTop ?? 0;
    }

    /** Horizontal-only strips/textareas scroll too — they must not move the handle. */
    function canScrollY(target: EventTarget | null): boolean {
      if (!target || target === document) return true;
      const el = target as HTMLElement;
      return el.scrollHeight > el.clientHeight + 1;
    }

    function onScroll(event: Event) {
      if (active === 'chat') return;
      const target = event.target;
      if (!canScrollY(target)) return;
      const key: EventTarget = target ?? document;
      const scrollTop = scrollTopOf(target);
      const prev = positions.get(key) ?? scrollTop;
      positions.set(key, scrollTop);
      const delta = scrollTop - prev;
      setHandleVisible((visible) => {
        if (scrollTop <= 2) return true;
        if (delta > 4) return false;
        if (delta < -4) return true;
        return visible;
      });
    }

    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [active]);

  // Chat tab pe switch karte hi handle ko wapas dikhao (kisi aur tab pe
  // scroll karne se hidden reh gaya ho to).
  useEffect(() => {
    if (active === 'chat') setHandleVisible(true);
  }, [active]);

  useEffect(() => {
    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      touchStart.current = { x: touch.clientX, y: touch.clientY };
    }

    function onTouchEnd(event: TouchEvent) {
      const start = touchStart.current;
      const touch = event.changedTouches[0];
      touchStart.current = null;
      if (!start || !touch) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = Math.abs(touch.clientY - start.y);
      const startedAtEdge = start.x <= SWIPE_EDGE_PX;
      const isIntentionalRightSwipe = deltaX >= SWIPE_DISTANCE_PX && deltaY < 72;
      if (!open && startedAtEdge && isIntentionalRightSwipe) setOpen(true);
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [open]);

  function selectTab(next: Tab) {
    onChange(next);
    setOpen(false);
    setHandleVisible(true);
  }

  const profile = state.userProfile;
  // Memoized memory grouping so re-renders (typing, sidebar state) don't
  // re-sort/re-clone the whole memory list on every frame.
  const { longTermMemory, blockGroups, memoryItems } = useMemo(() => {
    const allMemory = [...state.memory.summaries, ...state.memory.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Long-term membership is decided on the FULL set — slicing for display
    // must not drop pinned entries into the archive/loose groups below.
    const longTermAll = allMemory.filter((e) => e.longTerm === true);
    const longTermMemory = longTermAll.slice(0, 12);
    const longTermIds = new Set(longTermAll.map((e) => e.id));
    // Group the rest into blocks (one per chat transcript) plus loose entries.
    const blocks = new Map<string, MemoryEntry[]>();
    const loose: MemoryEntry[] = [];
    for (const entry of allMemory) {
      if (longTermIds.has(entry.id)) continue;
      if (entry.blockId) {
        const list = blocks.get(entry.blockId) ?? [];
        list.push(entry);
        blocks.set(entry.blockId, list);
      } else {
        loose.push(entry);
      }
    }
    const blockGroups = [...blocks.values()]
      .map((entries) => ({ entries: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), updatedAt: entries[0]?.createdAt ?? '' }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12);
    const memoryItems = loose.slice(0, 12);
    return { longTermMemory, blockGroups, memoryItems };
  }, [state.memory.entries, state.memory.summaries]);

  function updateProfile(field: keyof UserProfile, value: string) {
    update((s) => ({
      ...s,
      userProfile: {
        ...s.userProfile,
        [field]: value,
      },
    }));
  }

  function startEditMemory(entry: MemoryEntry) {
    haptic();
    setEditingMemoryId(entry.id);
    setEditDraft(entry.content);
  }

  function cancelEditMemory() {
    setEditingMemoryId(null);
    setEditDraft('');
  }

  function saveEditMemory(id: string) {
    const content = editDraft.trim();
    if (!content) return;
    haptic();
    update((s) => container.memory.update(s, id, { content }));
    setEditingMemoryId(null);
    setEditDraft('');
  }

  function deleteMemory(id: string) {
    if (!confirm('Is memory entry ko delete karna hai?')) return;
    haptic();
    update((s) => container.memory.remove(s, id));
    if (editingMemoryId === id) setEditingMemoryId(null);
  }

  function toggleLongTerm(entry: MemoryEntry) {
    haptic();
    update((s) => container.memory.setLongTerm(s, [entry.id], !entry.longTerm));
  }

  function exportMemoryBackup() {
    haptic();
    const json = container.memory.exportMemory(state);
    void exportTextFile(json, `levelup-memory-backup-${new Date().toISOString().slice(0, 10)}.json`).then((result) => {
      if (!result.ok) alert(result.message);
    });
  }

  function importMemoryBackup(file: File | null) {
    if (!file) return;
    haptic();
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = String(reader.result ?? '');
        update((s) => container.memory.importMemory(s, json));
        setSettingsPanel('memory');
      } catch {
        alert('Import fail — file ek valid JSON memory backup nahi hai.');
      }
    };
    reader.onerror = () => alert('File padhna fail ho gaya.');
    reader.readAsText(file);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="nav-handle"
        aria-label="Open navigation menu"
        aria-expanded={open}
        data-visible={handleVisible}
      >
        <Menu size={18} strokeWidth={2.2} />
      </button>

      <div className="swipe-edge" aria-hidden="true" />

      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              className="nav-scrim"
              aria-label="Close navigation menu"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.nav
              className="side-nav"
              aria-label="Primary"
              initial={{ x: '-105%' }}
              animate={{ x: 0 }}
              exit={{ x: '-105%' }}
              transition={sidebarSpring}
            >
              <div className="side-nav-head">
                <div>
                  <p className="eyebrow">LevelUp</p>
                  <h2 className="font-display text-xl font-bold">Navigation</h2>
                </div>
                <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close navigation menu">
                  <X size={18} />
                </button>
              </div>

              <div className="side-nav-list">
                {visibleTabs.map(({ id, label, hint, icon: Icon, tone }) => {
                  const isActive = active === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => selectTab(id)}
                      aria-current={isActive ? 'page' : undefined}
                      data-tone={tone}
                      className="side-nav-item"
                    >
                      <span className="side-nav-icon" data-active={isActive}>
                        <Icon size={19} strokeWidth={isActive ? 2.6 : 2} />
                      </span>
                      <span className="min-w-0 text-left">
                        <span className="flex items-center gap-1.5">
                          <span className="block truncate font-display text-[15px] font-bold">{label}</span>
                          {id === 'chat' && (
                            <Sparkles size={12} className="shrink-0 text-peak" aria-label="Misa features in development" />
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted">{hint}</span>
                      </span>
                      {isActive && <motion.span layoutId="side-nav-dot" className="side-nav-dot" />}
                    </button>
                  );
                })}
              </div>

              <div className="side-nav-foot">
                <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Settings</p>
                <button type="button" className="side-nav-settings-row" onClick={() => setSettingsPanel('profile')}>
                  <span className="side-nav-icon compact"><User size={15} /></span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold text-text">Profile</span>
                    <span className="block truncate text-xs text-muted">AI personalization context</span>
                  </span>
                  <ChevronRight size={16} />
                </button>
                <button type="button" className="side-nav-settings-row" onClick={() => setSettingsPanel('memory')}>
                  <span className="side-nav-icon compact"><Brain size={15} /></span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold text-text">Memory</span>
                    <span className="block truncate text-xs text-muted">{state.memory.entries.length + state.memory.summaries.length} saved items</span>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </div>
            </motion.nav>
          </>
        )}
      </AnimatePresence>

        {settingsPanel && (
          <SettingsModal title={settingsPanel === 'profile' ? 'User profile' : 'AI memory'} onClose={() => setSettingsPanel(null)}>
            {settingsPanel === 'profile' ? (
              <div className="space-y-4">
                <div className="settings-modal-hero">
                  <span className="settings-modal-avatar"><User size={20} /></span>
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-text">{profile.name || 'User profile'}</p>
                    <p className="text-sm text-muted">AI personalization context</p>
                  </div>
                </div>
                <div className="grid gap-3">
                  <ProfileField label="Name" value={profile.name} onChange={(value) => updateProfile('name', value)} placeholder="Your name" />
                  <ProfileField label="Class / level" value={profile.classLevel} onChange={(value) => updateProfile('classLevel', value)} placeholder="Class 11, dropper..." />
                  <ProfileField label="Exam target" value={profile.examTarget} onChange={(value) => updateProfile('examTarget', value)} placeholder="JEE Main, Advanced..." />
                  <ProfileField label="Study style" value={profile.studyStyle} onChange={(value) => updateProfile('studyStyle', value)} placeholder="Short drills, deep work..." />
                  <label className="block">
                    <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Notes</span>
                    <textarea
                      value={profile.notes}
                      onChange={(e) => updateProfile('notes', e.target.value)}
                      className="field min-h-28 resize-none text-sm"
                      placeholder="Anything Misa should remember while studying."
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-panel-raised p-3">
                  <p className="text-sm font-semibold text-text">Saved coaching memory</p>
                  <span className="font-mono text-[10px] text-muted">{state.memory.entries.length + state.memory.summaries.length} items</span>
                </div>
                <p className="mb-2 text-[11px] leading-relaxed text-muted">
                  Old chats archive here as read-only transcripts. One click summarizes all unread
                  chats — edit, delete or pin blocks.
                </p>
                <div className="mb-3">
                  <MemorySummaryPanel />
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <button type="button" className="btn btn-ghost justify-center text-[11px]" onClick={exportMemoryBackup}>
                    <Download size={12} /> Backup export
                  </button>
                  <button type="button" className="btn btn-ghost justify-center text-[11px]" onClick={() => importInputRef.current?.click()}>
                    <Upload size={12} /> Backup import
                  </button>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      importMemoryBackup(e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                  />
                </div>
                <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
                  {longTermMemory.length > 0 && (
                    <>
                      <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Long-term memory</p>
                      {longTermMemory.map((entry) => (
                        <MemoryCard
                          key={entry.id}
                          entry={entry}
                          editing={editingMemoryId === entry.id}
                          draft={editDraft}
                          onEdit={() => startEditMemory(entry)}
                          onDraft={setEditDraft}
                          onSave={() => saveEditMemory(entry.id)}
                          onCancel={cancelEditMemory}
                          onDelete={() => deleteMemory(entry.id)}
                          onTogglePin={() => toggleLongTerm(entry)}
                        />
                      ))}
                    </>
                  )}
                  {blockGroups.length > 0 && (
                    <>
                      <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Chat archives</p>
                      {blockGroups.map((group) => (
                        <div key={group.entries[0].id} className="rounded-lg border border-border bg-panel-raised p-3">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                              Chat block · {new Date(group.updatedAt).toLocaleDateString()}
                            </span>
                            <span className="font-mono text-[10px] text-muted">{group.entries.length} pt</span>
                          </div>
                          {group.entries.map((entry) => (
                            <MemoryCard
                              key={entry.id}
                              entry={entry}
                              compact
                              editing={editingMemoryId === entry.id}
                              draft={editDraft}
                              onEdit={() => startEditMemory(entry)}
                              onDraft={setEditDraft}
                              onSave={() => saveEditMemory(entry.id)}
                              onCancel={cancelEditMemory}
                              onDelete={() => deleteMemory(entry.id)}
                              onTogglePin={() => toggleLongTerm(entry)}
                            />
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                  {memoryItems.length > 0 && (
                    <>
                      <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Other entries</p>
                      {memoryItems.map((entry) => (
                        <MemoryCard
                          key={entry.id}
                          entry={entry}
                          editing={editingMemoryId === entry.id}
                          draft={editDraft}
                          onEdit={() => startEditMemory(entry)}
                          onDraft={setEditDraft}
                          onSave={() => saveEditMemory(entry.id)}
                          onCancel={cancelEditMemory}
                          onDelete={() => deleteMemory(entry.id)}
                          onTogglePin={() => toggleLongTerm(entry)}
                        />
                      ))}
                    </>
                  )}
                  {longTermMemory.length === 0 && blockGroups.length === 0 && memoryItems.length === 0 && (
                    <p className="rounded-lg border border-border bg-panel-raised p-4 text-sm leading-relaxed text-muted">No memory entries yet. New chats ka raw transcript automatically memory me save hota hai — ya upar wale button se abhi karo.</p>
                  )}
                </div>
              </div>
            )}
          </SettingsModal>
        )}
    </>
  );
}

function ProfileField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="field min-h-9 py-1.5 text-xs" placeholder={placeholder} />
    </label>
  );
}

function MemoryCard({
  entry,
  editing,
  draft,
  compact,
  onEdit,
  onDraft,
  onSave,
  onCancel,
  onDelete,
  onTogglePin,
}: {
  entry: MemoryEntry;
  editing: boolean;
  draft: string;
  compact?: boolean;
  onEdit: () => void;
  onDraft: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  return (
    <article className={compact ? 'py-1' : 'mb-2 rounded-lg border border-border bg-panel-raised p-3'}>
      <div className="flex items-center justify-between gap-2">
        <span className={compact ? 'truncate font-mono text-[9px] uppercase tracking-wide text-muted' : 'badge'}>
          {compact ? entry.type : `${entry.type}${entry.longTerm ? ' · long-term' : ''}`}
        </span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-muted">{new Date(entry.createdAt).toLocaleDateString()}</span>
          <button type="button" className="memory-action" onClick={onTogglePin} aria-label={entry.longTerm ? 'Unpin from long-term' : 'Pin to long-term'}>
            {entry.longTerm ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          <button type="button" className="memory-action" onClick={onEdit} aria-label="Edit memory">
            <PenLine size={12} />
          </button>
          <button type="button" className="memory-action text-danger" onClick={onDelete} aria-label="Delete memory">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            className="field min-h-20 resize-none text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost min-h-7 px-2.5 text-[11px]" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn min-h-7 px-2.5 text-[11px]" onClick={onSave}>
              <Check size={12} /> Save
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-muted">{entry.content}</p>
      )}
    </article>
  );
}


function SettingsModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="settings-modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="settings-modal-scrim" aria-label="Close settings popup" onClick={onClose} />
      <motion.section
        className="settings-modal"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.98 }}
        transition={{ type: 'tween', duration: 0.18, ease: [0.2, 0, 0, 1] }}
      >
        <header className="settings-modal-head">
          <div>
            <p className="eyebrow">Settings</p>
            <h2 className="font-display text-xl font-bold text-text">{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings popup"><X size={18} /></button>
        </header>
        <div className="settings-modal-body">{children}</div>
      </motion.section>
    </div>
  );
}
