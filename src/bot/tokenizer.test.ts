import { describe, expect, it } from "vitest";
import {
	getTokenizerKind,
	joinTokens,
	loadTokenizer,
	splitSentences,
	tokenize,
	tokenizeDetailed,
} from "./tokenizer.js";

describe("tokenizer backend", () => {
	it("loads kuromoji when the dictionary is available", async () => {
		await loadTokenizer();
		expect(["kuromoji", "segmenter"]).toContain(getTokenizerKind());
	});
});

describe("tokenize", () => {
	it("round-trips through morphemes without losing words", async () => {
		expect(joinTokens(await tokenize("今日はいい天気ですね"))).toBe(
			"今日はいい天気ですね",
		);
	});

	it("produces multiple tokens for a normal sentence (no whole-post learning)", async () => {
		const tokens = await tokenize("今日はいい天気ですね");
		expect(tokens.length).toBeGreaterThan(1);
		expect(tokens.length).toBeLessThan(12);
	});

	it("drops punctuation so decorations stay in the speech layer", async () => {
		const tokens = await tokenize("やったー!すごい?ね。");
		expect(tokens).not.toContain("!");
		expect(tokens).not.toContain("?");
		expect(tokens).not.toContain("。");
		expect(joinTokens(tokens).length).toBeGreaterThan(0);
	});

	it("drops emojis as decoration instead of learning them", async () => {
		const tokens = await tokenize("猫 😊 :custom_cat: もぐもぐ");
		expect(tokens).toContain("猫");
		expect(tokens).toContain("もぐもぐ");
		expect(tokens).not.toContain("😊");
		expect(tokens).not.toContain(":custom_cat:");
		expect(tokens).not.toContain("custom_cat");
		expect(tokens.join("")).not.toMatch(/😊|:custom_cat:/);
	});

	it("keeps clock times while dropping custom emoji literals", async () => {
		const tokens = await tokenize("会議は12:30から :OK_hand:");
		expect(tokens.join("")).toContain("12");
		expect(tokens.join("")).toContain("30");
		expect(tokens).not.toContain(":OK_hand:");
	});

	it("returns [] for empty or punctuation-only input", async () => {
		expect(await tokenize("")).toEqual([]);
		expect(await tokenize("、。，…")).toEqual([]);
	});
});

describe("tokenizeDetailed", () => {
	it("attaches POS tags used for generation filtering", async () => {
		const detailed = await tokenizeDetailed("今日はいい天気ですね");
		expect(detailed.length).toBeGreaterThan(1);
		for (const token of detailed) {
			expect(token.text.length).toBeGreaterThan(0);
			expect(typeof token.pos).toBe("string");
			expect(typeof token.detail).toBe("string");
		}
		if (getTokenizerKind() === "kuromoji") {
			const byText = new Map(detailed.map((token) => [token.text, token]));
			expect(byText.get("は")?.pos).toBe("助詞");
		}
	});
});

describe("splitSentences", () => {
	it("splits on Japanese sentence boundaries", () => {
		expect(splitSentences("おはよう。こんにちは!さようなら?")).toEqual([
			"おはよう。",
			"こんにちは!",
			"さようなら?",
		]);
	});

	it("keeps single sentences and drops empties", () => {
		expect(splitSentences("ひとこと")).toEqual(["ひとこと"]);
		expect(splitSentences("")).toEqual([]);
		expect(splitSentences("。")).toEqual(["。"]);
	});
});
