import { describe, expect, it, vi } from "vitest";
import type { Db } from "../db.js";
import {
	DECORATIONS,
	extractSentenceStats,
	FAMILIES,
	LanguageModel,
	TEMPLATES,
} from "./language.js";
import { tokenizeDetailed } from "./tokenizer.js";

function mockDb(saved: unknown = null): Db {
	return {
		lexeme: {
			findMany: vi.fn().mockResolvedValue([
				{
					surface: "猫",
					pos: "名詞",
					detail: "一般",
					basicForm: "猫",
					conjugation: "",
					count: 5,
				},
				{
					surface: "走る",
					pos: "動詞",
					detail: "自立",
					basicForm: "走る",
					conjugation: "五段",
					count: 3,
				},
				{
					surface: "楽しい",
					pos: "形容詞",
					detail: "自立",
					basicForm: "楽しい",
					conjugation: "形容詞",
					count: 3,
				},
				{
					surface: "ゆっくり",
					pos: "副詞",
					detail: "一般",
					basicForm: "ゆっくり",
					conjugation: "",
					count: 2,
				},
			]),
		},
		neuralModel: { findUnique: vi.fn().mockResolvedValue(saved) },
	} as unknown as Db;
}

describe("curated template generation", () => {
	it("ships over 100 reviewed templates with valid placeholders", () => {
		expect(TEMPLATES.length).toBeGreaterThanOrEqual(100);
		for (const template of TEMPLATES) {
			expect(template.text).not.toMatch(
				/\{(?!noun|verb|adjective|adverb)[^}]+\}/,
			);
			expect(FAMILIES).toContain(template.family);
		}
	});

	it("fills templates without leaking placeholders or exceeding the post budget", async () => {
		const model = new LanguageModel();
		await model.load(mockDb());
		const seed = await tokenizeDetailed("猫は楽しい");
		const text = model.generate(
			extractSentenceStats("猫は楽しい", seed, true),
			seed,
			12,
		);
		expect(text.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThanOrEqual(280);
		expect(text).not.toMatch(/[{}]/);
	});
});

describe("sentence features and neural ranker", () => {
	it("recognizes decorations without treating domains or lexical grass as slang", async () => {
		const laugh = await tokenizeDetailed("それは草www！");
		const style = extractSentenceStats("それは草www！", laugh, true);
		expect(style.hasGrass).toBe(true);
		expect(style.hasWww).toBe(true);
		expect(style.family).toBe("amused");
		expect(laugh.map((token) => token.text)).not.toContain("草");

		const lexical = await tokenizeDetailed("草を刈る");
		expect(extractSentenceStats("草を刈る", lexical, false).hasGrass).toBe(
			false,
		);
		expect(lexical.map((token) => token.text)).toContain("草");
		expect(
			extractSentenceStats("www.example.com を見る", lexical, false).hasWww,
		).toBe(false);
		expect(extractSentenceStats("草", [], false).hasGrass).toBe(true);
	});

	it("raises compatibility for repeatedly observed positive style", async () => {
		const model = new LanguageModel();
		await model.load(mockDb());
		const tokens = await tokenizeDetailed("それは草www");
		const stats = extractSentenceStats("それは草www", tokens, true);
		const candidate = {
			family: stats.family,
			lengthBucket: stats.lengthBucket,
			decoration: stats.decoration,
			seedOverlap: 1,
		};
		const next = model.nextState(Array(40).fill(stats));
		model.commitBatch([], next);
		const negative = {
			...candidate,
			family: "question" as const,
			decoration: "question" as const,
			seedOverlap: 0,
		};
		expect(model.compatibility(stats, candidate)).toBeGreaterThan(
			model.compatibility(stats, negative),
		);
		expect(DECORATIONS).toContain(stats.decoration);
	});

	it("persists interpretable features and reloadable network weights", async () => {
		const model = new LanguageModel();
		await model.load(mockDb());
		const tokens = await tokenizeDetailed("猫は楽しい！");
		const stats = extractSentenceStats("猫は楽しい！", tokens, false);
		const state = model.nextState([stats]);
		const neuralModel = { upsert: vi.fn().mockResolvedValue({}) };
		const tx = {
			lexeme: { upsert: vi.fn().mockResolvedValue({}) },
			sentenceFeature: { create: vi.fn().mockResolvedValue({}) },
			neuralModel,
		};
		await model.persistBatch(
			tx as never,
			"post",
			"author",
			[{ tokens, stats }],
			state,
		);
		expect(tx.sentenceFeature.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				postId: "post",
				features: expect.objectContaining({ hasExclamation: true }),
			}),
		});
		const saved = neuralModel.upsert.mock.calls[0]?.[0].create;
		const reloaded = new LanguageModel();
		await reloaded.load(mockDb(saved));
		expect(reloaded.exampleCount).toBe(1);
	});
});
