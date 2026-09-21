import { describe, expect, it } from "vitest";
import {
	buildSkeleton,
	fillSlots,
	PatternModel,
	type PatternVocab,
	parseSkeletonKey,
	skeletonKey,
} from "./pattern.js";
import type { DetailedToken } from "./tokenizer.js";

function tok(
	text: string,
	pos: string,
	detail = "",
	basicForm = "",
	conjugation = "",
): DetailedToken {
	return { text, pos, detail, basicForm, conjugation };
}

function vocab(): PatternVocab {
	const nouns = [
		{ text: "猫", count: 2 },
		{ text: "犬", count: 1 },
	];
	const surfaces: Record<string, Array<{ text: string; count: number }>> = {
		"走る|五段・ラ行": [
			{ text: "走る", count: 2 },
			{ text: "走っ", count: 1 },
		],
		"食べる|一段": [{ text: "食べ", count: 1 }],
	};
	const lemmas: Record<string, Array<{ basic: string; count: number }>> = {
		"動詞|五段・ラ行": [{ basic: "走る", count: 3 }],
		"動詞|一段": [{ basic: "食べる", count: 1 }],
		"動詞|*": [
			{ basic: "走る", count: 3 },
			{ basic: "食べる", count: 1 },
		],
		"形容詞|*": [],
	};
	return {
		tokensForPos: (pos) => (pos === "名詞" ? nouns : []),
		lemmasFor: (pos, conjugation) => lemmas[`${pos}|${conjugation}`] ?? [],
		surfacesFor: (basic, conjugation) =>
			surfaces[`${basic}|${conjugation}`] ?? [],
	};
}

describe("buildSkeleton", () => {
	it("abstracts particles to surface and verbs to conjugation type", () => {
		expect(
			buildSkeleton([
				tok("猫", "名詞", "一般"),
				tok("が", "助詞", "格助詞"),
				tok("走る", "動詞", "自立", "走る", "五段・ラ行"),
			]),
		).toEqual(["名詞", "=が", "動詞:五段・ラ行"]);
	});

	it("fixes auxiliary verbs to their surface form", () => {
		expect(
			buildSkeleton([
				tok("猫", "名詞", "一般"),
				tok("は", "助詞", "係助詞"),
				tok("元気", "名詞", "形容動詞語幹"),
				tok("だ", "助動詞", "*"),
			]),
		).toEqual(["名詞", "=は", "名詞", "=だ"]);
	});

	it("rejects sentences without content words or fillable slots", () => {
		// 付属語だけ
		expect(
			buildSkeleton([
				tok("て", "助詞", "接続助詞"),
				tok("おります", "助動詞", "*"),
			]),
		).toBeNull();
		// すべて表層固定
		expect(
			buildSkeleton([tok("は", "助詞", "係助詞"), tok("です", "助動詞", "*")]),
		).toBeNull();
	});

	it("rejects unknown words, symbols, and overlong sentences", () => {
		expect(
			buildSkeleton([tok("猫", "名詞", "一般"), tok("???", "unknown")]),
		).toBeNull();
		expect(buildSkeleton([tok("猫", "名詞", "一般")])).toBeNull();
		expect(
			buildSkeleton(
				Array.from({ length: 13 }, () => tok("猫", "名詞", "一般")),
			),
		).toBeNull();
	});
});

describe("skeletonKey", () => {
	it("round-trips code arrays and rejects broken keys", () => {
		const codes = ["名詞", "=が", "動詞:五段・ラ行"];
		expect(parseSkeletonKey(skeletonKey(codes))).toEqual(codes);
		expect(parseSkeletonKey("not json")).toBeNull();
		expect(parseSkeletonKey("[1,2]")).toBeNull();
	});
});

describe("PatternModel", () => {
	it("picks patterns weighted by count within the slot limit", () => {
		const model = new PatternModel();
		model.addPattern(["名詞", "=が", "動詞:五段・ラ行"]);
		model.addPattern(["名詞", "=が", "動詞:五段・ラ行"]);
		model.addPattern(["名詞", "=は", "名詞", "=だ", "x", "x", "x"]);
		expect(model.patternCount).toBe(2);
		// 上限3スロットでは長い文型が除外され、1択になる
		expect(model.pickPattern(3, () => 0.99)).toEqual([
			"名詞",
			"=が",
			"動詞:五段・ラ行",
		]);
		expect(model.pickPattern(1)).toBeNull();
		const empty = new PatternModel();
		expect(empty.pickPattern()).toBeNull();
	});
});

describe("fillSlots", () => {
	it("fills noun and verb slots with matching vocabulary", () => {
		// random 0.99: 名詞は重み2:1で犬、動詞表層は重み2:1で走っ
		expect(
			fillSlots(["名詞", "=が", "動詞:五段・ラ行"], [], vocab(), () => 0.99),
		).toEqual(["犬", "が", "走っ"]);
		// random 0: 名詞は猫
		expect(
			fillSlots(["名詞", "=が", "動詞:五段・ラ行"], [], vocab(), () => 0),
		).toEqual(["猫", "が", "走る"]);
	});

	it("never fills a verb slot with a mismatched conjugation", () => {
		// 一段スロットに五段の走るは入らない。食べるの表層「食べ」が入る
		expect(
			fillSlots(["名詞", "=を", "動詞:一段"], [], vocab(), () => 0),
		).toEqual(["猫", "を", "食べ"]);
	});

	it("returns null when a slot has no vocabulary", () => {
		// 形容詞の語彙なし
		expect(
			fillSlots(["名詞", "=は", "形容詞:*"], [], vocab(), () => 0),
		).toBeNull();
		// 副詞の語彙なし
		expect(fillSlots(["副詞", "=に"], [], vocab(), () => 0)).toBeNull();
	});

	it("boosts seed words when filling slots", () => {
		// seed に猫があると猫が選ばれる (random 0.5 では通常犬)
		expect(
			fillSlots(["名詞", "=が", "動詞:五段・ラ行"], ["猫"], vocab(), () => 0.5),
		).toEqual(["猫", "が", "走る"]);
	});
});
