/**
 * Locating spoken text back in the note's markdown.
 *
 * What the engine speaks is not what the note contains: the pipeline strips
 * markup, may spell out acronyms, and can skip URLs and code blocks. So a
 * character offset in the spoken text means nothing in the source, and the two
 * have to be re-aligned by content.
 *
 * Both sides are reduced to a stream of comparable words — lowercased, stripped
 * of punctuation — with the source words keeping their offsets in the original
 * markdown. Matching then walks forward through the source with a bounded
 * look-ahead, so inserted or dropped words cost at most a local mismatch instead
 * of desynchronising the rest of the note.
 *
 * Pure and dependency-free so the alignment can be unit-tested on its own.
 */

export interface SourceWord {
  /** comparable form: lowercase, letters and digits only */
  text: string;
  /** offset of the word in the original source */
  from: number;
  /** offset one past the end of the word */
  to: number;
}

export interface SourceRange {
  from: number;
  to: number;
}

/** How far ahead of the cursor a match may be found before it is rejected. */
const DEFAULT_LOOKAHEAD = 60;

/** Reduce a word to its comparable form; returns "" for pure punctuation. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Split text into comparable words, recording where each sits in `text`. */
export function tokenizeSource(text: string): SourceWord[] {
  const words: SourceWord[] = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const normalized = normalizeWord(match[0]);
    if (normalized) {
      words.push({
        text: normalized,
        from: match.index,
        to: match.index + match[0].length,
      });
    }
  }
  return words;
}

/** Split spoken text into comparable words, dropping anything unpronounceable. */
export function tokenizeSpoken(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((word) => word.length > 0);
}

/**
 * A forward-only cursor over the note's words.
 *
 * Each lookup starts from where the last one ended, which is what keeps
 * repeated words (very common in prose) resolving to the right occurrence.
 */
export class SourceMatcher {
  private words: SourceWord[];
  private cursor = 0;

  constructor(
    source: string,
    private lookahead: number = DEFAULT_LOOKAHEAD,
  ) {
    this.words = tokenizeSource(source);
  }

  /** Start over from the top of the note. */
  reset(): void {
    this.cursor = 0;
  }

  /** Move the cursor back to the word containing `offset`. */
  rewindTo(offset: number): void {
    const index = this.words.findIndex((word) => word.to > offset);
    this.cursor = index < 0 ? this.words.length : index;
  }

  /**
   * Find the next run of source words matching `spoken`, at or after the cursor.
   * On success the cursor moves to just after the match. Returns null when the
   * passage cannot be found nearby, leaving the cursor alone so the next
   * passage can still resync.
   */
  find(spoken: string[]): SourceRange | null {
    const needle = spoken.filter((word) => word.length > 0);
    if (needle.length === 0 || this.words.length === 0) {
      return null;
    }

    // Nearby first: that is what keeps repeated phrases resolving in order.
    const near = this.scan(
      this.cursor,
      Math.min(this.words.length, this.cursor + this.lookahead),
      needle,
    );
    if (near) {
      return near;
    }
    // Then the rest of the note, then from the top — a seek can land anywhere,
    // and a passage found out of order beats no highlight at all.
    return (
      this.scan(this.cursor, this.words.length, needle) ??
      this.scan(0, this.cursor, needle)
    );
  }

  private scan(
    start: number,
    limit: number,
    needle: string[],
  ): SourceRange | null {
    for (let index = start; index < limit; index++) {
      const end = this.matchFrom(index, needle);
      if (end !== null) {
        this.cursor = end;
        return { from: this.words[index].from, to: this.words[end - 1].to };
      }
    }
    return null;
  }

  /**
   * Try to match `needle` beginning at source word `start`, tolerating words the
   * pipeline added or removed. Returns the index one past the last matched
   * source word, or null.
   */
  private matchFrom(start: number, needle: string[]): number | null {
    // The opening word has to line up, otherwise every passage would "match"
    // somewhere by skipping enough.
    if (this.words[start]?.text !== needle[0]) {
      return null;
    }

    let sourceIndex = start + 1;
    let matched = 1;
    let skipped = 0;
    const maxSkips = Math.max(4, Math.floor(needle.length / 4));

    for (let i = 1; i < needle.length; i++) {
      // allow a few source words to be passed over (markup the engine never said)
      let found = false;
      for (let ahead = 0; ahead <= maxSkips - skipped; ahead++) {
        const candidate = this.words[sourceIndex + ahead];
        if (!candidate) {
          break;
        }
        if (candidate.text === needle[i]) {
          skipped += ahead;
          sourceIndex = sourceIndex + ahead + 1;
          matched++;
          found = true;
          break;
        }
      }
      if (!found) {
        // allow words the engine spoke that the note does not contain
        skipped++;
        if (skipped > maxSkips) {
          break;
        }
      }
    }

    // Require most of the passage to line up before trusting the match.
    const ratio = matched / needle.length;
    if (ratio < 0.6 || sourceIndex <= start) {
      return null;
    }
    return sourceIndex;
  }
}

/**
 * The word beginning at `charIndex` in `text`. Safari reports the offset of a
 * spoken word but not its length, so the extent is read off the text itself.
 */
export function wordAt(text: string, charIndex: number): string {
  if (charIndex < 0 || charIndex >= text.length) {
    return "";
  }
  return text.slice(charIndex).match(/^[\p{L}\p{N}'’-]+/u)?.[0] ?? "";
}
