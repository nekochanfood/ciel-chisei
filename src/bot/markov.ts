import { createHash } from "node:crypto";
import type { Db, DbTransaction } from "../db.js";
import {
	fillSlots,
	PatternModel,
	type SkeletonCode,
	skeletonKey,
} from "./pattern.js";
import { BOS, EOS } from "./tokenizer.js";

export type PosTag = {
	pos: string;
	detail: string;
	basicForm?: string;
	conjugation?: string;
};

export type MarkovOptions = {
	/** >1 flattens the distribution (more surprising picks). */
	temperature: number;
	/** Multiplier for tokens appearing in the conversation seed. */
	seedBoost: number;
	/** Additive weight per count of the author's own transitions. */
	userBoost: number;
	/** 0..1 overall novelty: drives bigram backoff + early stopping. 0 = deterministic reproduction. */
	variety: number;
	/** Maximum tokens per utterance. */
	maxTokens: number;
	/** Generation retries when the candidate is a banned verbatim sequence. */
	maxAttempts: number;
	/** A candidate containing this many consecutive learned tokens is rejected. */
	maxVerbatimNgram: number;
	/** Reject outputs that reproduce learned sentences (disabled when variety is 0). */
	preventVerbatim: boolean;
};

const DEFAULT_OPTIONS: MarkovOptions = {
	temperature: 1.8,
	seedBoost: 2,
	userBoost: 3,
	variety: 0.8,
	maxTokens: 24,
	maxAttempts: 5,
	maxVerbatimNgram: 4,
	preventVerbatim: true,
};

/** 文末に許される助詞の細分類 (終助詞・副助詞・間投助詞以外は文が続くはずなので ban)。 */
const PARTICLE_END_OK = new Set(["終助詞", "副助詞", "間投助詞"]);

/** 部分丸暗記検出に使う最大 N-gram 長 (長文用に 4..12 を記録する)。 */
const MAX_BANNED_NGRAM = 12;

/** 品詞カテゴリ別の文末適格判定。false = そのトークンで終わると不自然な断片になる。 */
export function isBadEndingTag(pos: string, detail: string): boolean {
	switch (pos) {
		case "助詞":
			return detail !== "" && !PARTICLE_END_OK.has(detail);
		case "接続詞":
		case "接頭詞":
		case "連体詞":
		case "記号":
			return true;
		default:
			return false;
	}
}

/**
 * 自立語: 単独でも意味を持つ品詞。発話には最低1つ必要。
 * 「ております」のような付属語だけの切り抜きはここで弾く。
 */
export const CONTENT_POS = new Set([
	"名詞",
	"動詞",
	"形容詞",
	"副詞",
	"感動詞",
	"連体詞",
]);

/** 単独1トークン発話として許す品詞(連体詞は単独不可なので除外)。 */
export const STANDALONE_POS = new Set([
	"名詞",
	"動詞",
	"形容詞",
	"副詞",
	"感動詞",
]);

/** 品詞カテゴリ別の文頭適格判定。false = 文頭に立ちにくい (助詞・助動詞・接尾辞など)。 */
export function isBadStartTag(pos: string, detail = ""): boolean {
	switch (pos) {
		case "助詞":
		case "助動詞":
		case "接頭詞":
		case "接尾辞":
		case "記号":
			return true;
		case "名詞":
			// 「ちゃん」「さん」などの接尾単独始まりを避ける
			return detail === "接尾";
		default:
			return false;
	}
}

function sequenceKey(tokens: string[]): string {
	return JSON.stringify(tokens);
}

function parseSequenceKey(text: string): string[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export function hashSequence(tokens: string[]): string {
	return createHash("sha256").update(sequenceKey(tokens), "utf8").digest("hex");
}

export class MarkovModel {
	private readonly options: MarkovOptions;
	private readonly globalEdges = new Map<string, Map<string, number>>();
	private readonly userEdges = new Map<
		string,
		Map<string, Map<string, number>>
	>();
	private readonly startTokens = new Set<string>();
	private readonly endTokens = new Set<string>();
	/** 学習文全体のキー集合 (verbatim 検出用)。 */
	private readonly sequences = new Set<string>();
	/** 学習文に現れる連続 N-gram の集合 (部分的な丸暗記検出用)。 */
	private readonly bannedNgrams = new Set<string>();
	/** トークンごとの品詞観測数: token -> "pos\t detail" -> count */
	private readonly tokenPos = new Map<string, Map<string, number>>();
	/** POS 逆引き索引: pos -> token -> count (文型スロット充足用) */
	private readonly posIndex = new Map<string, Map<string, number>>();
	/**
	 * 活用形索引: "pos\tbasic\tconjugation" -> 表層 -> count。
	 * 動詞スロットに活用型の合う語彙をはめるために使う。
	 */
	private readonly verbForms = new Map<string, Map<string, number>>();
	/** 文型スケルトンの頻度表 (文の「形」の記憶)。 */
	private readonly patterns = new PatternModel();

	constructor(options: Partial<MarkovOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	async load(db: Db): Promise<void> {
		this.globalEdges.clear();
		this.userEdges.clear();
		this.startTokens.clear();
		this.endTokens.clear();
		this.sequences.clear();
		this.bannedNgrams.clear();
		this.tokenPos.clear();
		this.posIndex.clear();
		this.verbForms.clear();
		this.patterns.clear();
		const [edges, labels, sequences, posRows, formRows, patternRows] =
			await Promise.all([
				db.markovEdge.findMany(),
				db.markovTokenLabel.findMany(),
				db.markovSequence.findMany(),
				db.markovTokenPos.findMany(),
				db.markovTokenForm.findMany(),
				db.markovPattern.findMany(),
			]);
		for (const edge of edges) {
			this.addEdge(edge.prefix, edge.nextToken, edge.authorId, edge.count);
		}
		for (const label of labels) {
			if (label.canStart) this.startTokens.add(label.token);
			if (label.canEnd) this.endTokens.add(label.token);
		}
		for (const sequence of sequences) {
			this.addSequence(parseSequenceKey(sequence.text));
		}
		for (const row of posRows) {
			this.addPos(row.token, row.pos, row.detail, row.count);
		}
		for (const row of formRows) {
			this.addForm(
				row.token,
				row.pos,
				row.basicForm,
				row.conjugation,
				row.count,
			);
		}
		this.patterns.load(patternRows);
	}

	get edgeCount(): number {
		let total = 0;
		for (const nexts of this.globalEdges.values()) {
			total += nexts.size;
		}
		return total;
	}

	get sequenceCount(): number {
		return this.sequences.size;
	}

	canStart(token: string): boolean {
		return this.startTokens.has(token);
	}

	canEnd(token: string): boolean {
		return this.endTokens.has(token);
	}

	/** 最頻出の品詞タグを返す。未観測なら undefined (制限なし扱い)。 */
	dominantPosTag(token: string): PosTag | undefined {
		const counts = this.tokenPos.get(token);
		if (!counts || counts.size === 0) {
			return undefined;
		}
		let best = "";
		let bestCount = -1;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				bestCount = count;
				best = key;
			}
		}
		const tab = best.indexOf("\t");
		return {
			pos: tab < 0 ? best : best.slice(0, tab),
			detail: tab < 0 ? "" : best.slice(tab + 1),
		};
	}

	/** 文末として自然かどうか (品詞カテゴリで判定、未知語は許容)。 */
	isGoodEnding(token: string): boolean {
		const tag = this.dominantPosTag(token);
		if (!tag || tag.pos === "emoji" || tag.pos === "unknown") {
			return true;
		}
		return !isBadEndingTag(tag.pos, tag.detail);
	}

	/** 文頭として自然かどうか (品詞カテゴリで判定、未知語は許容)。 */
	isGoodStart(token: string): boolean {
		const tag = this.dominantPosTag(token);
		if (!tag || tag.pos === "emoji" || tag.pos === "unknown") {
			return true;
		}
		return !isBadStartTag(tag.pos, tag.detail);
	}

	/**
	 * 1トークン単独発話として許すか。「ております」のような
	 * 助動詞・助詞の単独使用は調教として禁じる。未知語は許容。
	 */
	isStandaloneOk(token: string): boolean {
		const tag = this.dominantPosTag(token);
		if (!tag || tag.pos === "emoji" || tag.pos === "unknown") {
			return true;
		}
		return STANDALONE_POS.has(tag.pos);
	}

	/**
	 * 学習文の丸暗記かどうか (完全一致 or 長い連続一致)。
	 * 長文は短い一致では丸暗記とみなさない (要求長の1/5以上にスケール、
	 * 上限12)。短文時は従来通り maxVerbatimNgram。
	 */
	isBannedSequence(tokens: string[]): boolean {
		if (tokens.length === 0) {
			return false;
		}
		if (this.sequences.has(sequenceKey(tokens))) {
			return true;
		}
		const n = Math.min(
			MAX_BANNED_NGRAM,
			Math.max(this.options.maxVerbatimNgram, Math.floor(tokens.length / 5)),
		);
		if (tokens.length >= n) {
			for (let i = 0; i + n <= tokens.length; i += 1) {
				if (this.bannedNgrams.has(sequenceKey(tokens.slice(i, i + n)))) {
					return true;
				}
			}
		}
		return false;
	}

	ingest(
		tokens: string[],
		authorId = "",
		tags: PosTag[] = [],
	): Array<{ prefix: string; next: string }> {
		const edges = this.buildEdges(tokens);
		for (const { prefix, next } of edges) {
			this.addEdge(prefix, next, authorId, 1);
		}
		this.addSequence(tokens);
		for (let i = 0; i < tokens.length; i += 1) {
			const tag = tags[i];
			if (tag) {
				const token = tokens[i] as string;
				this.addPos(token, tag.pos, tag.detail, 1);
				if (tag.basicForm || tag.conjugation) {
					this.addForm(
						token,
						tag.pos,
						tag.basicForm ?? "",
						tag.conjugation ?? "",
						1,
					);
				}
			}
		}
		return edges;
	}

	async persist(
		db: DbTransaction,
		tokens: string[],
		authorId = "",
		tags: PosTag[] = [],
	): Promise<void> {
		if (tokens.length === 0) return;
		const edges = this.buildEdges(tokens);
		for (const edge of edges) {
			await db.markovEdge.upsert({
				where: {
					authorId_prefix_nextToken: {
						authorId,
						prefix: edge.prefix,
						nextToken: edge.next,
					},
				},
				create: { authorId, prefix: edge.prefix, nextToken: edge.next },
				update: { count: { increment: 1 } },
			});
		}
		const first = tokens[0] as string;
		const last = tokens.at(-1) as string;
		await db.markovTokenLabel.upsert({
			where: { token: first },
			create: { token: first, canStart: true, canEnd: first === last },
			update: { canStart: true, ...(first === last ? { canEnd: true } : {}) },
		});
		if (last !== first) {
			await db.markovTokenLabel.upsert({
				where: { token: last },
				create: { token: last, canEnd: true },
				update: { canEnd: true },
			});
		}
		const hash = hashSequence(tokens);
		await db.markovSequence.upsert({
			where: { hash },
			create: { hash, text: sequenceKey(tokens) },
			update: { count: { increment: 1 } },
		});
		for (let i = 0; i < tokens.length; i += 1) {
			const tag = tags[i];
			if (!tag) {
				continue;
			}
			const token = tokens[i] as string;
			await db.markovTokenPos.upsert({
				where: {
					token_pos_detail: { token, pos: tag.pos, detail: tag.detail },
				},
				create: { token, pos: tag.pos, detail: tag.detail },
				update: { count: { increment: 1 } },
			});
			const basicForm = tag.basicForm ?? "";
			const conjugation = tag.conjugation ?? "";
			if (
				(tag.pos === "動詞" || tag.pos === "形容詞") &&
				(basicForm || conjugation)
			) {
				await db.markovTokenForm.upsert({
					where: {
						token_pos_basicForm_conjugation: {
							token,
							pos: tag.pos,
							basicForm,
							conjugation,
						},
					},
					create: { token, pos: tag.pos, basicForm, conjugation },
					update: { count: { increment: 1 } },
				});
			}
		}
	}

	/** 文型スケルトンを記憶する (インメモリ)。 */
	ingestPattern(codes: SkeletonCode[]): void {
		this.patterns.addPattern(codes);
	}

	/** 文型スケルトンを DB に保存する。 */
	async persistPattern(
		tx: DbTransaction,
		codes: SkeletonCode[],
	): Promise<void> {
		const pattern = skeletonKey(codes);
		await tx.markovPattern.upsert({
			where: { pattern },
			create: { pattern },
			update: { count: { increment: 1 } },
		});
	}

	get patternCount(): number {
		return this.patterns.patternCount;
	}

	/**
	 * 文型を1つ選んでスロット充足する。文型未学習・充足不可なら []。
	 * tryGenerate の候補源の1系統として使う。
	 */
	generateFromPattern(seedTokens: string[] = [], maxTokens?: number): string[] {
		const codes = this.patterns.pickPattern(maxTokens);
		if (!codes) {
			return [];
		}
		return fillSlots(codes, seedTokens, this) ?? [];
	}

	/** PatternVocab: 指定 POS の表層トークンと観測数。 */
	tokensForPos(pos: string): Array<{ text: string; count: number }> {
		const bucket = this.posIndex.get(pos);
		if (!bucket) {
			return [];
		}
		return [...bucket].map(([text, count]) => ({ text, count }));
	}

	/** PatternVocab: 指定 POS・活用型の基本形と観測数。 */
	lemmasFor(
		pos: string,
		conjugation: string,
	): Array<{ basic: string; count: number }> {
		const byBasic = new Map<string, number>();
		for (const [key, surfaces] of this.verbForms) {
			const tab = key.indexOf("\t");
			const entryPos = key.slice(0, tab);
			const rest = key.slice(tab + 1);
			const tab2 = rest.indexOf("\t");
			const basic = rest.slice(0, tab2);
			const entryConj = rest.slice(tab2 + 1);
			if (entryPos !== pos) {
				continue;
			}
			if (conjugation !== "*" && entryConj !== conjugation) {
				continue;
			}
			let total = 0;
			for (const count of surfaces.values()) {
				total += count;
			}
			byBasic.set(basic, (byBasic.get(basic) ?? 0) + total);
		}
		return [...byBasic].map(([basic, count]) => ({ basic, count }));
	}

	/** PatternVocab: 基本形＋活用型の観測表層形と観測数。 */
	surfacesFor(
		basic: string,
		conjugation: string,
	): Array<{ text: string; count: number }> {
		const out: Array<{ text: string; count: number }> = [];
		for (const [key, surfaces] of this.verbForms) {
			const tab = key.indexOf("\t");
			const rest = key.slice(tab + 1);
			const tab2 = rest.indexOf("\t");
			if (rest.slice(0, tab2) !== basic) {
				continue;
			}
			if (conjugation !== "*" && rest.slice(tab2 + 1) !== conjugation) {
				continue;
			}
			for (const [text, count] of surfaces) {
				out.push({ text, count });
			}
		}
		return out;
	}

	generate(
		seedTokens: string[] = [],
		authorId?: string,
		maxTokens?: number,
	): string[] {
		if (this.globalEdges.size === 0) {
			return [];
		}
		const limit = maxTokens ?? this.options.maxTokens;
		const guardVerbatim =
			this.options.preventVerbatim && this.options.variety > 0;
		// 長文生成は ban に当たりやすい分だけ試行を増やす
		const attempts =
			limit > DEFAULT_OPTIONS.maxTokens
				? this.options.maxAttempts * 2
				: this.options.maxAttempts;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const output = this.generateOnce(seedTokens, authorId, limit);
			if (output.length === 0) {
				continue;
			}
			if (guardVerbatim && this.isBannedSequence(output)) {
				continue;
			}
			return output;
		}
		return [];
	}

	private generateOnce(
		seedTokens: string[],
		authorId: string | undefined,
		maxTokens: number,
	): string[] {
		let prefix = this.randomStartPrefix(seedTokens);
		// 長文生成では切り上げ確率を抑え、短文時の挙動は変えない
		const stopProbability =
			maxTokens > DEFAULT_OPTIONS.maxTokens
				? 0.35 * this.options.variety * (DEFAULT_OPTIONS.maxTokens / maxTokens)
				: 0.35 * this.options.variety;
		const output: string[] = [];
		for (let i = 0; i < maxTokens; i += 1) {
			const next = this.pickNext(prefix, seedTokens, authorId);
			if (!next || next === EOS) {
				break;
			}
			output.push(next);
			// Random early stop breaks verbatim reproduction of long
			// memorized passages while keeping short replies intact.
			// 助詞などで終わる断片は避ける (品詞カテゴリで判定)。
			if (
				output.length >= 3 &&
				this.canEnd(next) &&
				this.isGoodEnding(next) &&
				Math.random() < stopProbability
			) {
				break;
			}
			const parts: string[] = prefix.split("\t");
			prefix = `${parts[1] ?? BOS}\t${next}`;
		}
		const last = output.at(-1);
		if (
			output.length > 0 &&
			last &&
			this.canEnd(last) &&
			this.isGoodEnding(last)
		) {
			// 単独1トークンが助動詞・助詞だけ (「ております」等) なら捨てる
			if (output.length === 1 && !this.isStandaloneOk(last)) {
				return [];
			}
			return output;
		}
		return [];
	}

	/**
	 * たまに BOS,BOS 固定開始をやめ、文頭らしいトークンから始める。
	 * 同じ書き出しの繰り返し (定型のオウム返し) を崩す。
	 */
	private randomStartPrefix(seedTokens: string[]): string {
		const fixed = `${BOS}\t${BOS}`;
		const variety = this.options.variety;
		if (variety <= 0 || this.startTokens.size === 0) {
			return fixed;
		}
		if (Math.random() >= 0.5 * variety) {
			return fixed;
		}
		const seedSet = new Set(seedTokens);
		const starts = [...this.startTokens].filter(
			(token) => token !== BOS && token !== EOS,
		);
		if (starts.length === 0) {
			return fixed;
		}
		const good = starts.filter((token) => this.isGoodStart(token));
		const pool = good.length > 0 ? good : starts;
		const seeded = pool.filter((token) => seedSet.has(token));
		const candidates = seeded.length > 0 ? seeded : pool;
		const pick = candidates[Math.floor(Math.random() * candidates.length)];
		if (!pick) {
			return fixed;
		}
		return `${BOS}\t${pick}`;
	}

	private addEdge(
		prefix: string,
		next: string,
		authorId = "",
		count = 1,
	): void {
		if (prefix === `${BOS}\t${BOS}` && next !== EOS) {
			this.startTokens.add(next);
		}
		if (next === EOS) {
			const last = prefix.split("\t")[1];
			if (last && last !== BOS) this.endTokens.add(last);
		}
		// Global edges
		const nexts = this.globalEdges.get(prefix) ?? new Map<string, number>();
		nexts.set(next, (nexts.get(next) ?? 0) + count);
		this.globalEdges.set(prefix, nexts);

		// User specific edges
		if (authorId) {
			const userMap =
				this.userEdges.get(authorId) ?? new Map<string, Map<string, number>>();
			const userNexts = userMap.get(prefix) ?? new Map<string, number>();
			userNexts.set(next, (userNexts.get(next) ?? 0) + count);
			userMap.set(prefix, userNexts);
			this.userEdges.set(authorId, userMap);
		}
	}

	private addSequence(tokens: string[]): void {
		if (tokens.length === 0) {
			return;
		}
		this.sequences.add(sequenceKey(tokens));
		for (let n = this.options.maxVerbatimNgram; n <= MAX_BANNED_NGRAM; n += 1) {
			for (let i = 0; i + n <= tokens.length; i += 1) {
				this.bannedNgrams.add(sequenceKey(tokens.slice(i, i + n)));
			}
		}
	}

	private addPos(
		token: string,
		pos: string,
		detail: string,
		count: number,
	): void {
		const counts = this.tokenPos.get(token) ?? new Map<string, number>();
		const key = `${pos}\t${detail}`;
		counts.set(key, (counts.get(key) ?? 0) + count);
		this.tokenPos.set(token, counts);
		const bucket = this.posIndex.get(pos) ?? new Map<string, number>();
		bucket.set(token, (bucket.get(token) ?? 0) + count);
		this.posIndex.set(pos, bucket);
	}

	/**
	 * 活用形の観測を記録する。動詞・形容詞のみ対象
	 * (助動詞「です」「ます」等を動詞スロットに混ぜない)。
	 * verbForms のキーは "pos\tbasic\tconjugation"。
	 */
	private addForm(
		token: string,
		pos: string,
		basicForm: string,
		conjugation: string,
		count: number,
	): void {
		if (pos !== "動詞" && pos !== "形容詞") {
			return;
		}
		const key = `${pos}\t${basicForm || token}\t${conjugation}`;
		const surfaces = this.verbForms.get(key) ?? new Map<string, number>();
		surfaces.set(token, (surfaces.get(token) ?? 0) + count);
		this.verbForms.set(key, surfaces);
	}

	private buildEdges(
		tokens: string[],
	): Array<{ prefix: string; next: string }> {
		if (tokens.length === 0) return [];
		const padded = [BOS, BOS, ...tokens, EOS];
		return tokens
			.map((_, index) => ({
				prefix: `${padded[index]}\t${padded[index + 1]}`,
				next: padded[index + 2] ?? EOS,
			}))
			.concat({
				prefix: `${padded[tokens.length]}\t${padded[tokens.length + 1]}`,
				next: EOS,
			});
	}

	private pickNext(
		prefix: string,
		seedTokens: string[],
		authorId?: string,
	): string | undefined {
		const backoffRate = 0.9 * this.options.variety;
		let globalNexts = this.globalEdges.get(prefix);
		let userNexts = authorId
			? this.userEdges.get(authorId)?.get(prefix)
			: undefined;

		// Bigram backoff: when the trigram prefix has few continuations
		// (the common case in a small corpus), sometimes recombine via
		// all transitions sharing the last token instead of walking the
		// single memorized path.
		if (
			(!globalNexts || globalNexts.size <= 2) &&
			Math.random() < backoffRate
		) {
			const fallback = this.bigramFallback(prefix, authorId);
			if (fallback.global.size > 0) {
				globalNexts = fallback.global;
				userNexts = fallback.user;
			}
		}
		if (!globalNexts || globalNexts.size === 0) {
			return undefined;
		}

		const seedSet = new Set(seedTokens);
		const weighted: Array<{ token: string; weight: number }> = [];
		// 文頭選択時は助詞始まり (「が…」「は…」) を避ける。
		// hard ban ではなく減重に留め、空出力の増加を防ぐ。
		const atStart = (prefix.split("\t")[0] ?? "") === BOS;

		for (const [token, count] of globalNexts) {
			let weight = count;
			// Boost tokens if in conversation seed
			if (seedSet.has(token)) {
				weight *= this.options.seedBoost;
			}
			// Boost if this specific user used this transition
			if (userNexts?.has(token)) {
				weight += (userNexts.get(token) ?? 0) * this.options.userBoost;
			}
			// Temperature flattens the distribution so rare alternatives
			// surface instead of always taking the memorized winner.
			let finalWeight = weight ** (1 / this.options.temperature);
			if (atStart && !this.isGoodStart(token)) {
				finalWeight *= 0.15;
			}
			weighted.push({ token, weight: finalWeight });
		}

		const total = weighted.reduce((sum, item) => sum + item.weight, 0);
		let roll = Math.random() * total;
		for (const item of weighted) {
			roll -= item.weight;
			if (roll <= 0) {
				return item.token;
			}
		}
		return weighted.at(-1)?.token;
	}

	/**
	 * Aggregate every known transition whose prefix ends with the same
	 * token, i.e. order-1 view derived from the trigram table.
	 * Needs no schema change: it is computed from loaded edges.
	 */
	private bigramFallback(
		prefix: string,
		authorId?: string,
	): { global: Map<string, number>; user?: Map<string, number> } {
		const last = prefix.split("\t")[1] ?? BOS;
		const global = new Map<string, number>();
		for (const [key, nexts] of this.globalEdges) {
			if (key.split("\t")[1] !== last) {
				continue;
			}
			for (const [token, count] of nexts) {
				global.set(token, (global.get(token) ?? 0) + count);
			}
		}
		let user: Map<string, number> | undefined;
		if (authorId) {
			const userMap = this.userEdges.get(authorId);
			if (userMap) {
				user = new Map<string, number>();
				for (const [key, nexts] of userMap) {
					if (key.split("\t")[1] !== last) {
						continue;
					}
					for (const [token, count] of nexts) {
						user.set(token, (user.get(token) ?? 0) + count);
					}
				}
				if (user.size === 0) {
					user = undefined;
				}
			}
		}
		return { global, user };
	}
}
