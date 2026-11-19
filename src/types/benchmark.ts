export type ThemeId = 'light' | 'dark' | 'sepia-light' | 'sepia-dark' | 'greenish-sepia';

export type WorkspaceView = 'cards' | 'waterfall' | 'compare' | 'graph' | 'chat';

export interface ChatTurnMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type ProviderKind =
  | 'gemini-builtin'
  | 'openai'
  | 'ollama'
  | 'vllm'
  | 'lmstudio'
  | 'groq'
  | 'litellm'
  | 'custom';

export interface ProviderEndpoint {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  customHeaders: Record<string, string>;
  directBrowser: boolean;
  models: string[];
}

export interface TargetModel {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  modelName: string;
  enabled: boolean;
  systemPromptOverride?: string;
}

export type SystemPromptTargetMode = 'all' | 'specific';

export interface SystemPromptConfig {
  enabled: boolean;
  content: string;
  personaId: string | null;
  targetMode: SystemPromptTargetMode;
  targetModelIds: string[];
}

export type EndpointType =
  | 'chat-completions'
  | 'audio-transcriptions'
  | 'audio-translations'
  | 'audio-speech'
  | 'embeddings'
  | 'responses'
  | 'custom';

export type EndpointPayloadMode = 'auto' | 'json' | 'multipart';

export interface EndpointFileAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  endpointScope: EndpointType | 'all';
  fieldName: string;
  base64Data: string;
  textPreview?: string;
  enabled: boolean;
  addedAt: number;
}

export interface CustomSendParam {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface SendParamActivation {
  customHeaders?: boolean;
  customEndpoint?: boolean;
  stream?: boolean;
  temperature?: boolean;
  topP?: boolean;
  maxTokens?: boolean;
  seed?: boolean;
  ttsVoice?: boolean;
  endpointFiles?: boolean;
}

export interface ExecutionConfig {
  mode: 'parallel' | 'sequential';
  concurrency: number;
  timeoutSec: number;
  stream: boolean;
  temperature: number;
  maxTokens: number;
  topP: number;
  seed?: number;
  randomizeOrder?: boolean;
  endpointType?: EndpointType;
  customEndpoint?: string;
  customPayloadMode?: EndpointPayloadMode;
  ttsVoice?: string;
  activeParams?: SendParamActivation;
  extraParams?: CustomSendParam[];
}

export type RunStatus = 'idle' | 'queued' | 'connecting' | 'streaming' | 'completed' | 'error' | 'aborted';

export interface TimingBreakdown {
  enqueuedAt: number;
  startedAt: number;
  headersAt: number | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  queueMs: number;
  requestMs: number;
  ttfbMs: number | null;
  downloadMs: number;
  totalMs: number;
}

export interface ModelRunResult {
  targetId: string;
  modelName: string;
  providerName: string;
  providerKind: ProviderKind;
  status: RunStatus;
  output: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSec: number;
  timing: TimingBreakdown;
  error?: string;
  advice?: string;
  httpStatus?: number;
  systemPromptApplied?: string;
  audioDataUrl?: string;
  endpointUrl?: string;
}

export interface BenchmarkRunRecord {
  id: string;
  title: string;
  createdAt: number;
  prompt: string;
  suiteName?: string;
  systemPrompt: SystemPromptConfig;
  executionConfig: ExecutionConfig;
  results: ModelRunResult[];
  syncedToCloud?: boolean;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  tableName: string;
  autoSync: boolean;
}

export interface SyncLogEntry {
  id: string;
  timestamp: number;
  action: 'test' | 'push' | 'pull';
  status: 'success' | 'error';
  httpStatus?: number;
  message: string;
}
