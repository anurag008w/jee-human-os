import type { ProviderConfig, ProviderId, HealthCheckResult } from '../../core/domain/llm';
import type { StateStore } from '../../core/ports/repositories';
import type { ProviderFactory } from '../../infra/ai/provider-factory';
import { buildHiddenDefaultConfig } from '../../infra/ai/provider-factory';
import { providerLabel } from '../../infra/ai/provider-factory';

/**
 * SmartRotator (LevelUp gateway) model GROUP ids. The gateway exposes group
 * ids ("levelup", "levelup-lite", ...) — NOT raw upstream model names. Sending
 * a name the gateway doesn't list (e.g. the old hardcoded "gemini-2.5-flash")
 * makes every chat request fail with 429/503, while Live (which uses its own
 * model chain) keeps working. These defaults are verified against the
 * gateway's /v1/models catalog.
 */
export const DEFAULT_GATEWAY_MODEL = 'levelup';
export const DEFAULT_GATEWAY_MODELS: string[] = ['levelup', 'levelup-lite'];

/**
 * Manages provider configs (persisted in state) plus the hidden env default.
 * Secret values are only ever written to storage, never exposed through the
 * returned public views used by the UI.
 */
export class ProviderSettingsService {
  private hiddenDefault: ProviderConfig | null;
  private readonly state: StateStore;
  private readonly factory: ProviderFactory;

  constructor(state: StateStore, factory: ProviderFactory) {
    this.state = state;
    this.factory = factory;
    this.hiddenDefault = buildHiddenDefaultConfig();
  }

  /** Public configs (hidden default's secret fields are stripped). */
  listProviders(): ProviderConfig[] {
    const all = this.allRaw();
    return all.map((p) => (p.hidden ? this.publicView(p) : p));
  }

  /** All stored providers (enabled or not) + hidden default, for pickers. */
  listStoredProviders(): ProviderConfig[] {
    const stored = Object.values(this.state.get().aiSettings.providers);
    const list = [...stored];
    if (this.hiddenDefault) list.unshift(this.hiddenDefault);
    return list.map((p) => (p.hidden ? this.publicView(p) : p));
  }

  /** Full raw configs for internal use (never handed to the UI). */
  allRaw(): ProviderConfig[] {
    const stored = Object.values(this.state.get().aiSettings.providers).filter((p) => p.enabled);
    const list = [...stored];
    if (this.hiddenDefault) list.unshift(this.hiddenDefault);
    return list;
  }

  getActiveProvider(): ProviderConfig | null {
    const all = this.allRaw();
    const activeId = this.state.get().aiSettings.activeProviderId;
    return all.find((p) => p.id === activeId && this.isUsable(p)) ?? all.find((p) => this.isUsable(p)) ?? null;
  }

  getProviderById(id: string): ProviderConfig | null {
    return this.allRaw().find((p) => p.id === id) ?? null;
  }

  /** A provider is usable when it is enabled, configured and not hidden-only-but-disabled. */
  isUsable(config: ProviderConfig): boolean {
    return config.enabled && this.factory.create(config).isConfigured();
  }

  isHiddenEnabled(): boolean {
    return this.hiddenDefault !== null;
  }

  /**
   * Raw hidden default config (WITH secrets) — the settings UI renders it as a
   * full provider card (API key, base URL, model, /models catalog, test) just
   * like any other provider. Only the settings screen calls this; pickers and
   * chat flows keep using the stripped public views.
   */
  getHiddenDefaultFull(): ProviderConfig | null {
    return this.hiddenDefault;
  }

  /**
   * Applies UI edits to the hidden default (model/baseUrl/apiKey changes made
   * from the provider card). The update is transient — env vars stay the
   * source of truth and re-apply on restart/login.
   */
  updateHiddenDefault(config: ProviderConfig): void {
    if (!this.hiddenDefault) return;
    this.hiddenDefault = { ...this.hiddenDefault, ...config, hidden: true };
  }

  isAiEnabled(): boolean {
    return this.state.get().aiSettings.aiEnabled && this.getActiveProvider() !== null;
  }

  setAiEnabled(enabled: boolean): void {
    const state = this.state.get();
    state.aiSettings.aiEnabled = enabled;
    this.state.save(state);
  }

  upsertProvider(config: ProviderConfig): void {
    const state = this.state.get();
    state.aiSettings.providers[config.id] = config;
    if (this.isUsable(config)) state.aiSettings.activeProviderId ??= config.id;
    this.state.save(state);
  }

  setActiveProvider(id: ProviderId): void {
    const state = this.state.get();
    state.aiSettings.activeProviderId = id;
    this.state.save(state);
  }

  /**
   * Points the hidden env default at the logged-in gateway server and swaps in
   * the user's own sk- key (baseUrl = server root + /v1). Called right after a
   * successful login so the app's default provider routes through the user's
   * account (per-user quota is enforced server-side). The provider stays
   * hidden in the UI — no card, no URL, no key — exactly like the env default.
   * Also drops any legacy visible "My Server" provider persisted by older
   * builds, so the Providers section stays clean.
   */
  configureServerAuth(baseUrl: string, apiKey: string): void {
    if (!baseUrl || !apiKey) return;
    if (this.hiddenDefault && this.hiddenDefault.baseUrl === baseUrl && this.hiddenDefault.apiKey === apiKey) {
      return; // Already configured with same credentials — prevent flicker / re-creation
    }
    const existing = this.hiddenDefault;
    // Model is env-driven (VITE_DEFAULT_AI_MODEL), exactly like the base URL —
    // the build packs whatever value is set (default: 'levelup' group id).
    const envModel = (import.meta.env as Record<string, string | undefined>).VITE_DEFAULT_AI_MODEL?.trim();
    this.hiddenDefault = {
      id: existing?.id ?? 'custom',
      label: existing?.label ?? 'Default',
      baseUrl,
      apiKey,
      // Never invent a raw upstream model name here: the gateway only routes
      // its own group ids. Env wins, then the verified gateway default group.
      model: existing?.model ?? envModel ?? DEFAULT_GATEWAY_MODEL,
      // Picker must never offer a phantom model — when the build ships no
      // catalog, expose the verified gateway groups instead of nothing.
      models: existing?.models ?? DEFAULT_GATEWAY_MODELS,
      temperature: existing?.temperature ?? 0.7,
      maxTokens: existing?.maxTokens ?? 4096,
      timeoutMs: existing?.timeoutMs ?? 120_000,
      retries: existing?.retries ?? 3,
      streaming: existing?.streaming ?? true,
      enabled: true,
      hidden: true,
    };
    const state = this.state.get();
    // Legacy cleanup: pre-login builds persisted a visible rotator provider.
    delete state.aiSettings.providers.rotator;
    state.aiSettings.aiEnabled = true;
    state.aiSettings.activeProviderId = this.hiddenDefault.id;
    this.state.save(state);
  }

  removeProvider(id: ProviderId): void {
    const state = this.state.get();
    delete state.aiSettings.providers[id];
    if (state.aiSettings.activeProviderId === id) state.aiSettings.activeProviderId = null;
    this.state.save(state);
  }

  /**
   * Guest (skipped-login) mode: drop the hidden server default so no gateway
   * traffic happens — the app works fully offline, data stays in localStorage.
   * On the next login configureServerAuth() re-creates the hidden default.
   */
  disableServerAuth(): void {
    this.hiddenDefault = null;
    const state = this.state.get();
    if (state.aiSettings.activeProviderId === null || state.aiSettings.activeProviderId === 'custom') {
      state.aiSettings.activeProviderId = null;
    }
    this.state.save(state);
  }

  /** Live connectivity + latency probe for a config (used by the settings UI). */
  healthCheck(config: ProviderConfig): Promise<HealthCheckResult> {
    return this.factory.create(config).healthCheck();
  }

  /** View of a hidden provider that leaks no secret or model name. */
  private publicView(config: ProviderConfig): ProviderConfig {
    return {
      id: config.id,
      // Keep the provider's own label (e.g. "Default") so every screen shows
      // the same name — don't fall back to the generic provider type label.
      label: config.label || providerLabel(config.id),
      enabled: config.enabled,
      hidden: true,
      // Model ids are not secrets — they only power the optional model picker.
      models: config.models,
      model: config.model,
    };
  }
}
