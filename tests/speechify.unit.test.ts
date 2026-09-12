import { requestUrl } from "obsidian";
import { mapSpeechifyVoices } from "../src/service/voiceCatalog";
import {
  SpeechifySpeechService,
  parseSpeechifyError,
} from "../src/service/SpeechifySpeechService";
import { speechifyFallbackVoices } from "../src/settings/VoiceSettings";

const mockRequestUrl = requestUrl as jest.Mock;

const rawVoices = [
  {
    id: "geffen_32",
    display_name: "Geffen",
    gender: "male",
    locale: "en-US",
    type: "shared",
    models: [{ name: "simba-3.2" }],
  },
  {
    id: "my_clone",
    display_name: "My Clone",
    gender: "not_specified",
    locale: "en-GB",
    type: "personal",
    models: [{ name: "simba-3.2" }, { name: "simba-3.0" }],
  },
  {
    id: "george",
    display_name: "George",
    gender: "male",
    locale: "en-GB",
    type: "shared",
    models: [{ name: "simba-3.0" }],
  },
];

describe("Unit Tests - Speechify voice catalog", () => {
  test("maps voices, labelling gender and cloned voices", () => {
    const voices = mapSpeechifyVoices(rawVoices);
    expect(voices).toEqual([
      { id: "geffen_32", label: "Geffen (male)", lang: "en-US" },
      { id: "my_clone", label: "My Clone (cloned)", lang: "en-GB" },
      { id: "george", label: "George (male)", lang: "en-GB" },
    ]);
  });

  test("filters to the voices a model can speak", () => {
    expect(mapSpeechifyVoices(rawVoices, "simba-3.0").map((v) => v.id)).toEqual(
      ["my_clone", "george"],
    );
  });

  test("drops duplicates and entries without an id, and tolerates junk", () => {
    expect(
      mapSpeechifyVoices([
        { id: "a", display_name: "A", locale: "en-US" },
        { id: "a", display_name: "A again", locale: "en-US" },
        { display_name: "No id" },
      ]).map((v) => v.id),
    ).toEqual(["a"]);
    expect(mapSpeechifyVoices(null)).toEqual([]);
    expect(mapSpeechifyVoices({ voices: [] })).toEqual([]);
  });

  test("falls back to the Simba 3.2 list for an unknown model", () => {
    expect(speechifyFallbackVoices("simba-3.0").map((v) => v.id)).toContain(
      "george",
    );
    expect(speechifyFallbackVoices("nonsense")).toEqual(
      speechifyFallbackVoices("simba-3.2"),
    );
  });
});

describe("Unit Tests - Speechify error parsing", () => {
  test("extracts the API's error message", () => {
    expect(
      parseSpeechifyError(
        JSON.stringify({ error: { code: "bad_request", message: "nope" } }),
      ),
    ).toBe("nope");
  });

  test("returns undefined for a missing or unparseable body", () => {
    expect(parseSpeechifyError(undefined)).toBeUndefined();
    expect(parseSpeechifyError("<html>502</html>")).toBeUndefined();
    expect(parseSpeechifyError("{}")).toBeUndefined();
  });
});

describe("Unit Tests - Speechify Provider", () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
  });

  test("declares the plain-text input format and no pause markup", () => {
    const service = new SpeechifySpeechService("key", "geffen_32", "simba-3.2");
    expect(service.inputFormat).toBe("text");
    // Speechify reads <break> tags literally in plain-text mode
    expect(service.textPauseStyle).toBe("none");
  });

  test("offers the model's built-in voices until a catalog is cached", () => {
    const service = new SpeechifySpeechService("key", "george", "simba-3.0");
    expect(service.getVoiceOptions().map((v) => v.id)).toContain("george");

    const withCatalog = new SpeechifySpeechService(
      "key",
      "geffen_32",
      "simba-3.2",
      1.0,
      [{ id: "custom", label: "Custom", lang: "en-US" }],
    );
    expect(withCatalog.getVoiceOptions()).toEqual([
      { id: "custom", label: "Custom", lang: "en-US" },
    ]);
  });

  test("synthesizes: correct endpoint, bearer auth and body", async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: new Uint8Array([0xff, 0xfb, 0x90]).buffer,
    });

    const service = new SpeechifySpeechService(
      "my-key",
      "geffen_32",
      "simba-3.2",
      1.0,
    );
    await service.speak("Hello world.", 1.0, "note.md");

    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toBe("https://api.speechify.ai/v1/audio/stream");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer my-key");
    expect(call.headers.Accept).toBe("audio/mpeg");
    expect(JSON.parse(call.body)).toEqual({
      input: "Hello world.",
      voice_id: "geffen_32",
      model: "simba-3.2",
    });

    // Audio should be cached for the active note (download support)
    expect(service.getLastGeneratedAudio("note.md")).not.toBeNull();
  });

  test("throws and reports when the API key is missing", async () => {
    const service = new SpeechifySpeechService("", "geffen_32", "simba-3.2");
    const errorCallback = jest.fn();
    service.setErrorCallback(errorCallback);

    await expect(service.speak("Hello")).rejects.toThrow();
    expect(errorCallback).toHaveBeenCalled();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  test("surfaces the API's error message on a failed synthesis", async () => {
    mockRequestUrl.mockResolvedValue({
      status: 400,
      text: JSON.stringify({
        error: { code: "invalid_request", message: "voice_id is invalid" },
      }),
    });
    const service = new SpeechifySpeechService("key", "nope", "simba-3.2");
    const errorCallback = jest.fn();
    service.setErrorCallback(errorCallback);

    await expect(service.speak("Hello")).rejects.toThrow(/voice_id is invalid/);
    expect(errorCallback).toHaveBeenCalled();
  });

  test("reports an empty audio response", async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      arrayBuffer: new ArrayBuffer(0),
    });
    const service = new SpeechifySpeechService("key", "geffen_32", "simba-3.2");
    service.setErrorCallback(jest.fn());

    await expect(service.speak("Hello")).rejects.toThrow(/empty audio/i);
  });

  test("rejects a missing key without a network call", async () => {
    const service = new SpeechifySpeechService("", "geffen_32", "simba-3.2");
    const result = await service.validateCredentials();
    expect(result.isValid).toBe(false);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  test("validates by listing the selected model's voices", async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      json: { voices: rawVoices, has_more: false },
    });
    const service = new SpeechifySpeechService("key", "george", "simba-3.0");

    const result = await service.validateCredentials();

    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toContain("/v1/voices");
    expect(call.url).toContain("model=simba-3.0");
    expect(call.headers.Authorization).toBe("Bearer key");
    expect(result.isValid).toBe(true);
    expect(result.voices?.map((v) => v.id)).toEqual(["my_clone", "george"]);
    expect(result.voiceCount).toBe(2);
  });

  test("reports an invalid key", async () => {
    mockRequestUrl.mockResolvedValue({ status: 401, text: "{}" });
    const service = new SpeechifySpeechService("bad", "geffen_32", "simba-3.2");

    const result = await service.validateCredentials();

    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/invalid or expired API key/i);
  });

  test("is created by the factory when TTS_PROVIDER is speechify", async () => {
    const { createSpeechProvider } =
      await import("../src/service/SpeechProviderFactory");
    const { DEFAULT_SETTINGS } = await import("../src/settings/VoiceSettings");
    const provider = createSpeechProvider({
      ...DEFAULT_SETTINGS,
      TTS_PROVIDER: "speechify",
      SPEECHIFY_API_KEY: "k",
    });
    expect(provider).toBeInstanceOf(SpeechifySpeechService);
    expect(provider.inputFormat).toBe("text");
  });
});
