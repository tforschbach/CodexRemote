import { Buffer } from "node:buffer";

import type { AppConfig } from "../config.js";

export interface DictationTranscriptionInput {
  audioBuffer: Buffer;
  filename: string;
  mimeType: string;
  language?: string;
}

export interface DictationTranscriptionResult {
  text: string;
  model: string;
}

export interface DictationTranscriptionService {
  transcribe(input: DictationTranscriptionInput): Promise<DictationTranscriptionResult>;
}

interface OpenAIErrorShape {
  error?: {
    message?: string;
  };
  text?: string;
}

export class TranscriptionServiceError extends Error {
  public readonly statusCode: number;

  public constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TranscriptionServiceError";
    this.statusCode = statusCode;
  }
}

export class OpenAITranscriptionService implements DictationTranscriptionService {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(
    config: Pick<AppConfig, "openaiApiKey" | "openaiBaseUrl" | "openaiTranscriptionModel">,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.apiKey = config.openaiApiKey;
    this.baseUrl = config.openaiBaseUrl;
    this.model = config.openaiTranscriptionModel;
    this.fetchImpl = fetchImpl;
  }

  public async transcribe(input: DictationTranscriptionInput): Promise<DictationTranscriptionResult> {
    if (!this.apiKey) {
      throw new TranscriptionServiceError(
        "OpenAI transcription is not configured. Add OPENAI_API_KEY to your .env or .env.local file.",
        503,
      );
    }

    const formData = new FormData();
    formData.set("file", new File([input.audioBuffer], input.filename, { type: input.mimeType }));
    formData.set("model", this.model);
    formData.set("response_format", "json");

    if (input.language) {
      formData.set("language", input.language);
    }

    const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetchImpl(new URL("audio/transcriptions", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    const payload = await response.json().catch(() => undefined) as OpenAIErrorShape | undefined;
    if (!response.ok) {
      const message = payload?.error?.message
        ?? `OpenAI transcription failed with status ${response.status}.`;
      throw new TranscriptionServiceError(message, 502);
    }

    const text = payload?.text?.trim();
    if (!text) {
      throw new TranscriptionServiceError("OpenAI transcription returned no text.", 502);
    }

    return {
      text,
      model: this.model,
    };
  }
}
