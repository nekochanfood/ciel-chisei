import type { DetailedToken } from "./tokenizer.js";

/**
 * 文型スケルトン (文の「形」) の抽出・選択・スロット充足。
 *
 * 学習文を `助詞は表層・動詞は活用型・名詞はPOSのみ` まで抽象化した
 * コード列として覚え、生成時は頻度重みで文型を選び、各スロットに
 * 品詞・活用型の適合する語彙をはめ込む。既存マルコフ連鎖と併用し、
 * 候補の1系統として `tryGenerate` に供給する。
 */

/** スケルトンコード: "=は" (表層固定) / "名詞" / "動詞:五段" / "副詞" など。 */
export type SkeletonCode = string;

/** 文型として覚える上限スロット数。 */
export const MAX_PATTERN_SLOTS = 12;

/** 充足可能な内容語スロットの POS。 */
const FILLABLE_POS = new Set([
	"名詞",
	"動詞",
	"形容詞",
	"副詞",
	"感動詞",
	"連体詞",
	"接続詞",
]);

/** 表層固定にする付属語 (助詞・助動詞・接頭辞・接尾辞)。 */
const FIXED_POS = new Set(["助詞", "助動詞", "接頭詞", "接尾辞"]);

/** スロット充足に使う語彙索引 (MarkovModel が実装する)。 */
export type PatternVocab = {
	/** 指定 POS の表層トークンと観測数 (detail 不問)。 */
	tokensForPos(pos: string): Array<{ text: string; count: number }>;
	/** 指定 POS・活用型の基本形と観測数 ("*" は全活用型)。 */
	lemmasFor(
		pos: string,
		conjugation: string,
	): Array<{ basic: string; count: number }>;
	/** 基本形＋活用型の観測表層形と観測数 ("*" は全活用型)。 */
	surfacesFor(
		basic: string,
		conjugation: string,
	): Array<{ text: string; count: number }>;
};

function codeFor(token: DetailedToken): SkeletonCode | null {
	if (FIXED_POS.has(token.pos)) {
		return `=${token.text}`;
	}
	if (token.pos === "動詞" || token.pos === "形容詞") {
		return `${token.pos}:${token.conjugation || "*"}`;
	}
	if (FILLABLE_POS.has(token.pos)) {
		return token.pos;
	}
	// 記号・未知語・その他は文型にしない (構造が読めないため)
	return null;
}

/**
 * 形態素列を文型スケルトンに抽象化する。文型にならない文は null。
 * 条件: 2..MAX_PATTERN_SLOTS スロット、内容語スロットを1つ以上含む、
 * すべて表層固定ではない。
 */
export function buildSkeleton(tokens: DetailedToken[]): SkeletonCode[] | null {
	if (tokens.length < 2 || tokens.length > MAX_PATTERN_SLOTS) {
		return null;
	}
	const codes: SkeletonCode[] = [];
	let hasContent = false;
	let hasFillable = false;
	for (const token of tokens) {
		const code = codeFor(token);
		if (!code) {
			return null;
		}
		codes.push(code);
		if (!code.startsWith("=")) {
			hasFillable = true;
			if (
				code === "名詞" ||
				code.startsWith("動詞") ||
				code.startsWith("形容詞") ||
				code === "副詞" ||
				code === "感動詞"
			) {
				hasContent = true;
			}
		}
	}
	if (!hasFillable || !hasContent) {
		return null;
	}
	return codes;
}

/** スケルトンコード列を DB キー化する。 */
export function skeletonKey(codes: SkeletonCode[]): string {
	return JSON.stringify(codes);
}

/** DB キーをコード列に戻す。壊れたキーは null。 */
export function parseSkeletonKey(key: string): SkeletonCode[] | null {
	try {
		const parsed: unknown = JSON.parse(key);
		if (
			Array.isArray(parsed) &&
			parsed.every((item): item is string => typeof item === "string")
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

function weightedPick<T extends { count: number }>(
	items: T[],
	random: () => number,
): T | null {
	let total = 0;
	for (const item of items) {
		total += Math.max(0, item.count);
	}
	if (total <= 0 || items.length === 0) {
		return null;
	}
	let roll = random() * total;
	for (const item of items) {
		roll -= Math.max(0, item.count);
		if (roll <= 0) {
			return item;
		}
	}
	return items.at(-1) ?? null;
}

/**
 * 文型のインメモリ頻度表。永続化は MarkovModel 経由 (markov_patterns)。
 */
export class PatternModel {
	private readonly counts = new Map<string, number>();

	addPattern(codes: SkeletonCode[]): void {
		const key = skeletonKey(codes);
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
	}

	load(rows: Array<{ pattern: string; count: number }>): void {
		this.counts.clear();
		for (const row of rows) {
			if (parseSkeletonKey(row.pattern)) {
				this.counts.set(row.pattern, row.count);
			}
		}
	}

	clear(): void {
		this.counts.clear();
	}

	get patternCount(): number {
		return this.counts.size;
	}

	get totalObservations(): number {
		let total = 0;
		for (const count of this.counts.values()) {
			total += count;
		}
		return total;
	}

	/**
	 * 頻度重みで文型を1つ選ぶ。上限スロット数を超える文型は除外する。
	 */
	pickPattern(
		maxSlots?: number,
		random: () => number = Math.random,
	): SkeletonCode[] | null {
		const limit = maxSlots ?? MAX_PATTERN_SLOTS;
		const candidates: Array<{ codes: SkeletonCode[]; count: number }> = [];
		for (const [key, count] of this.counts) {
			const codes = parseSkeletonKey(key);
			if (!codes || codes.length < 2 || codes.length > limit) {
				continue;
			}
			candidates.push({ codes, count });
		}
		const picked = weightedPick(candidates, random);
		return picked?.codes ?? null;
	}
}

/**
 * 文型の各スロットに語彙をはめて表層トークン列を作る。
 * 活用型の合わない動詞は選ばない。充足できないスロットがあれば null。
 */
export function fillSlots(
	codes: SkeletonCode[],
	seed: string[],
	vocab: PatternVocab,
	random: () => number = Math.random,
): string[] | null {
	const seedSet = new Set(seed);
	const out: string[] = [];
	for (const code of codes) {
		if (code.startsWith("=")) {
			out.push(code.slice(1));
			continue;
		}
		const filled = fillSlot(code, seedSet, vocab, random);
		if (!filled) {
			return null;
		}
		out.push(filled);
	}
	return out;
}

function boosted<T extends { text: string; count: number }>(
	items: T[],
	seedSet: Set<string>,
): T[] {
	return items.map((item) => ({
		...item,
		count: item.count * (seedSet.has(item.text) ? 2 : 1),
	}));
}

function fillSlot(
	code: string,
	seedSet: Set<string>,
	vocab: PatternVocab,
	random: () => number,
): string | null {
	// 動詞・形容詞は活用型の合う基本形を選び、その表層バリエーションを使う。
	// "*" 要求以外は活用型の完全一致が必須 (五段スロットに一段を混ぜない)。
	if (
		code === "動詞" ||
		code === "形容詞" ||
		code.startsWith("動詞:") ||
		code.startsWith("形容詞:")
	) {
		const pos = code.startsWith("形容詞") ? "形容詞" : "動詞";
		const conjugation = code.includes(":") ? (code.split(":")[1] ?? "*") : "*";
		const lemmas = vocab.lemmasFor(pos, conjugation);
		if (lemmas.length === 0) {
			return null;
		}
		const lemmaPick = weightedPick(
			lemmas.map((lemma) => ({
				text: lemma.basic,
				count: lemma.count * (seedSet.has(lemma.basic) ? 2 : 1),
			})),
			random,
		);
		if (!lemmaPick) {
			return null;
		}
		const surfaces = vocab.surfacesFor(lemmaPick.text, conjugation);
		const surfacePick = weightedPick(boosted(surfaces, seedSet), random);
		if (surfacePick) {
			return surfacePick.text;
		}
		// 表層観測がなければ基本形をそのまま使う (終止形相当)
		return lemmaPick.text;
	}
	// 名詞・副詞・感動詞・連体詞・接続詞は同 POS 語彙から抽選
	const pos = code.includes(":") ? (code.split(":")[0] ?? code) : code;
	const candidates = vocab.tokensForPos(pos);
	if (candidates.length === 0) {
		return null;
	}
	return weightedPick(boosted(candidates, seedSet), random)?.text ?? null;
}
