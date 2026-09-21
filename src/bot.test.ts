import { describe, expect, it, vi } from "vitest";
import { ChiseiBot } from "./bot/chisei.js";
import type { LanguageModel } from "./bot/language.js";
import type { CielClient, Post, User } from "./ciel/client.js";
import type { Db } from "./db.js";

const me: User = {
	id: "bot",
	username: "chisei",
	displayName: "知性bot",
	createdAt: "",
};

describe("ChiseiBot learning", () => {
	it("persists features transactionally and commits them once", async () => {
		const db = {
			learnedPost: {
				createMany: vi.fn().mockResolvedValue({ count: 1 }),
				aggregate: vi.fn().mockResolvedValue({ _max: { learnedAt: null } }),
			},
			$transaction: vi.fn(async (callback) => callback(db)),
		} as unknown as Db;
		const client = { updateBio: vi.fn() } as unknown as CielClient;
		const next = { version: 1, exampleCount: 1 };
		const language = {
			vocabularySize: 0,
			nextState: vi.fn().mockReturnValue(next),
			persistBatch: vi.fn().mockResolvedValue(undefined),
			commitBatch: vi.fn(),
		} as unknown as LanguageModel;
		const bot = new ChiseiBot(db, client, me, language, []);
		const post = {
			id: "self",
			content: "猫は元気！",
			author: me,
			createdAt: "",
		} as Post;

		await bot.handlePost(post);

		expect(language.persistBatch).toHaveBeenCalledOnce();
		expect(language.commitBatch).toHaveBeenCalledOnce();
		expect(db.$transaction).toHaveBeenCalledOnce();
	});
});
