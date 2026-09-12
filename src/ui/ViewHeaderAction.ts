import {
  MarkdownView,
  addIcon,
  setIcon,
  type App,
  type EventRef,
} from "obsidian";
import type { SpeechProvider } from "../service/SpeechProvider";

/**
 * A read-aloud control in the note's own header, next to the reading-view and
 * more-options icons. On mobile especially this is the only place you can start
 * listening without opening a pane — the ribbon is behind a menu there.
 *
 * While speaking, the icon becomes a small animated waveform. It is an activity
 * indicator, not a meter: neither the on-device engine nor a finished MP3 gives
 * us amplitude to plot, so the bars show *that* it is speaking, not how loudly.
 */

const ICON_ID = "voice-audio-lines";

// lucide.dev "audio-lines" (ISC). Registered under our own id because the
// bundled icon set varies by Obsidian version, and a missing name renders blank.
const AUDIO_LINES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>`;

type ActionState = "idle" | "loading" | "playing";

export interface ViewHeaderActionHost {
  readonly app: App;
  registerEvent(ref: EventRef): void;
  registerInterval(id: number): number;
  getSpeechProvider(): SpeechProvider;
  speakText(speed?: number): Promise<void>;
}

export class ViewHeaderAction {
  private buttons = new Map<HTMLElement, ActionState>();

  constructor(private host: ViewHeaderActionHost) {}

  register(): void {
    addIcon(ICON_ID, AUDIO_LINES_SVG);

    const workspace = this.host.app.workspace;
    this.host.registerEvent(
      workspace.on("layout-change", () => this.syncButtons()),
    );
    this.host.registerEvent(
      workspace.on("active-leaf-change", () => this.syncButtons()),
    );
    // The on-device provider has no real media element, so its playback state
    // fires no audio events — poll instead, as the player pane does.
    this.host.registerInterval(
      window.setInterval(() => this.refreshState(), 250),
    );
    this.syncButtons();
  }

  /** Give every open markdown view a button, exactly once. */
  private syncButtons(): void {
    for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      if (view.containerEl.querySelector(".voice-header-action")) {
        continue;
      }
      const button = view.addAction(ICON_ID, "Read aloud", () => this.toggle());
      button.addClass("voice-header-action");
      // Paint straight away so the resting state is our own waveform rather
      // than the registered icon, which renders at a different weight.
      this.paint(button, "idle");
      this.buttons.set(button, "idle");
    }
    this.pruneDetached();
    this.refreshState();
  }

  /** Drop buttons whose view has been closed, so the map cannot grow forever. */
  private pruneDetached(): void {
    for (const button of [...this.buttons.keys()]) {
      if (!button.isConnected) {
        this.buttons.delete(button);
      }
    }
  }

  private toggle(): void {
    const provider = this.host.getSpeechProvider();

    // A tap while synthesis is running cancels it, matching the player.
    if (provider.isOperationInProgress()) {
      provider.cancelOperation();
      return;
    }
    if (provider.isPlaying()) {
      provider.pauseAudio();
      return;
    }
    // Part-way through and paused: carry on rather than starting over.
    if (provider.getCurrentTime() > 0 && !provider.hasEnded()) {
      void provider.playAudio();
      return;
    }
    void this.host.speakText();
  }

  private refreshState(): void {
    if (this.buttons.size === 0) {
      return;
    }
    const provider = this.host.getSpeechProvider();
    const state: ActionState = provider.isOperationInProgress()
      ? "loading"
      : provider.isPlaying()
        ? "playing"
        : "idle";

    for (const [button, previous] of this.buttons) {
      if (previous === state) {
        continue;
      }
      this.paint(button, state);
      this.buttons.set(button, state);
    }
  }

  private paint(button: HTMLElement, state: ActionState): void {
    button.empty();
    button.removeClass("rotating-icon");
    button.toggleClass("is-speaking", state === "playing");

    switch (state) {
      case "loading":
        setIcon(button, "refresh-ccw");
        button.addClass("rotating-icon");
        button.setAttribute("aria-label", "Cancel");
        break;
      case "playing":
        this.paintWave(button, false);
        button.setAttribute("aria-label", "Pause");
        break;
      default:
        this.paintWave(button, true);
        button.setAttribute("aria-label", "Read aloud");
    }
  }

  /**
   * The same bars in both states — still when idle, moving while speaking — so
   * the control keeps exactly one size and shape. Styling lives in styles.css.
   */
  private paintWave(button: HTMLElement, still: boolean): void {
    const wave = button.createDiv({
      cls: still ? "voice-wave is-static" : "voice-wave",
    });
    for (let i = 0; i < 5; i++) {
      wave.createSpan({ cls: "voice-wave-bar" });
    }
  }
}
