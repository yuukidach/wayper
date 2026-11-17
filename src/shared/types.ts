export type Purity = "sfw" | "sketchy" | "nsfw";
export type Orientation = "landscape" | "portrait";
export type LanguagePreference = "auto" | "en" | "zh";
export type FilterStrategy = "rules" | "model" | "rules+model";
export type ResizeMode = "crop" | "fit" | "stretch" | "no";
export type GalleryMode = "pool" | "favorites" | "trash" | "model-review";

export interface MonitorConfig {
  name: string;
  width: number;
  height: number;
  orientation: Orientation;
}

export interface MonitorInfo {
  name: string;
  width?: number;
  height?: number;
  orientation: Orientation;
  current_image: string | null;
}

export interface WallhavenSettingsPayload {
  categories: string;
  top_range: string;
  sorting: string;
  ai_art_filter: number;
  filter_strategy: FilterStrategy;
  filter_mode: FilterStrategy;
  batch_size: number;
  exclude_tags: string[];
  exclude_combos: string[][];
  exclude_uploaders: string[];
}

export interface ConfigPayload {
  download_dir: string;
  interval_min: number;
  mode: Purity[];
  quota_mb: number;
  proxy: string;
  pause_on_lock: boolean;
  safe_mode: boolean;
  autostart: boolean;
  language: LanguagePreference;
  transition: {
    resize: ResizeMode;
    resize_available: boolean;
  };
  greeter: {
    available: boolean;
    fixed_image: string | null;
  };
  has_api_key: boolean;
  has_wh_password: boolean;
  wallhaven_username: string;
  blacklist_ttl_days: number;
  wallhaven: WallhavenSettingsPayload;
}

export interface ConfigPatchPayload {
  download_dir?: string;
  interval_min?: number;
  interval?: number;
  quota_mb?: number;
  proxy?: string | null;
  pause_on_lock?: boolean;
  safe_mode?: boolean;
  autostart?: boolean;
  language?: string;
  locale?: string;
  api_key?: string;
  wallhaven_username?: string;
  wallhaven_password?: string;
  blacklist_ttl_days?: number;
  transition?: {
    resize?: string;
  };
  wallhaven?: Partial<WallhavenSettingsPayload>;
}

export interface TagDetail {
  id?: number;
  name: string;
  alias?: string;
  category_id?: number;
  category?: string;
  purity?: string;
  created_at?: string;
}

export interface ImageMetadata {
  id?: string;
  tags?: string[];
  tag_details?: TagDetail[];
  tag_details_complete?: boolean;
  uploader?: string | { username?: string; [key: string]: unknown };
  uploader_details?: Record<string, unknown>;
  category?: string;
  purity?: string;
  dimension_x?: number;
  dimension_y?: number;
  resolution?: string;
  ratio?: string;
  views?: number;
  favorites?: number;
  url?: string;
  short_url?: string;
  source?: string;
  colors?: string[];
  file_size?: number;
  file_type?: string;
  created_at?: string;
  path?: string;
  thumbs?: Record<string, string>;
  downloaded_at?: number;
  metadata_complete?: boolean;
  metadata_fetched_at?: number;
  metadata_unavailable?: boolean;
  metadata_error?: string;
  metadata_checked_at?: number;
  metadata_schema_version?: number;
  [key: string]: unknown;
}

export interface ImageItem {
  path: string;
  name: string;
  is_favorite: boolean;
  orientation: Orientation | null;
}

export interface ImagePage {
  items: ImageItem[];
  total: number;
  next_offset: number | null;
}

export interface StatusResponse {
  auto_rotation: boolean;
  rotation_paused: boolean;
  monitor: string | null;
  orientation: Orientation | null;
  pool_count: number;
  favorites_count: number;
  blocklist_count: number;
  recoverable_count: number;
  mode: Purity[];
  model_review_count: number;
  model_filter_ready: boolean;
}

export interface DiskUsageResponse {
  used_mb: number;
  quota_mb: number;
}

export interface BlocklistEntry {
  filename: string;
  timestamp: number;
  recoverable: boolean;
}

export interface BlocklistResponse {
  entries: BlocklistEntry[];
  total: number;
  recoverable_count: number;
  images: ImageItem[];
}

export interface TagSuggestionItem {
  tag: string;
  count: number;
  banned: number;
  kept: number;
  favorites: number;
  net_benefit?: number;
  ratio?: number;
}

export interface ComboSuggestionItem {
  tags: string[];
  count: number;
  banned: number;
  kept: number;
  favorites: number;
  precision: number;
}

export interface UploaderSuggestionItem {
  uploader: string;
  ban_count: number;
  kept_count: number;
  fav_count: number;
  net_benefit: number;
  precision: number;
}

export interface RuleMatchStats {
  banned: number;
  kept: number;
  favorites: number;
  precision: number;
  net_benefit: number;
}

export interface FeatureContribution {
  type: string;
  feature: string;
  weight: number;
  coefficient: number;
  direction: "dislike" | "keep";
}

export interface NeighborMatchDetail {
  filename: string;
  label?: string;
  similarity: number;
  tag_matches?: Array<{
    query: string;
    prototype: string;
    similarity: number;
  }>;
}

export interface ReviewCandidateItem {
  path: string;
  name: string;
  width?: number;
  height?: number;
  purity?: Purity;
  orientation?: Orientation;
  auto_filtered?: boolean;
  review_only?: boolean;
  status?: string;
  score: number;
  feature_score: number;
  decision_score: number;
  threshold?: number;
  neighbor_probability: number | null;
  neighbor_available: boolean;
  neighbor_count: number;
  neighbor_dislike_count: number;
  neighbor_keep_count: number;
  neighbor_similarity_sum?: number;
  neighbor_max_similarity: number;
  neighbor_nearest_dislike: NeighborMatchDetail | null;
  neighbor_nearest_keep: NeighborMatchDetail | null;
  neighbor_exact_max_similarity?: number;
  neighbor_semantic_max_similarity?: number;
  neighbor_preference_gap?: number;
  semantic_score: number | null;
  semantic_probability: number | null;
  semantic_available: boolean;
  probability: number;
  calibrated: boolean;
  rank?: number;
  percentile?: number;
  contributions: FeatureContribution[];
  dislike_evidence: FeatureContribution[];
  keep_evidence: FeatureContribution[];
  positive_evidence_count?: number;
}

export interface LearningStatus {
  status: string;
  pending_feedback: number;
  minimum_feedback: number;
  training_ready: boolean;
  due: boolean;
  approximate?: boolean;
  changed_examples?: number;
}

export interface PreferenceSuggestionsResponse {
  status: "untrained" | "upgrade_pending" | "learning" | "ready";
  items: ReviewCandidateItem[];
  learning: LearningStatus | null;
  model?: Record<string, unknown>;
  decision_threshold?: number;
  review_strategy: string;
  diagnostics?: Record<string, unknown>;
}

export interface ModelReviewListResponse {
  status: string;
  items: ReviewCandidateItem[];
  pending_count: number;
  filter_strategy: FilterStrategy;
  model_filter: Record<string, unknown>;
  learning: LearningStatus | null;
}

export interface UpdateCheckResponse {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string;
  release_name: string | null;
  published_at: string | null;
  checked_at: string;
  error: string | null;
}

export type WayperPushEvent =
  | { type: "mode"; purities: Purity[] }
  | { type: "library" }
  | { type: "wallpaper" }
  | { type: "monitors" }
  | { type: "config" }
  | { type: "rotation"; auto_rotation: boolean; rotation_paused: boolean }
  | { type: "model-updated" };

export interface SearchResponse {
  matches: string[];
  suggestions: string[];
  uploader_suggestions?: string[];
}

export interface WayperBridge {
  platform: NodeJS.Platform;
  copyToClipboard: (text: string) => void;
  openExternal: (url: string) => Promise<void>;
  selectDownloadDir: () => Promise<string | null>;
  openWallhavenLogin: () => Promise<{ ok: boolean; username?: string; error?: string }>;
  checkTrashAccess: (filename: string) => Promise<{ readable: boolean; forbidden: boolean }>;
  onEvent: (listener: (event: WayperPushEvent) => void) => () => void;

  // Typed RPC methods (direct in-process Electron IPC, zero HTTP port!)
  getConfig: () => Promise<ConfigPayload>;
  patchConfig: (updates: ConfigPatchPayload) => Promise<{ status: "ok" }>;
  setMode: (purities: Purity[]) => Promise<{ status: "ok"; purities: Purity[] }>;
  getStatus: (params?: { orient?: string; include_recoverable?: boolean; monitor?: string }) => Promise<StatusResponse>;
  getDiskUsage: () => Promise<DiskUsageResponse>;
  getMonitors: () => Promise<MonitorInfo[]>;
  setRotation: (action: "pause" | "resume") => Promise<{ status: "ok"; auto_rotation: boolean; rotation_paused: boolean }>;
  controlAction: (
    action: "next" | "prev" | "fav" | "unfav" | "ban" | "dislike" | "unban",
    options?: { monitor_name?: string | null; open_url?: boolean },
  ) => Promise<Record<string, unknown>>;
  getImagesPage: (params: {
    mode: "pool" | "favorites" | "trash";
    purity: string;
    orient: string;
    offset: number;
    limit: number;
  }) => Promise<ImagePage>;
  getImageMetadata: (filenameOrPath: string) => Promise<ImageMetadata | null>;
  setWallpaper: (monitor: string, imagePath: string) => Promise<{ status: "ok"; monitor: string; current_image: string }>;
  setGreeter: (imagePath: string) => Promise<{ status: "ok"; greeter: { available: boolean; fixed_image: string | null } }>;
  toggleFavorite: (imagePath: string) => Promise<{ status: "ok"; new_path: string; is_favorite: boolean }>;
  banImage: (imagePath: string, options?: { monitor?: string; preference_context?: string }) => Promise<Record<string, unknown>>;
  dislikeImage: (imagePath: string, options?: { monitor?: string }) => Promise<Record<string, unknown>>;
  restoreImage: (imagePath: string) => Promise<{ status: "ok"; new_path: string }>;
  getBlocklist: () => Promise<BlocklistResponse>;
  removeBlocklistEntry: (filename: string) => Promise<{ status: "ok"; removed: boolean }>;
  searchImages: (params: { query?: string; tags?: string[]; uploader?: string }) => Promise<SearchResponse>;
  getTagSuggestions: (contextTags?: string[]) => Promise<{
    suggestions: TagSuggestionItem[];
    combo_suggestions?: ComboSuggestionItem[];
    context?: string[];
  }>;
  getUploaderSuggestions: () => Promise<{ suggestions: UploaderSuggestionItem[] }>;
  getPreferenceSuggestions: (params: {
    purities?: Purity[];
    orient?: string;
    limit?: number;
  }) => Promise<PreferenceSuggestionsResponse>;
  sendPreferenceFeedback: (path: string, action: "keep") => Promise<Record<string, unknown>>;
  getModelReview: (params: {
    purities?: Purity[];
    orient?: string;
    limit?: number;
  }) => Promise<ModelReviewListResponse>;
  resolveModelReview: (path: string, action: "keep" | "ban") => Promise<Record<string, unknown>>;
  clearModelReview: (params: { purities?: Purity[]; orientation?: string | null }) => Promise<Record<string, unknown>>;
  retrainModelNow: () => Promise<Record<string, unknown>>;
  checkUpdate: (force?: boolean) => Promise<UpdateCheckResponse>;
  reconnectWallhaven: () => Promise<{ status: "ok" }>;
}
