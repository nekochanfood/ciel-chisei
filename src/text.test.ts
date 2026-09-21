import { describe, expect, it } from "vitest";
import {
	buildReply,
	formatBio,
	isMentionForBot,
	parseOptCommand,
} from "./bot/text.js";

const post = {
	id: "1",
	content: "hello @chisei 元気？",
	author: { id: "u1", username: "neko" },
	mentions: [{ username: "chisei" }],
};

describe("text helpers", () => {
	it("detects mentions and exact opt commands", () => {
		expect(isMentionForBot(post, "chisei")).toBe(true);
		expect(
			parseOptCommand({ ...post, content: "@chisei 学習禁止" }, "chisei"),
		).toBe("opt_out");
		expect(
			parseOptCommand({ ...post, content: "@chisei 学習許可" }, "chisei"),
		).toBe("opt_in");
		expect(parseOptCommand(post, "chisei")).toBeNull();
	});

	it("always keeps replies within Ciel's 300 character limit", () => {
		const reply = buildReply("chisei", "neko", "あ".repeat(400));
		expect(reply.startsWith("@neko ")).toBe(true);
		expect(reply.length).toBeLessThanOrEqual(300);
	});

	it("reports the learned vocabulary count", () => {
		expect(formatBio(42)).toContain("覚えた言葉: 42");
	});
});
