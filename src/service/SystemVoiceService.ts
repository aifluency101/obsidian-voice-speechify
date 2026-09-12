import type { VoiceOption, VoiceSettings } from "../settings/VoiceSettings";
import { BaseSpeechService } from "./BaseSpeechService";
import type { CredentialValidationResult } from "./SpeechProvider";
import { chunkPlainText } from "./textChunker";

/**
 * On-device speech via the Web Speech API (`speechSynthesis`), which is backed
 * by the operating system's own engine — AVSpeechSynthesizer on iOS/macOS, SAPI
 * on Windows. No account, no API key, no network, no cost.
 *
 * This provider does not synthesize audio data, it only speaks, so there is
 * nothing to hand back for downloading: getLastGeneratedAudio() always returns
 * null and the save controls disable themselves accordingly.
 *
 * There is likewise no media element to seek, so the inherited <audio> element
 * is given a *synthetic* timeline: `duration`, `currentTime` and `ended` are
 * redefined to report an estimate derived from the text, and assigning
 * `currentTime` jumps to the chunk covering that moment. That is what lets the
 * player's scrubber both display progress and seek into the middle of a note.
 * Positions are therefore approximate, and seeking snaps to a chunk boundary.
 */

// Short enough that speed changes, stops and seeks land quickly, long enough
// that the engine still applies sentence prosody rather than reading word by word.
const MAX_CHUNK_CHARS = 400;

// Rough speaking rate used to estimate the timeline: ~16 characters a second at
// rate 1.0, which is around 150 words per minute.
const CHARS_PER_SECOND = 16;

export type SpeechSynthesisLike = Pick<
  SpeechSynthesis,
  "speak" | "cancel" | "pause" | "resume" | "getVoices" | "speaking" | "paused"
> & {
  addEventListener?: (type: "voiceschanged", listener: () => void) => void;
};

export type UtteranceFactory = (text: string) => SpeechSynthesisUtterance;

/** Offered when the engine has not published its voice list, so the picker is never blank. */
export const SYSTEM_DEFAULT_VOICE: VoiceOption = {
  id: "",
  label: "System default",
  lang: "en-US",
};

export class SystemVoiceService extends BaseSpeechService {
  readonly inputFormat = "text" as const;

  private synth?: SpeechSynthesisLike;
  private makeUtterance?: UtteranceFactory;
  private queue: string[] = [];
  private durations: number[] = [];
  private index = 0;
  private ended = true;
  /** bumped on every cancel/restart so stale utterance callbacks are ignored */
  private generation = 0;
  private chunkStartedAt?: number;
  private pausedSince?: number;
  private pausedTotalMs = 0;
  private voicesChangedCallback?: () => void;

  constructor(
    voice: string,
    speed?: number,
    synth: SpeechSynthesisLike | undefined = defaultSynth(),
    makeUtterance: UtteranceFactory | undefined = defaultUtteranceFactory(),
  ) {
    super(voice, speed);
    this.synth = synth;
    this.makeUtterance = makeUtterance;
    this.installSyntheticTimeline();
    // Engines publish their voice list asynchronously; on iOS getVoices() is
    // commonly empty until this fires, which would otherwise leave the player's
    // voice dropdown blank for the whole session.
    this.synth?.addEventListener?.("voiceschanged", () => {
      this.voicesChangedCallback?.();
    });
  }

  /** Lets the plugin refresh the voice picker once the engine publishes its list. */
  onVoicesChanged(callback: () => void): void {
    this.voicesChangedCallback = callback;
  }

  getVoiceOptions(): VoiceOption[] {
    const voices = this.synth?.getVoices() ?? [];
    if (voices.length === 0) {
      return [SYSTEM_DEFAULT_VOICE];
    }
    return voices.map((voice) => ({
      id: voice.voiceURI,
      label: voice.default ? `${voice.name} (default)` : voice.name,
      lang: voice.lang,
    }));
  }

  updateCredentials(settings: VoiceSettings): void {
    this.voice = settings.SYSTEM_VOICE;
  }

  async speak(
    content: string,
    speed?: number,
    _filePath?: string,
  ): Promise<void> {
    if (!this.synth || !this.makeUtterance) {
      const error = new Error("Speech synthesis is unavailable on this device");
      this.reportError(error);
      throw error;
    }

    const text = content.trim();
    if (!text) {
      return;
    }

    if (typeof speed === "number") {
      this.speed = speed;
    }

    this.queue = chunkPlainText(text, MAX_CHUNK_CHARS);
    this.estimateDurations();
    // Nothing is downloaded, so synthesis is "complete" the moment it starts.
    this.reportProgress(1, 1);
    this.speakFrom(0);
  }

  // --- Speaking ---

  /** Cancel whatever is speaking and start again from `index`. */
  private speakFrom(index: number): void {
    if (!this.synth || !this.makeUtterance) {
      return;
    }
    this.generation++;
    this.synth.cancel();

    if (index < 0 || index >= this.queue.length) {
      this.index = Math.max(0, this.queue.length - 1);
      this.ended = true;
      return;
    }

    this.index = index;
    this.ended = false;
    this.speakCurrent(this.generation);
  }

  private speakCurrent(generation: number): void {
    if (!this.synth || !this.makeUtterance || generation !== this.generation) {
      return;
    }

    const utterance = this.makeUtterance(this.queue[this.index]);
    const voice = this.synth
      .getVoices()
      .find((candidate) => candidate.voiceURI === this.voice);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = clampRate(this.speed);

    this.markChunkStarted();
    utterance.onstart = () => {
      if (generation === this.generation) {
        // Engines take a moment to begin; time from the real start.
        this.markChunkStarted();
      }
    };
    utterance.onend = () => {
      if (generation !== this.generation) {
        return;
      }
      if (this.index >= this.queue.length - 1) {
        this.ended = true;
        return;
      }
      this.index++;
      this.speakCurrent(generation);
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation) {
        return;
      }
      // cancel() surfaces as an "interrupted"/"canceled" error; that is us.
      const reason = event.error;
      if (reason === "interrupted" || reason === "canceled") {
        return;
      }
      this.ended = true;
      this.reportError(new Error(`Speech synthesis failed: ${reason}`));
    };

    this.synth.speak(utterance);
  }

  private markChunkStarted(): void {
    this.chunkStartedAt = Date.now();
    this.pausedTotalMs = 0;
    this.pausedSince = undefined;
  }

  // --- Playback controls, redirected from the <audio> element to the engine ---

  async playAudio(speed?: number): Promise<void> {
    if (!this.synth) {
      return;
    }
    if (typeof speed === "number") {
      this.speed = speed;
    }
    if (this.synth.paused && this.synth.speaking) {
      if (this.pausedSince !== undefined) {
        this.pausedTotalMs += Date.now() - this.pausedSince;
        this.pausedSince = undefined;
      }
      this.synth.resume();
      return;
    }
    if (!this.synth.speaking && this.queue.length > 0) {
      this.speakFrom(this.ended ? 0 : this.index);
    }
  }

  pauseAudio(): void {
    if (this.synth?.speaking && !this.synth.paused) {
      this.pausedSince = Date.now();
      this.synth.pause();
    }
  }

  stopAudio(): void {
    this.generation++;
    this.synth?.cancel();
    this.index = 0;
    this.ended = true;
    this.chunkStartedAt = undefined;
  }

  isPlaying(): boolean {
    return !!this.synth?.speaking && !this.synth.paused;
  }

  hasEnded(): boolean {
    return this.ended;
  }

  /**
   * Skipping moves by a chunk rather than by seconds: a seek can only land on a
   * chunk boundary, so a 3-second nudge would usually just restart the sentence
   * being spoken. Rewind restarts the current chunk unless we only just began
   * it, which is the behaviour a "back" button usually has.
   */
  rewindAudio(): void {
    if (this.queue.length === 0) {
      return;
    }
    const intoChunk = this.position() - this.startOfChunk(this.index);
    this.speakFrom(intoChunk > 2 ? this.index : this.index - 1);
  }

  fastForwardAudio(): void {
    if (this.queue.length > 0) {
      this.speakFrom(this.index + 1);
    }
  }

  /**
   * The Web Speech API fixes an utterance's rate when it starts, so a new speed
   * applies from the next chunk rather than mid-sentence.
   */
  updatePlaybackRate(speed: number): void {
    this.speed = clampRate(speed);
    this.estimateDurations();
  }

  /** Nothing is synthesized to a file, so there is never audio to save. */
  getLastGeneratedAudio(_filePath?: string): Blob | null {
    return null;
  }

  // --- Synthetic timeline ---

  private estimateDurations(): void {
    const rate = clampRate(this.speed);
    this.durations = this.queue.map(
      (chunk) => chunk.length / (CHARS_PER_SECOND * rate),
    );
  }

  private totalDuration(): number {
    if (this.queue.length === 0) {
      return NaN;
    }
    return this.durations.reduce((sum, value) => sum + value, 0);
  }

  private startOfChunk(index: number): number {
    let start = 0;
    for (let i = 0; i < index && i < this.durations.length; i++) {
      start += this.durations[i];
    }
    return start;
  }

  /** Estimated playback position in seconds. */
  private position(): number {
    if (this.queue.length === 0) {
      return 0;
    }
    if (this.ended) {
      return this.totalDuration();
    }
    const start = this.startOfChunk(this.index);
    if (this.chunkStartedAt === undefined) {
      return start;
    }
    const until = this.pausedSince ?? Date.now();
    const elapsed = (until - this.chunkStartedAt - this.pausedTotalMs) / 1000;
    // Don't let the estimate run past the chunk it belongs to.
    const cap = this.durations[this.index] ?? 0;
    return start + Math.max(0, Math.min(elapsed, cap));
  }

  /** Jump to the chunk covering `seconds` and speak from there. */
  private seekTo(seconds: number): void {
    if (this.queue.length === 0) {
      return;
    }
    const target = Math.max(0, Math.min(seconds, this.totalDuration()));
    let elapsed = 0;
    for (let i = 0; i < this.durations.length; i++) {
      elapsed += this.durations[i];
      if (target < elapsed) {
        this.speakFrom(i);
        return;
      }
    }
    this.speakFrom(this.durations.length - 1);
  }

  /**
   * Report the estimate through the <audio> element the player polls. The
   * element itself never holds media, so its native values would always be
   * NaN/0 and the scrubber would sit dead at 0:00.
   */
  private installSyntheticTimeline(): void {
    Object.defineProperty(this.audio, "duration", {
      configurable: true,
      get: () => this.totalDuration(),
    });
    Object.defineProperty(this.audio, "currentTime", {
      configurable: true,
      get: () => this.position(),
      set: (seconds: number) => this.seekTo(seconds),
    });
    Object.defineProperty(this.audio, "ended", {
      configurable: true,
      // Only "ended" once something has actually been spoken, otherwise the
      // player would fire its end handling on an idle provider.
      get: () => this.queue.length > 0 && this.ended,
    });
  }

  async validateCredentials(): Promise<CredentialValidationResult> {
    if (!this.synth || !this.makeUtterance) {
      return {
        isValid: false,
        error:
          "This device has no speech synthesis engine available to Obsidian.",
      };
    }
    const voices = this.synth.getVoices();
    if (voices.length === 0) {
      return {
        isValid: false,
        error:
          "No system voices reported yet. They load a moment after launch — try again, or add voices under Settings → Accessibility → Spoken Content → Voices.",
      };
    }
    const options = this.getVoiceOptions();
    return { isValid: true, voiceCount: options.length, voices: options };
  }

  protected getErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
      const message = String((error as { message: string }).message);
      if (message.includes("unavailable")) {
        return "On-device speech is unavailable here. Try a cloud provider.";
      }
      return message;
    }
    return "On-device speech failed. Please try again.";
  }
}

/** Web Speech allows 0.1–10; the plugin's player works in 0.5–2. */
function clampRate(speed: number): number {
  if (!Number.isFinite(speed)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, parseFloat(speed.toFixed(2))));
}

function defaultSynth(): SpeechSynthesisLike | undefined {
  return typeof window !== "undefined" && window.speechSynthesis
    ? window.speechSynthesis
    : undefined;
}

function defaultUtteranceFactory(): UtteranceFactory | undefined {
  return typeof SpeechSynthesisUtterance !== "undefined"
    ? (text: string) => new SpeechSynthesisUtterance(text)
    : undefined;
}
