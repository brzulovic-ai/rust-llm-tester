import type {
  EndpointFileAttachment,
  EndpointPayloadMode,
  EndpointType,
} from '../types/benchmark';

export interface EndpointPresetInfo {
  id: EndpointType;
  label: string;
  pathLabel: string;
  suffix: string;
  description: string;
  supportsFiles: boolean;
  requiresFile: boolean;
  acceptHint: string;
}

export const ENDPOINT_PRESETS: EndpointPresetInfo[] = [
  {
    id: 'chat-completions',
    label: 'Chat Completions',
    pathLabel: '/v1/chat/completions',
    suffix: '/chat/completions',
    description: 'Standard OpenAI-compatible SSE/JSON chat completions',
    supportsFiles: true,
    requiresFile: false,
    acceptHint: '.txt,.md,.json,.csv,.ts,.py,.png,.jpg,.jpeg,.webp',
  },
  {
    id: 'audio-transcriptions',
    label: 'Audio Transcription (/v1/audio)',
    pathLabel: '/v1/audio/transcriptions',
    suffix: '/audio/transcriptions',
    description: 'Speech-to-text multipart upload (Whisper / Groq / LiteLLM)',
    supportsFiles: true,
    requiresFile: true,
    acceptHint: 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4',
  },
  {
    id: 'audio-translations',
    label: 'Audio Translation (/v1/audio)',
    pathLabel: '/v1/audio/translations',
    suffix: '/audio/translations',
    description: 'Translate uploaded audio to English via multipart upload',
    supportsFiles: true,
    requiresFile: true,
    acceptHint: 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4',
  },
  {
    id: 'audio-speech',
    label: 'Audio Speech TTS (/v1/audio)',
    pathLabel: '/v1/audio/speech',
    suffix: '/audio/speech',
    description: 'Text-to-speech synthesis returning playable audio',
    supportsFiles: false,
    requiresFile: false,
    acceptHint: '',
  },
  {
    id: 'embeddings',
    label: 'Embeddings',
    pathLabel: '/v1/embeddings',
    suffix: '/embeddings',
    description: 'Generate vector embeddings and inspect dimensions + latency',
    supportsFiles: true,
    requiresFile: false,
    acceptHint: '.txt,.md,.json,.csv',
  },
  {
    id: 'responses',
    label: 'Responses API',
    pathLabel: '/v1/responses',
    suffix: '/responses',
    description: 'OpenAI /v1/responses input endpoint',
    supportsFiles: true,
    requiresFile: false,
    acceptHint: '.txt,.md,.json,.csv,.png,.jpg',
  },
  {
    id: 'custom',
    label: 'Custom Endpoint',
    pathLabel: 'Custom path or URL',
    suffix: '',
    description: 'Arbitrary relative path (e.g. /v1/rerank) or full URL with JSON/Multipart',
    supportsFiles: true,
    requiresFile: false,
    acceptHint: '*/*',
  },
];

export function getEndpointPreset(type: EndpointType = 'chat-completions'): EndpointPresetInfo {
  return ENDPOINT_PRESETS.find((e) => e.id === type) ?? ENDPOINT_PRESETS[0];
}

export function resolveEndpointUrl(
  baseUrl: string,
  endpointType: EndpointType = 'chat-completions',
  customEndpoint?: string
): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  if (endpointType === 'custom') {
    const raw = (customEndpoint ?? '').trim();
    if (!raw) {
      return `${cleanBase}/chat/completions`;
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw;
    }
    const rel = raw.startsWith('/') ? raw : `/${raw}`;
    if (cleanBase.endsWith('/v1') && (rel === '/v1' || rel.startsWith('/v1/'))) {
      return `${cleanBase}${rel.slice(3)}`;
    }
    return `${cleanBase}${rel}`;
  }

  const preset = getEndpointPreset(endpointType);
  return `${cleanBase}${preset.suffix}`;
}

export function filesForEndpoint(
  files: EndpointFileAttachment[],
  endpointType: EndpointType = 'chat-completions'
): EndpointFileAttachment[] {
  return files.filter(
    (f) => f.enabled && (f.endpointScope === endpointType || f.endpointScope === 'all')
  );
}

export function shouldUseMultipartUpload(
  endpointType: EndpointType = 'chat-completions',
  customPayloadMode: EndpointPayloadMode = 'auto',
  matchedFiles: EndpointFileAttachment[] = []
): boolean {
  if (endpointType === 'audio-transcriptions' || endpointType === 'audio-translations') {
    return true;
  }
  if (endpointType === 'custom') {
    if (customPayloadMode === 'multipart') return true;
    if (customPayloadMode === 'json') return false;
    return matchedFiles.length > 0;
  }
  return false;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function isTextLikeMimeOrName(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
    return true;
  }
  return /\.(txt|md|json|jsonl|csv|tsv|yaml|yml|toml|ini|log|ts|tsx|js|jsx|rs|py|sh|sql)$/i.test(
    name
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function readFileAsAttachment(
  file: File,
  endpointScope: EndpointType | 'all',
  fieldName = 'file'
): Promise<EndpointFileAttachment> {
  const buf = await file.arrayBuffer();
  const base64Data = arrayBufferToBase64(buf);
  const mimeType = file.type || 'application/octet-stream';
  let textPreview: string | undefined;
  if (isTextLikeMimeOrName(mimeType, file.name) && file.size <= 512 * 1024) {
    try {
      textPreview = new TextDecoder().decode(buf).slice(0, 16000);
    } catch {
      textPreview = undefined;
    }
  }
  return {
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    mimeType,
    sizeBytes: file.size,
    endpointScope,
    fieldName: fieldName.trim() || 'file',
    base64Data,
    textPreview,
    enabled: true,
    addedAt: Date.now(),
  };
}
