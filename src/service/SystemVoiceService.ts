import type { VoiceOption, VoiceSettings } from "../settings/VoiceSettings";
import { BaseSpeechService } from "./BaseSpeechService";
import type { CredentialValidationResult } from "./SpeechProvider";
import { chunkPlainText } from "./textChunker";

/**
 * On-device speech via the Web Speech API (`speechSynthesis`), which is backed
 * by the operating system's own engine — AVSpeechSynthesizer on iOS/macOS, SAPI
 * on Windows. No account, no API key, no network, no cost.
 *
 * This provider does not synthesize audio data, it only speaks, so unlike every
 * other provider it has nothing to hand back for downloading: getLastGeneratedAudio()
 * always returns null and the save controls disable themselves accordingly. The
 * inherited <audio> element stays empty, so the scrubber reads 0:00 — there is no
 * media to seek.
 *
 * Text is spoken one chunk at a time rather than queued in one go, so that a
 * change of speed or voice takes effect at the next chunk, and so stopping is
 * responsive on engines that ignore cancel() mid-utterance.
 */

// Short enough that speed changes and stops land quickly, long enough that the
// engine still applies sentence prosody rather than reading word by word.
const MAX_CHUNK_CHARS = 400;

export type SpeechSynthesisLike = Pick<
  SpeechSynthesis,
  "speak" | "cancel" | "pause" | "resume" | "getVoices" | "speaking" | "paused"
>;

export type UtteranceFactory = (text: string) => SpeechSynthesisUtterance;

export class SystemVoiceService extends BaseSpeechService {
  readonly inputFormat = "text" as const;

  private synth?: SpeechSynthesisLike;
  private makeUtterance?: UtteranceFactory;
  private queue: string[] = [];
  private index = 0;
  private ended = true;
  /** bumped on every cancel/restart so stale utterance callbacks are ignored */
  private generation = 0;

  constructor(
    voice: string,
    speed?: number,
    synth: SpeechSynthesisLike | undefined = defaultSynth(),
    makeUtterance: UtteranceFactory | undefined = defaultUtteranceFactory(),
  ) {
    super(voice, speed);
    this.synth = synth;
    this.makeUtterance = makeUtterance;
  }

  getVoiceOptions(): VoiceOption[] {
    const voices = this.synth?.getVoices() ?? [];
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
    // Nothing is downloaded, so synthesis is "complete" the moment it starts.
    this.reportProgress(1, 1);
    this.speakFrom(0);
  }

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

  // --- Playback controls, redirected from the <audio> element to the engine ---

  async playAudio(speed?: number): Promise<void> {
    if (!this.synth) {
      return;
    }
    if (typeof speed === "number") {
      this.speed = speed;
    }
    if (this.synth.paused && this.synth.speaking) {
      this.synth.resume();
      return;
    }
    if (!this.synth.speaking && this.queue.length > 0) {
      this.speakFrom(this.ended ? 0 : this.index);
    }
  }

  pauseAudio(): void {
    if (this.synth?.speaking && !this.synth.paused) {
      this.synth.pause();
    }
  }

  stopAudio(): void {
    this.generation++;
    this.synth?.cancel();
    this.index = 0;
    this.ended = true;
  }

  isPlaying(): boolean {
    return !!this.synth?.speaking && !this.synth.paused;
  }

  hasEnded(): boolean {
    return this.ended;
  }

  /** There is no timeline to seek, so skipping moves by a chunk of text. */
  rewindAudio(): void {
    if (this.queue.length > 0) {
      this.speakFrom(this.index - 1);
    }
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
  }

  /** Nothing is synthesized to a file, so there is never audio to save. */
  getLastGeneratedAudio(_filePath?: string): Blob | null {
    return null;
  }

  async validateCredentials(): Promise<CredentialValidationResult> {
    if (!this.synth || !this.makeUtterance) {
      return {
        isValid: false,
        error:
          "This device has no speech synthesis engine available to Obsidian.",
      };
    }
    const voices = this.getVoiceOptions();
    if (voices.length === 0) {
      return {
        isValid: false,
        error:
          "No system voices were found. On iOS add them under Settings → Accessibility → Spoken Content → Voices.",
      };
    }
    return { isValid: true, voiceCount: voices.length, voices };
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
