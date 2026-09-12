import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { MarkdownView, type App } from "obsidian";
import {
  SourceMatcher,
  tokenizeSpoken,
  type SourceRange,
} from "../utils/sourceWords";
export { wordAt } from "../utils/sourceWords";

/**
 * Follow-along highlighting in the note while it is read.
 *
 * A CodeMirror decoration marks the passage currently being spoken, and a second
 * one marks the word inside it when the engine reports word boundaries (the
 * on-device provider does; a cloud provider handing back an MP3 cannot).
 *
 * Positions are resolved by content rather than by offset — see sourceWords.ts —
 * because the spoken text has been through the markdown pipeline and no longer
 * lines up with the note. Anchoring each word search inside the already-located
 * passage keeps a mis-match local instead of letting it drift down the note.
 */

export interface ReadingRanges {
  passage: SourceRange | null;
  word: SourceRange | null;
}

export const setReadingRanges = StateEffect.define<ReadingRanges>();

const passageMark = Decoration.mark({ class: "voice-reading-passage" });
const wordMark = Decoration.mark({ class: "voice-reading-word" });

export const readingHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setReadingRanges)) {
        continue;
      }
      const length = transaction.state.doc.length;
      const ranges = [];
      const passage = clampRange(effect.value.passage, length);
      if (passage) {
        ranges.push(passageMark.range(passage.from, passage.to));
      }
      const word = clampRange(effect.value.word, length);
      if (word) {
        ranges.push(wordMark.range(word.from, word.to));
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function clampRange(
  range: SourceRange | null,
  length: number,
): SourceRange | null {
  if (!range) {
    return null;
  }
  const from = Math.max(0, Math.min(range.from, length));
  const to = Math.max(from, Math.min(range.to, length));
  return to > from ? { from, to } : null;
}

/**
 * Tracks what is being spoken and pushes the resulting ranges into whichever
 * editor is showing the note being read.
 */
export class ReadingHighlighter {
  private source = "";
  private sourcePath: string | null = null;
  private matcher?: SourceMatcher;
  private passage: SourceRange | null = null;
  private wordMatcher?: SourceMatcher;
  private currentPassageText = "";

  constructor(private app: App) {}

  /**
   * Begin a reading pass against the note on screen. The source is read here
   * rather than passed in because the pipeline may have been handed only a
   * selection, whose offsets mean nothing in the document — starting the cursor
   * at the selection keeps the search aligned either way.
   */
  start(): void {
    // Not getActiveViewOfType: by the time reading begins the focus may have
    // moved to the player pane, and the note is then no longer the active view.
    const markdownView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.markdownViewForFile(this.app.workspace.getActiveFile()?.path);
    const cm = markdownView
      ? (markdownView.editor as { cm?: EditorView }).cm
      : undefined;
    if (!markdownView || !cm) {
      this.matcher = undefined;
      return;
    }
    // Read the text out of the CodeMirror document rather than through the
    // editor wrapper: the decorations are addressed in this document's
    // coordinates, and anything that normalises the text on the way out (line
    // endings, for one) would shift every offset after it.
    this.source = cm.state.doc.toString();
    this.sourcePath = markdownView.file?.path ?? null;
    this.matcher = new SourceMatcher(this.source);
    const selection = cm.state.selection.main;
    if (!selection.empty) {
      this.matcher.rewindTo(selection.from);
    }
    this.passage = null;
    this.wordMatcher = undefined;
    this.currentPassageText = "";
    // Lets the stylesheet add room below the note while reading, so the last
    // lines can still be scrolled clear of the mobile toolbar.
    activeDocument.body.addClass("voice-is-reading");
    this.render();
  }

  /**
   * The engine moved on to `spokenPassage`. Locates it in the note and marks it;
   * a passage that cannot be found clears the highlight rather than leaving a
   * stale one behind.
   */
  setPassage(spokenPassage: string): void {
    if (!this.matcher) {
      return;
    }
    if (spokenPassage === this.currentPassageText) {
      return;
    }
    this.currentPassageText = spokenPassage;
    this.passage = this.matcher.find(tokenizeSpoken(spokenPassage));
    this.wordMatcher = this.passage
      ? new SourceMatcher(this.source.slice(this.passage.from, this.passage.to))
      : undefined;
    // Bring the new passage into view — without this the highlight walks off
    // the bottom of the screen and you lose your place.
    this.render(null, this.passage?.from);
  }

  /** The engine reached `word` inside the current passage. */
  setWord(word: string): void {
    if (!this.passage || !this.wordMatcher) {
      return;
    }
    const found = this.wordMatcher.find(tokenizeSpoken(word));
    const range = found
      ? {
          from: this.passage.from + found.from,
          to: this.passage.from + found.to,
        }
      : null;
    // A passage can run to several lines on a phone, so follow the word too —
    // "nearest" only scrolls when it has actually gone out of view.
    this.render(range, range?.from, "nearest");
  }

  /** Reading stopped — clear everything. */
  stop(): void {
    this.passage = null;
    this.wordMatcher = undefined;
    this.currentPassageText = "";
    activeDocument.body.removeClass("voice-is-reading");
    this.render();
  }

  /** A seek moved backwards, so the forward cursor has to be rewound. */
  rewind(): void {
    this.matcher?.reset();
    this.currentPassageText = "";
  }

  /** Whether a reading pass is active and able to resolve positions. */
  get isActive(): boolean {
    return !!this.matcher;
  }

  private render(
    word: SourceRange | null = null,
    scrollTo?: number,
    align: "center" | "nearest" = "center",
  ): void {
    const view = this.editorView();
    if (!view) {
      return;
    }
    const effects: StateEffect<unknown>[] = [
      setReadingRanges.of({ passage: this.passage, word }),
    ];
    if (scrollTo !== undefined && scrollTo <= view.state.doc.length) {
      // Centre it so there is context both above and below, rather than the
      // line being read sitting against the bottom edge.
      effects.push(EditorView.scrollIntoView(scrollTo, { y: align }));
    }
    view.dispatch({ effects });
  }

  /**
   * The CodeMirror view showing the note being read. Matched by path so the
   * highlight cannot leak into a different note the user has switched to, and
   * so it survives the player pane taking focus.
   */
  private editorView(): EditorView | undefined {
    const view = this.markdownViewForFile(this.sourcePath);
    return view ? (view.editor as { cm?: EditorView }).cm : undefined;
  }

  /** The open markdown view showing `path`, whether or not it has focus. */
  private markdownViewForFile(
    path: string | undefined | null,
  ): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      if (path && view.file?.path !== path) {
        continue;
      }
      return view;
    }
    return undefined;
  }
}
