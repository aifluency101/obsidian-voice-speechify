import {
  SourceMatcher,
  normalizeWord,
  tokenizeSource,
  tokenizeSpoken,
} from "../src/utils/sourceWords";

describe("Unit Tests - Source word alignment", () => {
  test("normalizes words to a comparable form", () => {
    expect(normalizeWord("Hello,")).toBe("hello");
    expect(normalizeWord("**bold**")).toBe("bold");
    expect(normalizeWord("—")).toBe("");
    expect(normalizeWord("Ångström")).toBe("ångström");
  });

  test("tokenizes source text with offsets back into the original", () => {
    const source = "# Title\n\nHello **world**.";
    const words = tokenizeSource(source);
    expect(words.map((w) => w.text)).toEqual(["title", "hello", "world"]);
    const world = words[2];
    expect(source.slice(world.from, world.to)).toBe("world");
  });

  test("tokenizes spoken text, dropping punctuation-only tokens", () => {
    expect(tokenizeSpoken("Hello, world — again!")).toEqual([
      "hello",
      "world",
      "again",
    ]);
  });

  test("finds a spoken passage in the markdown source", () => {
    const source = "## Heading\n\nThe **quick** brown fox jumps over it.";
    const matcher = new SourceMatcher(source);
    const range = matcher.find(tokenizeSpoken("quick brown fox"));
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toBe("quick** brown fox");
  });

  test("resolves repeated phrases to successive occurrences", () => {
    const source = "one two three. one two three. one two three.";
    const matcher = new SourceMatcher(source);
    const first = matcher.find(tokenizeSpoken("one two"))!;
    const second = matcher.find(tokenizeSpoken("one two"))!;
    expect(second.from).toBeGreaterThan(first.from);
    expect(source.slice(second.from, second.to)).toBe("one two");
  });

  test("tolerates markup words the engine never spoke", () => {
    // a link's target is not read aloud, but sits in the source
    const source = "See the [official docs](https://example.com/guide) today.";
    const matcher = new SourceMatcher(source);
    const range = matcher.find(tokenizeSpoken("official docs today"));
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toContain("official docs");
  });

  test("returns null when the passage is not nearby, without losing the cursor", () => {
    const source = "alpha beta gamma delta";
    const matcher = new SourceMatcher(source);
    expect(matcher.find(tokenizeSpoken("nothing like this"))).toBeNull();
    // the cursor is untouched, so the next real passage still resolves
    const range = matcher.find(tokenizeSpoken("alpha beta"))!;
    expect(source.slice(range.from, range.to)).toBe("alpha beta");
  });

  test("rewinds to a given offset so seeking backwards re-resolves", () => {
    const source = "one two three four five six";
    const matcher = new SourceMatcher(source);
    matcher.find(tokenizeSpoken("five six"));
    matcher.rewindTo(0);
    const range = matcher.find(tokenizeSpoken("one two"))!;
    expect(source.slice(range.from, range.to)).toBe("one two");
  });

  test("handles empty input safely", () => {
    const matcher = new SourceMatcher("");
    expect(matcher.find(tokenizeSpoken("anything"))).toBeNull();
    expect(new SourceMatcher("some words").find([])).toBeNull();
  });
});
