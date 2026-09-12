import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { MarkdownView, type App } from "obsidian";
import { SourceMatcher, type SourceRange } from "../utils/sourceWords";

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
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.matcher = undefined;
      return;
    }
    this.source = view.editor.getValue();
    this.sourcePath = view.file?.path ?? null;
    this.matcher = new SourceMatcher(this.source);
    const selection = view.editor.getSelection();
    if (selection) {
      this.matcher.rewindTo(
        view.editor.posToOffset(view.editor.getCursor("from")),
      );
    }
    this.passage = null;
    this.wordMatcher = undefined;
    this.currentPassageText = "";
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
    this.passage = this.matcher.find(tokenize(spokenPassage));
    this.wordMatcher = this.passage
      ? new SourceMatcher(this.source.slice(this.passage.from, this.passage.to))
      : undefined;
    this.render();
  }

  /** The engine reached `word` inside the current passage. */
  setWord(word: string): void {
    if (!this.passage || !this.wordMatcher) {
      return;
    }
    const found = this.wordMatcher.find(tokenize(word));
    const range = found
      ? {
          from: this.passage.from + found.from,
          to: this.passage.from + found.to,
        }
      : null;
    this.render(range);
  }

  /** Reading stopped — clear everything. */
  stop(): void {
    this.passage = null;
    this.wordMatcher = undefined;
    this.currentPassageText = "";
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

  private render(word: SourceRange | null = null): void {
    const view = this.editorView();
    if (!view) {
      return;
    }
    view.dispatch({
      effects: setReadingRanges.of({ passage: this.passage, word }),
    });
  }

  /**
   * The CodeMirror view showing the note being read. Prefers the note by path so
   * the highlight does not jump into a different note the user has switched to.
   */
  private editorView(): EditorView | undefined {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      if (this.sourcePath && view.file?.path !== this.sourcePath) {
        continue;
      }
      const cm = (view.editor as { cm?: EditorView }).cm;
      if (cm) {
        return cm;
      }
    }
    return undefined;
  }
}

/** The word beginning at `charIndex`; Safari gives the offset but not the length. */
export function wordAt(text: string, charIndex: number): string {
  if (charIndex < 0 || charIndex >= text.length) {
    return "";
  }
  return text.slice(charIndex).match(/^[\p{L}\p{N}'’-]+/u)?.[0] ?? "";
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
}
