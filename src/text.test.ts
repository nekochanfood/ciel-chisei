import { describe, expect, it, vi } from "vitest";
import { MarkovModel } from "./bot/markov.js";
import {
	buildReply,
	formatBio,
	formatTimestamp,
	isMentionForBot,
	parseOptCommand,
} from "./bot/text.js";
import { BOS } from "./bot/tokenizer.js";

describe("isMentionForBot", () => {
	const post = {
		id: "1",
		content: "hello @chisei 元気？",
		author: { id: "u1", username: "neko" },
		mentions: [{ username: "chisei" }],
	};

	it("detects structured mentions", () => {
		expect(isMentionForBot(post, "chisei")).toBe(true);
	});

	it("detects @username in text", () => {
		expect(isMentionForBot({ ...post, mentions: [] }, "chisei")).toBe(true);
	});

	it("ignores other users", () => {
		expect(
			isMentionForBot(
				{ ...post, content: "hello", mentions: [{ username: "other" }] },
				"chisei",
			),
		).toBe(false);
	});

	it("matches optional wake words", () => {
		expect(
			isMentionForBot(
				{ ...post, content: "ちせい おはよ", mentions: [] },
				"chisei",
				["ちせい"],
			),
		).toBe(true);
	});
});

describe("buildReply", () => {
	it("prefixes the target mention and stays within 300 chars", () => {
		const reply = buildReply("chisei", "neko", "もぐもぐ");
		expect(reply.startsWith("@neko ")).toBe(true);
		expect(reply.length).toBeLessThanOrEqual(300);
	});
});

describe("parseOptCommand", () => {
	it("detects opt-out command with mention", () => {
		expect(
			parseOptCommand(
				{
					id: "1",
					content: "@chisei 学習禁止",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "2",
					content: "学習禁止 @chisei",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "3",
					content: "学習禁止！",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "chisei" }],
				},
				"chisei",
			),
		).toBe("opt_out");
		expect(
			parseOptCommand(
				{
					id: "4",
					content: "@chisei オプトアウト",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_out");
	});

	it("detects opt-in command with mention", () => {
		expect(
			parseOptCommand(
				{
					id: "5",
					content: "@chisei 学習許可",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_in");
		expect(
			parseOptCommand(
				{
					id: "6",
					content: "学習許可 @chisei",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBe("opt_in");
		expect(
			parseOptCommand(
				{
					id: "7",
					content: "学習再開",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "chisei" }],
				},
				"chisei",
			),
		).toBe("opt_in");
	});

	it("returns null for non-command posts", () => {
		expect(
			parseOptCommand(
				{
					id: "8",
					content: "@chisei 今日はいい天気ですね",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBeNull();
		expect(
			parseOptCommand(
				{
					id: "9",
					content: "学習禁止",
					author: { id: "u1", username: "u" },
					mentions: [{ username: "other" }],
				},
				"chisei",
			),
		).toBeNull();
		expect(
			parseOptCommand(
				{
					id: "10",
					content: "@chisei 学習禁止についてどう思う？",
					author: { id: "u1", username: "u" },
				},
				"chisei",
			),
		).toBeNull();
	});
});

describe("formatBio", () => {
	it("formats bio text correctly with word count", () => {
		const bio = formatBio(42);
		expect(bio).toContain("覚えた言葉: 42");
		expect(bio).toContain('"(メンション) 学習禁止"でブラックリスト登録');
		expect(bio).toContain('"(メンション) 学習許可"でブラックリストから除外');
	});

	it("appends the last-updated timestamp in JST slash format", () => {
		const bio = formatBio(284, new Date("2012-04-04T03:34:56.000Z"));
		expect(bio).toContain("覚えた言葉: 284");
		expect(bio).toContain("(最終更新: 2012/04/04 12:34:56)");
	});

	it("omits the timestamp line when never learned", () => {
		expect(formatBio(0, null)).not.toContain("最終更新");
		expect(formatBio(0)).not.toContain("最終更新");
	});

	it("formats timestamps as JST slash dates", () => {
		expect(formatTimestamp(new Date("2012-04-04T03:34:56.000Z"))).toBe(
			"2012/04/04 12:34:56",
		);
	});
});

describe("MFM parsing and tokenization", () => {
	it("extracts text while stripping MFM decorators, code, mentions, and urls", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const input =
			"こんにちは $[tada 楽しい] @user https://example.com `inline code` **太字**";
		const tokens = await tokenize(input);
		expect(tokens).toContain("こんにちは");
		expect(tokens).toContain("楽しい");
		expect(tokens).toContain("太字");
		expect(tokens).not.toContain("@user");
		expect(tokens).not.toContain("https://example.com");
		expect(tokens).not.toContain("inline");
		expect(tokens).not.toContain("code");
	});

	it("preserves unicode emojis and custom emoji literals", async () => {
		const { tokenize } = await import("./bot/tokenizer.js");
		const input = "猫ちゃん 😊 :custom_cat: $[shake :super_dog:] もぐもぐ";
		const tokens = await tokenize(input);
		expect(tokens).toContain("猫ちゃん");
		expect(tokens).toContain("😊");
		expect(tokens).toContain(":custom_cat:");
		expect(tokens).toContain(":super_dog:");
		expect(tokens).not.toContain("custom_cat"); // Should not be disassembled
	});
});

describe("MarkovModel", () => {
	it("generates tokens after learning", () => {
		const model = new MarkovModel();
		model.ingest(["今日", "は", "いい", "天気"]);
		model.ingest(["今日", "は", "ごはん"]);
		const out = model.generate(["今日"]);
		expect(out.length).toBeGreaterThan(0);
		expect(out.includes(BOS)).toBe(false);
	});

	it("recombines fragments instead of always reproducing training data", () => {
		const model = new MarkovModel();
		model.ingest(["a", "b", "c", "d"]);
		model.ingest(["x", "b", "z"]);
		const distinct = new Set<string>();
		for (let i = 0; i < 100; i += 1) {
			const out = model.generate([]);
			if (out.length > 0) {
				distinct.add(out.join(" "));
			}
		}
		// Backoff should sometimes join "a b" with "z" (never learned verbatim)
		expect(distinct.size).toBeGreaterThanOrEqual(2);
	});

	it("variety 0 reproduces the single memorized path deterministically", () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			const model = new MarkovModel({ variety: 0, temperature: 1 });
			model.ingest(["a", "b", "c"]);
			expect(model.generate([])).toEqual(["a", "b", "c"]);
		} finally {
			random.mockRestore();
		}
	});
});
