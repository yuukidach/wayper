import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Globe,
  ListFilter,
  Loader2,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type {
  ConfigPatchPayload,
  ConfigPayload,
  LanguagePreference,
  ResizeMode,
} from "../../shared/types";
import type { ResolvedLocale } from "../../shared/i18n";
import { normalizeLanguagePreference } from "../../shared/i18n";
import {
  comboIdentityKey,
  dedupeCombos,
  dedupeStringsCaseInsensitive,
  dedupeTagsNormalized,
  parseComboInput,
} from "../../shared/exclusion";
import { casefold, normalizeTag } from "../../shared/tags";
import { motionTransition } from "../lib/motion";

export type SettingsTab = "general" | "wallhaven" | "filters";

interface SettingsViewProps {
  t: (key: string) => string;
  locale: ResolvedLocale;
  config: ConfigPayload;
  initialTab?: SettingsTab;
  onPreviewLanguage: (pref: LanguagePreference) => void;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onNotify: (text: string, tone?: "info" | "success" | "error") => void;
}

const field =
  "h-8 rounded-lg bg-white/[0.06] px-2.5 text-[13px] text-ink outline-none transition-shadow placeholder:text-ink-3 hover:bg-white/[0.08] focus:bg-white/[0.08] focus:shadow-[0_0_0_2px_rgb(255_255_255/0.3)]";
const numberField = `${field} w-24 text-right tabular-nums`;
const secondaryButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white/[0.07] px-3 text-[13px] font-medium text-ink transition-colors hover:bg-white/[0.12] disabled:opacity-50";
const segmented = "flex items-center gap-0.5 rounded-lg bg-white/[0.05] p-0.5";
const segment = (active: boolean) =>
  `h-7 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
    active ? "bg-white/[0.13] text-ink shadow-[0_1px_2px_rgb(0_0_0/0.4)]" : "text-ink-3 hover:text-ink-2"
  }`;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h2 className="m-0 mb-1 text-[15px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
    <div className="divide-y divide-line">{children}</div>
  </section>
);

const Row: React.FC<{
  label: string;
  hint?: React.ReactNode;
  stacked?: boolean;
  children: React.ReactNode;
}> = ({ label, hint, stacked, children }) => (
  <div
    className={
      stacked
        ? "flex flex-col gap-2 py-3.5"
        : "flex min-h-[54px] items-center justify-between gap-6 py-2.5"
    }
  >
    <div className="min-w-0">
      <div className="text-[13.5px] text-ink">{label}</div>
      {hint && <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{hint}</div>}
    </div>
    <div className={stacked ? "" : "flex shrink-0 items-center"}>{children}</div>
  </div>
);

const Toggle: React.FC<{
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}> = ({ checked, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 ${
      checked ? "bg-accent" : "bg-white/[0.14]"
    }`}
  >
    <span
      className={`inline-block h-[18px] w-[18px] rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.35)] transition-transform duration-200 ${
        checked ? "translate-x-[18px] bg-on-accent" : "translate-x-[2px] bg-ink-2"
      }`}
    />
  </button>
);

const Select: React.FC<{
  value: string;
  options: Array<[string, string]>;
  disabled?: boolean;
  onChange: (value: string) => void;
}> = ({ value, options, disabled, onChange }) => (
  <div className="relative">
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${field} appearance-none pr-8 disabled:opacity-40`}
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
    <ChevronDown
      className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
      strokeWidth={1.75}
    />
  </div>
);

const RuleList: React.FC<{
  title: string;
  placeholder: string;
  addLabel: string;
  draft: string;
  error?: string | null;
  items: Array<{ key: string; label: string; onRemove: () => void }>;
  onDraft: (value: string) => void;
  onAdd: () => void;
}> = ({ title, placeholder, addLabel, draft, error, items, onDraft, onAdd }) => (
  <section>
    <div className="mb-2 flex items-baseline gap-2 px-1">
      <h2 className="text-[12.5px] font-medium text-ink-3">{title}</h2>
      <span className="text-[12px] tabular-nums text-ink-3">{items.length}</span>
    </div>
    <div className="rounded-xl bg-white/[0.03] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          className={`${field} min-w-0 flex-1`}
        />
        <button type="button" onClick={onAdd} className={secondaryButton}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{addLabel}</span>
        </button>
      </div>
      {error && <p className="mt-2 mb-0 px-0.5 text-[12px] text-drop">{error}</p>}
      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item.key}
              className="group inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.07] pr-1 pl-2.5 text-[12.5px] text-ink"
            >
              <span>{item.label}</span>
              <button
                type="button"
                onClick={item.onRemove}
                aria-label={`Remove ${item.label}`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-drop/20 hover:text-drop"
              >
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  </section>
);

export const SettingsView: React.FC<SettingsViewProps> = ({
  t,
  locale,
  config,
  initialTab = "general",
  onPreviewLanguage,
  onCancel,
  onSaved,
  onNotify,
}) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [saving, setSaving] = useState(false);

  const [intervalMin, setIntervalMin] = useState<number>(config.interval_min ?? 5);
  const [resizeMode, setResizeMode] = useState<ResizeMode>(config.transition?.resize ?? "crop");
  const [language, setLanguage] = useState<LanguagePreference>(
    normalizeLanguagePreference(config.language),
  );
  const [quotaMb, setQuotaMb] = useState<number>(config.quota_mb ?? 4000);
  const [batchSize, setBatchSize] = useState<number>(config.wallhaven?.batch_size ?? 5);
  const [downloadDir, setDownloadDir] = useState<string>(config.download_dir ?? "");
  const [proxy, setProxy] = useState<string>(config.proxy ?? "");
  const [autostart, setAutostart] = useState<boolean>(Boolean(config.autostart));
  const [pauseOnLock, setPauseOnLock] = useState<boolean>(Boolean(config.pause_on_lock));
  const [safeMode, setSafeMode] = useState<boolean>(Boolean(config.safe_mode));
  const [neverExpire, setNeverExpire] = useState<boolean>((config.blacklist_ttl_days ?? 30) === 0);
  const [blacklistTtl, setBlacklistTtl] = useState<number>(
    config.blacklist_ttl_days && config.blacklist_ttl_days > 0 ? config.blacklist_ttl_days : 30,
  );

  const [apiKey, setApiKey] = useState<string>("");
  const [whUsername, setWhUsername] = useState<string>(config.wallhaven_username ?? "");
  const [whPassword, setWhPassword] = useState<string>("");
  const [categories, setCategories] = useState<string>(() => {
    const raw = (config.wallhaven?.categories ?? "111").padEnd(3, "1").slice(0, 3);
    return /^[01]{3}$/.test(raw) ? raw : "111";
  });
  const [topRange, setTopRange] = useState<string>(config.wallhaven?.top_range ?? "1M");
  const [sorting, setSorting] = useState<string>(config.wallhaven?.sorting ?? "toplist");
  const [aiArtFilter, setAiArtFilter] = useState<number>(config.wallhaven?.ai_art_filter ?? 1);

  const [loginBusy, setLoginBusy] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  const [excludeTags, setExcludeTags] = useState<string[]>(() =>
    dedupeTagsNormalized(config.wallhaven?.exclude_tags ?? []),
  );
  const [excludeCombos, setExcludeCombos] = useState<string[][]>(() =>
    dedupeCombos(config.wallhaven?.exclude_combos ?? []),
  );
  const [excludeUploaders, setExcludeUploaders] = useState<string[]>(() =>
    dedupeStringsCaseInsensitive(config.wallhaven?.exclude_uploaders ?? []),
  );

  const [tagDraft, setTagDraft] = useState("");
  const [comboDraft, setComboDraft] = useState("");
  const [comboError, setComboError] = useState<string | null>(null);
  const [uploaderDraft, setUploaderDraft] = useState("");

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const handleLanguageChange = (nextRaw: string) => {
    const normalized = normalizeLanguagePreference(nextRaw);
    setLanguage(normalized);
    onPreviewLanguage(normalized);
  };

  const toggleCategoryBit = (bitIndex: 0 | 1 | 2) => {
    const chars = categories.split("");
    const nextVal = chars[bitIndex] === "1" ? "0" : "1";
    chars[bitIndex] = nextVal;
    const joined = chars.join("");
    if (joined === "000") return;
    setCategories(joined);
  };

  const handleBrowseFolder = async () => {
    try {
      const chosen = await window.wayper.selectDownloadDir();
      if (chosen) setDownloadDir(chosen);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Could not select directory", "error");
    }
  };

  const handleBrowserLogin = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    setSessionStatus(null);
    try {
      const res = await window.wayper.openWallhavenLogin();
      if (res.ok) {
        if (res.username) setWhUsername(res.username);
        setSessionStatus({
          text: res.username
            ? `${t("Session connected")} (@${res.username})`
            : t("Session connected"),
          ok: true,
        });
      } else if (res.error) {
        setSessionStatus({ text: res.error, ok: false });
      }
    } catch (err) {
      setSessionStatus({
        text: err instanceof Error ? err.message : "Sign-in failed",
        ok: false,
      });
    } finally {
      setLoginBusy(false);
    }
  };

  const handleReconnectSession = async () => {
    if (reconnectBusy) return;
    setReconnectBusy(true);
    setSessionStatus(null);
    try {
      await window.wayper.reconnectWallhaven();
      setSessionStatus({ text: t("Session connected"), ok: true });
    } catch (err) {
      setSessionStatus({
        text: err instanceof Error ? err.message : "Reconnect failed",
        ok: false,
      });
    } finally {
      setReconnectBusy(false);
    }
  };

  const addExcludeTag = () => {
    const norm = normalizeTag(tagDraft);
    if (!norm) return;
    setExcludeTags((prev) => dedupeTagsNormalized([...prev, norm]));
    setTagDraft("");
  };

  const addExcludeCombo = () => {
    const parsed = parseComboInput(comboDraft);
    if (parsed.error) {
      setComboError(parsed.error);
      return;
    }
    setComboError(null);
    setExcludeCombos((prev) => dedupeCombos([...prev, parsed.tags], { dropSupersets: true }));
    setComboDraft("");
  };

  const addExcludeUploader = () => {
    const cleaned = uploaderDraft.trim().replace(/^@/, "");
    if (!cleaned) return;
    setExcludeUploaders((prev) => dedupeStringsCaseInsensitive([...prev, cleaned]));
    setUploaderDraft("");
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const clampedInterval = Math.max(0, Number.isFinite(intervalMin) ? Math.round(intervalMin) : 0);
      const clampedQuota = Math.max(100, Number.isFinite(quotaMb) ? Math.round(quotaMb) : 4000);
      const clampedBatch = Math.max(1, Number.isFinite(batchSize) ? Math.round(batchSize) : 5);
      const ttlValue = neverExpire
        ? 0
        : Math.max(1, Number.isFinite(blacklistTtl) ? Math.round(blacklistTtl) : 30);

      const patch: ConfigPatchPayload = {
        interval_min: clampedInterval,
        interval: clampedInterval * 60,
        quota_mb: clampedQuota,
        download_dir: downloadDir.trim(),
        proxy: proxy.trim(),
        autostart,
        pause_on_lock: pauseOnLock,
        safe_mode: safeMode,
        language,
        wallhaven_username: whUsername.trim(),
        blacklist_ttl_days: ttlValue,
        wallhaven: {
          categories,
          top_range: topRange,
          sorting,
          ai_art_filter: aiArtFilter,
          filter_strategy: config.wallhaven.filter_strategy,
          filter_mode: config.wallhaven.filter_strategy,
          batch_size: clampedBatch,
          exclude_tags: excludeTags,
          exclude_combos: excludeCombos,
          exclude_uploaders: excludeUploaders,
        },
      };

      if (config.transition?.resize_available) {
        patch.transition = { resize: resizeMode };
      }
      if (apiKey.trim()) {
        patch.api_key = apiKey.trim();
      }
      if (whPassword) {
        patch.wallhaven_password = whPassword;
      }

      await window.wayper.patchConfig(patch);
      await onSaved();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const catLabels = [
    locale === "zh" ? t("GeneralCat") : "General",
    locale === "zh" ? t("AnimeCat") : "Anime",
    locale === "zh" ? t("PeopleCat") : "People",
  ];

  return (
    <div className="flex h-full w-full">
      <aside className="flex w-[204px] shrink-0 flex-col bg-black/20 p-3">
        <h1 className="m-0 px-2.5 pt-2 pb-4 text-[15px] font-semibold tracking-[-0.015em] text-ink">
          {t("Settings")}
        </h1>
        <div role="tablist" aria-label={t("Settings")} className="flex flex-col gap-0.5">
          {(
            [
              ["general", t("General"), SlidersHorizontal],
              ["wallhaven", "Wallhaven", Globe],
              ["filters", t("Filters"), ListFilter],
            ] as Array<[SettingsTab, string, typeof Globe]>
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors ${
                tab === value ? "font-medium text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {tab === value && (
                <motion.span
                  layoutId="settings-tab-pill"
                  className="absolute inset-0 rounded-lg bg-white/[0.09]"
                  transition={motionTransition.select}
                />
              )}
              <Icon className="relative h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="relative truncate">{label}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionTransition.normal}
          className="space-y-9 px-8 pt-7 pb-8"
        >
          {tab === "general" && (
            <>
              <Section title={t("Rotation")}>
                <Row
                  label={t("Rotation Interval (minutes)")}
                  hint={t("Set 0 to disable automatic rotation.")}
                >
                  <input
                    type="number"
                    min={0}
                    value={intervalMin}
                    onChange={(e) => setIntervalMin(Number(e.target.value))}
                    className={numberField}
                  />
                </Row>
                <Row
                  label={t("Wallpaper Display Mode")}
                  hint={
                    config.transition?.resize_available
                      ? t("Applies the next time a wallpaper is set.")
                      : t("Available on Linux (awww) only")
                  }
                >
                  <Select
                    value={resizeMode}
                    disabled={!config.transition?.resize_available}
                    onChange={(value) => setResizeMode(value as ResizeMode)}
                    options={[
                      ["crop", t("Crop to fill")],
                      ["fit", t("Fit entire image")],
                      ["stretch", t("Stretch to fill")],
                      ["no", t("Original size")],
                    ]}
                  />
                </Row>
                <Row label={t("Pause on Screen Lock")}>
                  <Toggle checked={pauseOnLock} onChange={setPauseOnLock} label={t("Pause on Screen Lock")} />
                </Row>
              </Section>

              <Section title={t("Library")}>
                <Row label={t("Download Folder")} stacked>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={downloadDir}
                      onChange={(e) => setDownloadDir(e.target.value)}
                      placeholder="~/Pictures/wallpaper"
                      className={`${field} min-w-0 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseFolder()}
                      className={secondaryButton}
                    >
                      <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span>{t("Browse")}</span>
                    </button>
                  </div>
                </Row>
                <Row label={t("Disk Quota (MB)")}>
                  <input
                    type="number"
                    min={100}
                    value={quotaMb}
                    onChange={(e) => setQuotaMb(Number(e.target.value))}
                    className={numberField}
                  />
                </Row>
                <Row label={t("Download Batch Size")}>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value))}
                    className={numberField}
                  />
                </Row>
                <Row label={t("Blacklist Expiry (days)")}>
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
                      <span>{t("Never expire")}</span>
                      <Toggle checked={neverExpire} onChange={setNeverExpire} label={t("Never expire")} />
                    </label>
                    <input
                      type="number"
                      min={1}
                      disabled={neverExpire}
                      value={blacklistTtl}
                      onChange={(e) => setBlacklistTtl(Number(e.target.value))}
                      className={`${numberField} disabled:opacity-40`}
                    />
                  </div>
                </Row>
              </Section>

              <Section title={t("Application")}>
                <Row label={t("Language")}>
                  <Select
                    value={language}
                    onChange={handleLanguageChange}
                    options={[
                      ["auto", t("Auto (System)")],
                      ["en", "English"],
                      ["zh", "简体中文"],
                    ]}
                  />
                </Row>
                <Row label={t("Start at Login")}>
                  <Toggle checked={autostart} onChange={setAutostart} label={t("Start at Login")} />
                </Row>
                <Row label={t("Safe Mode (Lock to SFW)")}>
                  <Toggle checked={safeMode} onChange={setSafeMode} label={t("Safe Mode (Lock to SFW)")} />
                </Row>
                <Row label={t("HTTP / SOCKS Proxy")}>
                  <input
                    type="text"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder="http://127.0.0.1:7897"
                    className={`${field} w-60`}
                  />
                </Row>
              </Section>
            </>
          )}

          {tab === "wallhaven" && (
            <>
              <Section title={t("Account")}>
                <Row
                  label={t("API Key")}
                  hint={
                    <button
                      type="button"
                      onClick={() =>
                        void window.wayper.openExternal("https://wallhaven.cc/settings/account")
                      }
                      className="inline-flex items-center gap-1 text-ink-3 underline decoration-white/20 underline-offset-2 transition-colors hover:text-ink"
                    >
                      <span>{t("Get API key on Wallhaven")}</span>
                      <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                    </button>
                  }
                >
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={config.has_api_key ? "••••••••••••••••" : "Wallhaven API key"}
                    className={`${field} w-60`}
                  />
                </Row>
                <Row label={t("Username")}>
                  <input
                    type="text"
                    value={whUsername}
                    onChange={(e) => setWhUsername(e.target.value)}
                    placeholder="username"
                    className={`${field} w-60`}
                  />
                </Row>
                <Row label={t("Password (optional)")}>
                  <input
                    type="password"
                    value={whPassword}
                    onChange={(e) => setWhPassword(e.target.value)}
                    placeholder={config.has_wh_password ? "••••••••••••" : ""}
                    className={`${field} w-60`}
                  />
                </Row>
                <Row label={t("Web Session")} stacked>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={loginBusy}
                      onClick={() => void handleBrowserLogin()}
                      className={secondaryButton}
                    >
                      {loginBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      <span>{t("Sign in with Browser Window")}</span>
                    </button>
                    <button
                      type="button"
                      disabled={reconnectBusy}
                      onClick={() => void handleReconnectSession()}
                      className={secondaryButton}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${reconnectBusy ? "animate-spin" : ""}`}
                        strokeWidth={1.75}
                      />
                      <span>{t("Reconnect Session")}</span>
                    </button>
                    {sessionStatus && (
                      <span
                        role="status"
                        className={`inline-flex items-center gap-1.5 text-[12.5px] ${
                          sessionStatus.ok ? "text-keep" : "text-drop"
                        }`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {sessionStatus.text}
                      </span>
                    )}
                  </div>
                </Row>
              </Section>

              <Section title={t("Source")}>
                <Row label={t("Categories")}>
                  <div className={segmented}>
                    {([0, 1, 2] as const).map((idx) => {
                      const active = categories[idx] === "1";
                      return (
                        <button
                          key={idx}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleCategoryBit(idx)}
                          className={segment(active)}
                        >
                          {catLabels[idx]}
                        </button>
                      );
                    })}
                  </div>
                </Row>
                <Row label={t("Sorting")}>
                  <Select
                    value={sorting}
                    onChange={setSorting}
                    options={[
                      ["toplist", t("Toplist")],
                      ["hot", t("Hot")],
                      ["random", t("Random")],
                      ["views", t("Views")],
                      ["favorites", t("Favorites")],
                    ]}
                  />
                </Row>
                <Row label={t("Top Range")}>
                  <div className={segmented}>
                    {["1d", "3d", "1w", "1M", "3M", "6M", "1y"].map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={topRange === value}
                        onClick={() => setTopRange(value)}
                        className={`${segment(topRange === value)} tabular-nums`}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label={t("AI Art")}>
                  <div className={segmented}>
                    {[
                      { val: 1, label: t("Block AI Art") },
                      { val: 0, label: t("Allow AI Art") },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        aria-pressed={aiArtFilter === opt.val}
                        onClick={() => setAiArtFilter(opt.val)}
                        className={segment(aiArtFilter === opt.val)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </Row>
              </Section>
            </>
          )}

          {tab === "filters" && (
            <>
              <RuleList
                title={t("Excluded Tags")}
                placeholder={t("Add tag...")}
                addLabel={t("Add")}
                draft={tagDraft}
                onDraft={setTagDraft}
                onAdd={addExcludeTag}
                items={excludeTags.map((tag) => ({
                  key: tag,
                  label: tag,
                  onRemove: () =>
                    setExcludeTags((prev) =>
                      prev.filter((x) => normalizeTag(x) !== normalizeTag(tag)),
                    ),
                }))}
              />
              <RuleList
                title={t("Excluded Tag Combos")}
                placeholder={t("tag1 + tag2")}
                addLabel={t("Add")}
                draft={comboDraft}
                onDraft={(value) => {
                  setComboDraft(value);
                  if (comboError) setComboError(null);
                }}
                onAdd={addExcludeCombo}
                error={comboError}
                items={excludeCombos.map((combo) => {
                  const key = comboIdentityKey(combo);
                  return {
                    key,
                    label: combo.join(" + "),
                    onRemove: () =>
                      setExcludeCombos((prev) => prev.filter((c) => comboIdentityKey(c) !== key)),
                  };
                })}
              />
              <RuleList
                title={t("Excluded Uploaders")}
                placeholder={t("Add uploader...")}
                addLabel={t("Add")}
                draft={uploaderDraft}
                onDraft={setUploaderDraft}
                onAdd={addExcludeUploader}
                items={excludeUploaders.map((uploader) => ({
                  key: uploader,
                  label: `@${uploader}`,
                  onRemove: () =>
                    setExcludeUploaders((prev) =>
                      prev.filter((u) => casefold(u) !== casefold(uploader)),
                    ),
                }))}
              />
            </>
          )}
        </motion.div>
      </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 px-8 py-4 shadow-[inset_0_1px_0_var(--color-line)]">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-white/[0.07] hover:text-ink"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hi disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>{saving ? t("Saving...") : t("Save Changes")}</span>
          </button>
        </footer>
      </div>
    </div>
  );
};
