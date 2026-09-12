import {
  SystemVoiceService,
  type SpeechSynthesisLike,
} from "../src/service/SystemVoiceService";

type FakeUtterance = {
  text: string;
  rate: number;
  lang?: string;
  voice?: SpeechSynthesisVoice;
  onend?: () => void;
  onerror?: (event: { error: string }) => void;
};

function makeVoice(
  voiceURI: string,
  name: string,
  lang: string,
  isDefault = false,
): SpeechSynthesisVoice {
  return {
    voiceURI,
    name,
    lang,
    default: isDefault,
    localService: true,
  } as SpeechSynthesisVoice;
}

class FakeSynth implements SpeechSynthesisLike {
  speaking = false;
  paused = false;
  spoken: FakeUtterance[] = [];
  cancelled = 0;
  constructor(private voices: SpeechSynthesisVoice[] = []) {}
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
  speak(utterance: SpeechSynthesisUtterance): void {
    this.speaking = true;
    this.paused = false;
    this.spoken.push(utterance as unknown as FakeUtterance);
  }
  cancel(): void {
    this.cancelled++;
    this.speaking = false;
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  /** finish the utterance that is currently speaking */
  finishCurrent(): void {
    this.speaking = false;
    this.spoken[this.spoken.length - 1]?.onend?.();
  }
}

const utteranceFactory = (text: string) =>
  ({ text, rate: 1 }) as unknown as SpeechSynthesisUtterance;

function makeService(
  synth: FakeSynth,
  voice = "",
  speed = 1,
): SystemVoiceService {
  return new SystemVoiceService(voice, speed, synth, utteranceFactory);
}

describe("Unit Tests - System voice provider", () => {
  test("maps the operating system's voices, flagging the default", () => {
    const synth = new FakeSynth([
      makeVoice("com.apple.Daniel", "Daniel", "en-GB"),
      makeVoice("com.apple.Samantha", "Samantha", "en-US", true),
    ]);
    expect(makeService(synth).getVoiceOptions()).toEqual([
      { id: "com.apple.Daniel", label: "Daniel", lang: "en-GB" },
      { id: "com.apple.Samantha", label: "Samantha (default)", lang: "en-US" },
    ]);
  });

  test("declares plain-text input and never offers audio to save", async () => {
    const service = makeService(new FakeSynth());
    expect(service.inputFormat).toBe("text");
    expect(service.getLastGeneratedAudio("note.md")).toBeNull();
  });

  test("speaks one chunk at a time, advancing when each finishes", async () => {
    const synth = new FakeSynth();
    const service = makeService(synth);
    // two paragraphs comfortably over the 400 char chunk limit
    const text = `${"a".repeat(380)}\n\n${"b".repeat(380)}`;

    await service.speak(text);

    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text.startsWith("a")).toBe(true);

    synth.finishCurrent();
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text.startsWith("b")).toBe(true);

    synth.finishCurrent();
    expect(synth.spoken).toHaveLength(2);
    expect(service.hasEnded()).toBe(true);
  });

  test("applies the selected voice and clamps the rate", async () => {
    const daniel = makeVoice("com.apple.Daniel", "Daniel", "en-GB");
    const synth = new FakeSynth([daniel]);
    const service = makeService(synth, "com.apple.Daniel", 5);

    await service.speak("Hello.");

    expect(synth.spoken[0].voice).toBe(daniel);
    expect(synth.spoken[0].lang).toBe("en-GB");
    expect(synth.spoken[0].rate).toBe(2);
  });

  test("a new speed applies from the next chunk, not mid-sentence", async () => {
    const synth = new FakeSynth();
    const service = makeService(synth);
    await service.speak(`${"a".repeat(380)}\n\n${"b".repeat(380)}`);
    expect(synth.spoken[0].rate).toBe(1);

    service.setSpeed(1.5);
    expect(synth.spoken[0].rate).toBe(1);

    synth.finishCurrent();
    expect(synth.spoken[1].rate).toBe(1.5);
  });

  test("pause, resume and stop drive the engine", async () => {
    const synth = new FakeSynth();
    const service = makeService(synth);
    await service.speak("Hello.");
    expect(service.isPlaying()).toBe(true);

    service.pauseAudio();
    expect(synth.paused).toBe(true);
    expect(service.isPlaying()).toBe(false);

    await service.playAudio();
    expect(synth.paused).toBe(false);
    expect(service.isPlaying()).toBe(true);

    service.stopAudio();
    expect(synth.cancelled).toBeGreaterThan(0);
    expect(service.hasEnded()).toBe(true);
  });

  test("skip controls move by a chunk of text", async () => {
    const synth = new FakeSynth();
    const service = makeService(synth);
    await service.speak(
      `${"a".repeat(380)}\n\n${"b".repeat(380)}\n\n${"c".repeat(380)}`,
    );

    service.fastForwardAudio();
    expect(synth.spoken[synth.spoken.length - 1].text.startsWith("b")).toBe(
      true,
    );

    service.rewindAudio();
    expect(synth.spoken[synth.spoken.length - 1].text.startsWith("a")).toBe(
      true,
    );
  });

  test("a stale utterance ending does not advance after a restart", async () => {
    const synth = new FakeSynth();
    const service = makeService(synth);
    await service.speak(`${"a".repeat(380)}\n\n${"b".repeat(380)}`);
    const stale = synth.spoken[0];

    service.stopAudio();
    const spokenAfterStop = synth.spoken.length;
    stale.onend?.();

    expect(synth.spoken).toHaveLength(spokenAfterStop);
  });

  test("reports when the device has no engine or no voices", async () => {
    const none = new SystemVoiceService("", 1, undefined, undefined);
    await expect(none.validateCredentials()).resolves.toMatchObject({
      isValid: false,
    });
    await expect(none.speak("Hello")).rejects.toThrow(/unavailable/i);

    const empty = makeService(new FakeSynth());
    const result = await empty.validateCredentials();
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Spoken Content/);
  });

  test("validates with the device's voice count", async () => {
    const synth = new FakeSynth([makeVoice("a", "A", "en-US")]);
    const result = await makeService(synth).validateCredentials();
    expect(result).toMatchObject({ isValid: true, voiceCount: 1 });
  });

  test("is created by the factory when TTS_PROVIDER is system", async () => {
    const { createSpeechProvider } =
      await import("../src/service/SpeechProviderFactory");
    const { DEFAULT_SETTINGS } = await import("../src/settings/VoiceSettings");
    const provider = createSpeechProvider({
      ...DEFAULT_SETTINGS,
      TTS_PROVIDER: "system",
    });
    expect(provider).toBeInstanceOf(SystemVoiceService);
    expect(provider.inputFormat).toBe("text");
  });
});
