/**
 * Tool-declaration gating for GeminiLiveClient.
 *
 * Guards the live-call tool set against three INDEPENDENT gates:
 *   - webSearch      → linked to the existing `aiSettings.websearch.enabled` setting
 *                      (SAME source of truth as chat), NOT the proactive toggle.
 *   - core tools     → always available on a call regardless of toggles.
 *   - proactive tools → only when the proactive agent is enabled.
 *
 * Also pins that `makeCall` is never declared to Misa on a live call (the
 * student must place calls themselves).
 *
 * Mocking strategy mirrors live-audio-handoff.test.ts: mock @google/genai/web
 * and @capacitor/core so the REAL connect() branch that assembles
 * `config.tools` runs and we can capture the emitted function declarations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiLiveClient } from '../live-client';
import { container } from '../../../di/container';
import { proactiveAgentService } from '../../../features/ai/proactive-agent.service';
import type { LiveSettingsConfig } from '../live-types';

const native = vi.hoisted(() => ({
  isNative: vi.fn(),
  plugin: {
    setRoute: vi.fn(),
    resetRoute: vi.fn(),
    requestAudioFocus: vi.fn(),
    addListener: vi.fn(),
  },
}));

const genai = vi.hoisted(() => ({
  connect: vi.fn(),
  session: {
    sendRealtimeInput: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('@google/genai/web', () => ({
  GoogleGenAI: vi.fn(() => ({
    live: { connect: (...args: unknown[]) => genai.connect(...args) },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.isNative() },
  registerPlugin: () => native.plugin,
}));

const mockConfig: LiveSettingsConfig = {
  model: 'gemini-2.5-flash-native-audio-preview-09-2025',
  voice: 'Aoede',
  vadSensitivity: 'medium',
  videoFps: 1,
  screenFps: 1,
  defaultAudioRoute: 'speaker',
  playbackSpeed: 1.0,
  enable90DayTrack: true,
};

/** Reads the function declarations sent to the Gemini Live session. */
function capturedToolNames(connectArgs: unknown[]): string[] {
  const first = connectArgs[0] as { config?: { tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> } };
  const tools = first?.config?.tools;
  if (!tools || tools.length === 0) return [];
  const decls = tools[0]?.functionDeclarations ?? [];
  return decls.map((d) => d.name);
}

function setWebSearch(enabled: boolean): void {
  const state = container.store.get();
  container.store.save({
    ...state,
    aiSettings: {
      ...state.aiSettings,
      websearch: { ...state.aiSettings.websearch, enabled },
    },
  });
}

describe('Live tool-declaration gating', () => {
  beforeEach(() => {
    native.isNative.mockReset().mockReturnValue(true);
    native.plugin.setRoute.mockReset().mockResolvedValue({ route: 'speaker', deviceType: 'BUILTIN_SPEAKER' });
    native.plugin.resetRoute.mockReset().mockResolvedValue(undefined);
    native.plugin.requestAudioFocus.mockReset().mockResolvedValue({ granted: true, status: 'granted' });
    native.plugin.addListener.mockReset().mockResolvedValue({ remove: vi.fn() });
    genai.connect.mockReset().mockResolvedValue(genai.session);
    genai.session.sendRealtimeInput.mockClear();
    genai.session.close.mockClear();
  });

  afterEach(() => {
    // Leave a clean default so unrelated suites aren't affected.
    proactiveAgentService.updatePreferences({ enabled: false });
    setWebSearch(false);
  });

  async function connectAndCapture(proactive: boolean, webSearch: boolean): Promise<string[]> {
    proactiveAgentService.updatePreferences({ enabled: proactive });
    setWebSearch(webSearch);
    const client = new GeminiLiveClient(mockConfig);
    await client.connect('test-key', undefined, { audioFocusAlreadyGranted: true });
    const names = capturedToolNames(genai.connect.mock.calls[genai.connect.mock.calls.length - 1]);
    client.disconnect(false);
    return names;
  }

  async function connectAndCaptureConfig(configOverride: Partial<LiveSettingsConfig>): Promise<Record<string, any>> {
    const client = new GeminiLiveClient({ ...mockConfig, ...configOverride });
    await client.connect('test-key', undefined, { audioFocusAlreadyGranted: true });
    const first = genai.connect.mock.calls[genai.connect.mock.calls.length - 1][0] as { config?: Record<string, any> };
    client.disconnect(false);
    return first?.config ?? {};
  }

  it('core tools are always present (proactive + webSearch both off)', async () => {
    const names = await connectAndCapture(false, false);
    for (const core of ['getContext', 'getPlan', 'getAllTasks', 'readMemory', 'endLiveCall', 'getTime']) {
      expect(names).toContain(core);
    }
    expect(names).not.toContain('webSearch');
    expect(names).not.toContain('scheduleMessage');
    expect(names).not.toContain('scheduleCall');
  });

  it('webSearch appears ONLY when aiSettings.websearch.enabled is true', async () => {
    const off = await connectAndCapture(false, false);
    expect(off).not.toContain('webSearch');

    const on = await connectAndCapture(false, true);
    expect(on).toContain('webSearch');
    // Core still present, proactive still absent.
    expect(on).toContain('getContext');
    expect(on).not.toContain('scheduleMessage');
  });

  it('proactive scheduling tools appear ONLY when the proactive agent is enabled', async () => {
    const off = await connectAndCapture(false, false);
    expect(off).not.toContain('scheduleMessage');
    expect(off).not.toContain('scheduleCall');
    expect(off).not.toContain('listScheduled');
    expect(off).not.toContain('cancelScheduled');

    const on = await connectAndCapture(true, false);
    for (const t of ['scheduleMessage', 'scheduleCall', 'listScheduled', 'cancelScheduled']) {
      expect(on).toContain(t);
    }
    // webSearch stays off; core stays present.
    expect(on).not.toContain('webSearch');
    expect(on).toContain('getContext');
  });

  it('webSearch and proactive tools compose independently (both on)', async () => {
    const names = await connectAndCapture(true, true);
    expect(names).toContain('webSearch');
    expect(names).toContain('scheduleMessage');
    expect(names).toContain('getContext');
  });

  it('makeCall is never declared on a live call', async () => {
    const names = await connectAndCapture(true, true);
    expect(names).not.toContain('makeCall');
  });

  it('thinking OFF sends budget 0 and NO includeThoughts (no reasoning leaks)', async () => {
    const cfg = await connectAndCaptureConfig({ thinkingBudget: 0 });
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(cfg.thinkingConfig.includeThoughts).toBeUndefined();
  });

  it('thinking ON sends includeThoughts:true so reasoning comes back FLAGGED (box, not message)', async () => {
    const cfg = await connectAndCaptureConfig({ thinkingBudget: 8192 });
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 8192, includeThoughts: true });
  });
});
