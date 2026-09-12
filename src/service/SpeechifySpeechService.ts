import { requestUrl } from "obsidian";
import {
  speechifyFallbackVoices,
  type VoiceOption,
  type VoiceSettings,
} from "../settings/VoiceSettings";
import { BaseSpeechService } from "./BaseSpeechService";
import type { CredentialValidationResult } from "./SpeechProvider";
import { chunkPlainText } from "./textChunker";
import { mapSpeechifyVoices } from "./voiceCatalog";

/**
 * Speechify Text-to-Speech integration.
 *
 * - Receives plain spoken text from TextSpeaker. Speechify does accept SSML, but
 *   only its own subset and only when the whole input is SSML, so the plain-text
 *   pipeline is used and no pause markup is emitted (textPauseStyle "none").
 * - Chunks long notes well under the endpoint's 20k character limit and
 *   concatenates the resulting MP3 blobs.
 * - Uses Obsidian's requestUrl() — Speechify only sends CORS headers for http(s)
 *   origins, so a browser fetch from Obsidian (app:// and capacitor://) is blocked.
 * - Voice ids are model-specific (the `_32` voices belong to Simba 3.2), so the
 *   voice catalog is fetched per model and cached by the settings tab.
 * - Playback/controls/caching are inherited from BaseSpeechService.
 */

const SPEECHIFY_BASE_URL = "https://api.speechify.ai";
// The stream endpoint accepts 20k characters per request. Smaller chunks lower
// the time to first audio and keep each request well inside the limit.
const MAX_CHUNK_CHARS = 5000;

export class SpeechifySpeechService extends BaseSpeechService {
  readonly inputFormat = "text" as const;

  private apiKey: string;
  private model: string;
  private voiceCatalog: VoiceOption[];

  constructor(
    apiKey: string,
    voice: string,
    model: string,
    speed?: number,
    voiceCatalog?: VoiceOption[],
  ) {
    super(voice, speed);
    this.apiKey = apiKey;
    this.model = model || "simba-3.2";
    this.voiceCatalog = voiceCatalog ?? [];
  }

  getVoiceOptions(): VoiceOption[] {
    return this.voiceCatalog.length > 0
      ? this.voiceCatalog
      : speechifyFallbackVoices(this.model);
  }

  updateCredentials(settings: VoiceSettings): void {
    this.apiKey = settings.SPEECHIFY_API_KEY;
    this.model = settings.SPEECHIFY_MODEL || "simba-3.2";
    this.voiceCatalog = settings.speechifyVoiceCatalog ?? [];
  }

  /**
   * Synthesize and play plain text via Speechify.
   */
  async speak(
    content: string,
    speed?: number,
    filePath?: string,
  ): Promise<void> {
    if (this.isLoading) {
      throw new Error("Speechify call already in progress.");
    }

    if (!this.apiKey) {
      const error = new Error("Missing Speechify API key");
      this.reportError(error);
      throw error;
    }

    const text = content.trim();
    if (!text) {
      return;
    }

    this.isLoading = true;
    try {
      this.reportProgress(0, 1);

      const chunks = chunkPlainText(text, MAX_CHUNK_CHARS);
      const audioBlobs: Blob[] = [];

      for (let i = 0; i < chunks.length; i++) {
        if (this.abortController?.signal.aborted) {
          throw new Error("AbortError");
        }

        const blob = await this.synthesizeChunk(chunks[i]);

        if (this.abortController?.signal.aborted) {
          throw new Error("AbortError");
        }

        audioBlobs.push(blob);

        // Reserve the last slice of the bar for concatenation + buffering.
        this.reportProgress(((i + 1) / chunks.length) * 0.95, 1);
      }

      const finalBlob = new Blob(audioBlobs, { type: "audio/mpeg" });
      this.playBlob(finalBlob, speed, filePath);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.error("Error in Speechify speak:", error);
      this.reportError(error);
      throw error;
    } finally {
      this.isLoading = false;
      this.abortController = undefined;
    }
  }

  /**
   * Synthesize a single text chunk and return the MP3 blob.
   */
  private async synthesizeChunk(text: string): Promise<Blob> {
    const response = await requestUrl({
      url: `${SPEECHIFY_BASE_URL}/v1/audio/stream`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        input: text,
        voice_id: this.voice,
        model: this.model,
      }),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(this.httpErrorMessage(response.status, response.text));
    }

    const arrayBuffer = response.arrayBuffer;
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error("Speechify returned an empty audio response");
    }

    return new Blob([arrayBuffer], { type: "audio/mpeg" });
  }

  /**
   * Validate the API key by listing the voices available for the current model,
   * returning them so the settings tab can cache the catalog for the picker.
   */
  async validateCredentials(): Promise<CredentialValidationResult> {
    if (!this.apiKey) {
      return { isValid: false, error: "Please enter your Speechify API key." };
    }

    try {
      const response = await requestUrl({
        url: `${SPEECHIFY_BASE_URL}/v1/voices?limit=200&model=${encodeURIComponent(
          this.model,
        )}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        throw: false,
      });

      if (response.status === 200) {
        const voices = mapSpeechifyVoices(
          response.json?.voices ?? [],
          this.model,
        );
        return { isValid: true, voiceCount: voices.length, voices };
      }
      return {
        isValid: false,
        error: this.httpErrorMessage(response.status, response.text),
      };
    } catch (error) {
      console.error("Speechify credential validation error:", error);
      return {
        isValid: false,
        error: "Network error during validation. Please try again.",
      };
    }
  }

  /**
   * Turn an HTTP failure into a message worth showing. Speechify replies with
   * `{ error: { code, message } }`, which is far more useful than the status.
   */
  private httpErrorMessage(status: number, body?: string): string {
    if (status === 401 || status === 403) {
      return "Speechify: invalid or expired API key (401)";
    }
    if (status === 402) {
      return "Speechify: out of credits (402). Check your plan.";
    }
    if (status === 429) {
      return "Speechify: rate limit reached (429)";
    }

    const detail = parseSpeechifyError(body);
    return detail
      ? `Speechify API error (HTTP ${status}): ${detail}`
      : `Speechify API error (HTTP ${status})`;
  }

  protected getErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
      const message = String((error as { message: string }).message);

      if (message.includes("401")) {
        return "Invalid Speechify API key.";
      }
      if (message.includes("402")) {
        return "Speechify account is out of credits.";
      }
      if (message.includes("429")) {
        return "Speechify rate limit reached. Please wait and try again.";
      }
      if (message.includes("Missing Speechify API key")) {
        return "Add your Speechify API key in settings.";
      }
      if (message.includes("empty audio")) {
        return "Speechify returned no audio. Try a different voice or model.";
      }
      if (message.toLowerCase().includes("network")) {
        return "Connection failed. Check your internet.";
      }
      return `Speechify error: ${message}`;
    }
    return "Speechify error. Please try again.";
  }
}

/**
 * Pull the human-readable message out of a Speechify error body
 * (`{ error: { code, message }, request_id }`). Returns undefined when the body
 * is missing or isn't the documented shape.
 */
export function parseSpeechifyError(body?: string): string | undefined {
  if (!body) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed?.error?.message || undefined;
  } catch {
    return undefined;
  }
}
