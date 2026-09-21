import type { Db, DbTransaction } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { DetailedToken } from "./tokenizer.js";

const MODEL_ID = "template-ranker";
const MODEL_VERSION = 1;
const HIDDEN_SIZE = 16;
const LEARNING_RATE = 0.03;
const CANDIDATE_COUNT = 24;

export const FAMILIES = [
	"statement",
	"reaction",
	"question",
	"agreement",
	"desire",
	"amused",
] as const;
export type Family = (typeof FAMILIES)[number];

export const DECORATIONS = [
	"none",
	"period",
	"bang",
	"question",
	"mixed",
	"ellipsis",
	"wave",
	"www",
	"grass",
	"paren",
	"quote",
] as const;
export type Decoration = (typeof DECORATIONS)[number];

const POS_KEYS = ["名詞", "動詞", "形容詞", "副詞", "感動詞", "other"] as const;
const LENGTH_BUCKETS = 4;
const INPUT_SIZE =
	FAMILIES.length +
	LENGTH_BUCKETS +
	POS_KEYS.length +
	DECORATIONS.length +
	1 +
	FAMILIES.length +
	LENGTH_BUCKETS +
	DECORATIONS.length +
	1 +
	4;

export type SentenceStats = {
	tokenCount: number;
	charCount: number;
	lengthBucket: number;
	posCounts: Record<string, number>;
	startPos: string;
	endPos: string;
	family: Family;
	decoration: Decoration;
	isReply: boolean;
	hasQuestion: boolean;
	hasExclamation: boolean;
	hasEllipsis: boolean;
	hasWave: boolean;
	hasWww: boolean;
	hasGrass: boolean;
};

type Slot = "noun" | "verb" | "adjective" | "adverb";
export type Template = {
	id: string;
	family: Family;
	text: string;
	slot?: Slot;
};

function group(
	prefix: string,
	family: Family,
	slot: Slot | undefined,
	texts: string[],
): Template[] {
	return texts.map((text, index) => ({
		id: `${prefix}-${index + 1}`,
		family,
		text,
		slot,
	}));
}

export const TEMPLATES: Template[] = [
	...group("noun-reaction", "reaction", "noun", [
		"{noun}、強い",
		"{noun}、えらい",
		"{noun}、最高では",
		"{noun}、じわじわくる",
		"{noun}で笑った",
		"{noun}はずるい",
		"{noun}が全部持ってった",
		"{noun}が来た",
		"{noun}の予感",
		"{noun}の時間だ",
	]),
	...group("noun-agreement", "agreement", "noun", [
		"{noun}、わかる",
		"{noun}っていいよね",
		"{noun}はあり",
		"{noun}は全然あり",
		"{noun}は大事",
		"{noun}なら仕方ない",
		"{noun}、そういう日もある",
		"{noun}は正義",
		"{noun}、ほんとそれ",
		"{noun}しか勝たん",
	]),
	...group("noun-statement", "statement", "noun", [
		"{noun}、ちょっと気になる",
		"{noun}について考えてる",
		"{noun}のこと忘れられん",
		"{noun}を見守りたい",
		"{noun}が必要",
		"{noun}を信じろ",
		"{noun}に期待",
		"{noun}、応援してる",
		"{noun}、大切にしよ",
		"{noun}の話もっと聞きたい",
	]),
	...group("noun-question", "question", "noun", [
		"{noun}って実際どうなん",
		"{noun}、どう思う",
		"{noun}はどこから来たん",
		"{noun}ってありなん",
		"{noun}、今どうなってる",
		"{noun}のおすすめある",
		"{noun}って楽しい",
		"{noun}は元気",
		"{noun}、気にならん",
		"{noun}の話する",
	]),
	...group("noun-desire", "desire", "noun", [
		"{noun}、かなり好き",
		"{noun}ほしい",
		"{noun}をもっと見たい",
		"{noun}を待ってる",
		"{noun}と暮らしたい",
		"{noun}を大事にしたい",
		"{noun}を眺めてたい",
		"{noun}の続きが見たい",
	]),
	...group("verb-statement", "statement", "verb", [
		"とりあえず{verb}",
		"今日は{verb}",
		"また{verb}",
		"ずっと{verb}",
		"ちゃんと{verb}",
		"静かに{verb}",
		"今から{verb}",
		"そろそろ{verb}",
		"無限に{verb}",
		"ゆっくり{verb}",
		"ひとまず{verb}",
		"迷わず{verb}",
	]),
	...group("verb-reaction", "reaction", "verb", [
		"{verb}しかない",
		"{verb}のもあり",
		"{verb}の大事",
		"{verb}とするか",
		"{verb}ぞ",
		"{verb}だけでえらい",
		"{verb}の、わかる",
		"{verb}ってことか",
		"{verb}の楽しそう",
		"{verb}のいいな",
		"{verb}の強い",
		"{verb}の天才",
		"{verb}の助かる",
		"{verb}の待ってる",
	]),
	...group("verb-question", "question", "verb", [
		"{verb}のどうなん",
		"{verb}ってあり",
		"今から{verb}",
		"一緒に{verb}",
	]),
	...group("adj-reaction", "reaction", "adjective", [
		"それ{adjective}",
		"かなり{adjective}",
		"普通に{adjective}",
		"思ったより{adjective}",
		"めっちゃ{adjective}",
		"ちょっと{adjective}",
		"今日も{adjective}",
		"ずっと{adjective}",
		"なんか{adjective}",
		"だいぶ{adjective}",
		"それは{adjective}",
		"たしかに{adjective}",
	]),
	...group("adj-agreement", "agreement", "adjective", [
		"{adjective}のわかる",
		"{adjective}ならあり",
		"{adjective}って強い",
		"{adjective}のいいな",
		"{adjective}だけで十分",
		"{adjective}気がする",
		"{adjective}の好き",
		"{adjective}の、よい",
		"{adjective}かも",
		"{adjective}の正義",
	]),
	...group("adv-statement", "statement", "adverb", [
		"{adverb}やってこ",
		"{adverb}いこう",
		"{adverb}考えよ",
		"{adverb}休も",
		"{adverb}見てる",
		"{adverb}進めよ",
		"{adverb}待とう",
		"{adverb}楽しもう",
		"{adverb}受け止める",
		"{adverb}生きる",
		"{adverb}でいい",
		"{adverb}続けよう",
	]),
	...group("fixed", "reaction", undefined, [
		"それはそう",
		"なるほどね",
		"わかる気がする",
		"まじか",
		"よい話だ",
		"急に来たな",
		"そういう日もある",
		"無理せんでな",
		"今日もえらい",
		"ひとまず休も",
	]),
	...group("fixed-question", "question", undefined, [
		"それってどうなん",
		"もう少し聞いていい",
		"何があったん",
		"今どんな感じ",
		"続きある",
	]),
	...group("fixed-amused", "amused", undefined, [
		"それは笑う",
		"さすがにおもろい",
		"じわじわくる",
		"発想が強い",
		"そうはならんやろ",
	]),
	...group("fixed-desire", "desire", undefined, [
		"もっと見たい",
		"続きが気になる",
		"のんびりしたい",
		"今日は休みたい",
		"いい感じにしたい",
	]),
];

export type CandidateDescriptor = {
	family: Family;
	lengthBucket: number;
	decoration: Decoration;
	seedOverlap: number;
};

export type NetworkState = {
	version: number;
	exampleCount: number;
	hiddenWeights: number[][];
	hiddenBias: number[];
	outputWeights: number[];
	outputBias: number;
};

type LexemeRow = {
	surface: string;
	pos: string;
	detail: string;
	basicForm: string;
	conjugation: string;
	count: number;
};

function oneHot<T>(values: readonly T[], value: T): number[] {
	return values.map((item) => (item === value ? 1 : 0));
}

function lengthBucket(count: number): number {
	if (count <= 3) return 0;
	if (count <= 7) return 1;
	if (count <= 14) return 2;
	return 3;
}

function stripUrls(text: string): string {
	return text
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/\S*)?/g, " ");
}

export function extractSentenceStats(
	text: string,
	tokens: DetailedToken[],
	isReply: boolean,
): SentenceStats {
	const plain = stripUrls(text);
	const hasWww = /[wｗ]{2,}(?=$|[\s！？!?。、…〜～])/iu.test(plain);
	const hasGrass =
		/草{2,}/u.test(plain) ||
		/(?:^|[\sはでが、。！？!?…])草+(?=(?:[wｗ]{2,})?(?:$|[\s、。！？!?…〜～]))/u.test(
			plain,
		);
	const hasQuestion = /[？?]/u.test(plain);
	const hasExclamation = /[！!]/u.test(plain);
	const hasEllipsis = /…|\.\.\./u.test(plain);
	const hasWave = /[〜～]/u.test(plain);
	let decoration: Decoration = "none";
	if (hasGrass) decoration = "grass";
	else if (hasWww) decoration = "www";
	else if (hasQuestion && hasExclamation) decoration = "mixed";
	else if (hasQuestion) decoration = "question";
	else if (hasExclamation) decoration = "bang";
	else if (hasEllipsis) decoration = "ellipsis";
	else if (hasWave) decoration = "wave";
	else if (/（[^）]*）|\([^)]*\)/u.test(plain)) decoration = "paren";
	else if (/「[^」]*」/u.test(plain)) decoration = "quote";
	else if (/[。.]\s*$/u.test(plain)) decoration = "period";

	let family: Family = "statement";
	if (hasGrass || hasWww) family = "amused";
	else if (hasQuestion || /(?:か|かな|だろう)\s*[。！？!?]*$/u.test(plain))
		family = "question";
	else if (/(?:ほしい|欲しい|たい)\s*[。！？!?…]*$/u.test(plain))
		family = "desire";
	else if (/(?:わかる|それな|たしかに|同意)/u.test(plain)) family = "agreement";
	else if (hasExclamation) family = "reaction";

	const posCounts: Record<string, number> = {};
	for (const token of tokens) {
		posCounts[token.pos] = (posCounts[token.pos] ?? 0) + 1;
	}
	return {
		tokenCount: tokens.length,
		charCount: plain.length,
		lengthBucket: lengthBucket(tokens.length),
		posCounts,
		startPos: tokens[0]?.pos ?? "",
		endPos: tokens.at(-1)?.pos ?? "",
		family,
		decoration,
		isReply,
		hasQuestion,
		hasExclamation,
		hasEllipsis,
		hasWave,
		hasWww,
		hasGrass,
	};
}

function encode(
	stats: SentenceStats,
	candidate: CandidateDescriptor,
): number[] {
	const posTotal = Math.max(1, stats.tokenCount);
	const pos = POS_KEYS.map((key) => {
		if (key === "other") {
			const known = POS_KEYS.slice(0, -1).reduce(
				(sum, item) => sum + (stats.posCounts[item] ?? 0),
				0,
			);
			return Math.max(0, stats.tokenCount - known) / posTotal;
		}
		return (stats.posCounts[key] ?? 0) / posTotal;
	});
	const out = [
		...oneHot(FAMILIES, stats.family),
		...oneHot([0, 1, 2, 3], stats.lengthBucket),
		...pos,
		...oneHot(DECORATIONS, stats.decoration),
		Number(stats.isReply),
		...oneHot(FAMILIES, candidate.family),
		...oneHot([0, 1, 2, 3], candidate.lengthBucket),
		...oneHot(DECORATIONS, candidate.decoration),
		candidate.seedOverlap,
		Number(stats.family === candidate.family),
		Number(stats.lengthBucket === candidate.lengthBucket),
		Number(stats.decoration === candidate.decoration),
		Math.abs(stats.lengthBucket - candidate.lengthBucket) / 3,
	];
	if (out.length !== INPUT_SIZE) throw new Error("invalid neural feature size");
	return out;
}

function initialState(): NetworkState {
	const weight = (row: number, column: number) =>
		(((row + 1) * 37 + (column + 1) * 17) % 101) / 5050 - 0.01;
	return {
		version: MODEL_VERSION,
		exampleCount: 0,
		hiddenWeights: Array.from({ length: HIDDEN_SIZE }, (_, row) =>
			Array.from({ length: INPUT_SIZE }, (_, column) => weight(row, column)),
		),
		hiddenBias: Array(HIDDEN_SIZE).fill(0),
		outputWeights: Array.from({ length: HIDDEN_SIZE }, (_, index) =>
			weight(HIDDEN_SIZE, index),
		),
		outputBias: 0,
	};
}

function validState(value: unknown): value is NetworkState {
	const state = value as Partial<NetworkState> | null;
	return Boolean(
		state &&
			state.version === MODEL_VERSION &&
			Number.isInteger(state.exampleCount) &&
			state.hiddenWeights?.length === HIDDEN_SIZE &&
			state.hiddenWeights.every((row) => row.length === INPUT_SIZE) &&
			state.hiddenBias?.length === HIDDEN_SIZE &&
			state.outputWeights?.length === HIDDEN_SIZE &&
			typeof state.outputBias === "number",
	);
}

function forward(
	state: NetworkState,
	input: number[],
): { hidden: number[]; output: number } {
	const hidden = state.hiddenWeights.map((weights, index) =>
		Math.max(
			0,
			weights.reduce(
				(sum, weight, column) => sum + weight * (input[column] ?? 0),
				state.hiddenBias[index] ?? 0,
			),
		),
	);
	const logit = hidden.reduce(
		(sum, value, index) => sum + value * (state.outputWeights[index] ?? 0),
		state.outputBias,
	);
	return {
		hidden,
		output: 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit)))),
	};
}

function train(state: NetworkState, input: number[], target: number): void {
	const { hidden, output } = forward(state, input);
	const error = output - target;
	const oldOutput = [...state.outputWeights];
	for (let hiddenIndex = 0; hiddenIndex < HIDDEN_SIZE; hiddenIndex += 1) {
		state.outputWeights[hiddenIndex] =
			(state.outputWeights[hiddenIndex] ?? 0) -
			LEARNING_RATE * error * (hidden[hiddenIndex] ?? 0);
	}
	state.outputBias -= LEARNING_RATE * error;
	for (let hiddenIndex = 0; hiddenIndex < HIDDEN_SIZE; hiddenIndex += 1) {
		if ((hidden[hiddenIndex] ?? 0) <= 0) continue;
		const hiddenError = error * (oldOutput[hiddenIndex] ?? 0);
		const row = state.hiddenWeights[hiddenIndex] as number[];
		for (let column = 0; column < INPUT_SIZE; column += 1) {
			row[column] =
				(row[column] ?? 0) - LEARNING_RATE * hiddenError * (input[column] ?? 0);
		}
		state.hiddenBias[hiddenIndex] =
			(state.hiddenBias[hiddenIndex] ?? 0) - LEARNING_RATE * hiddenError;
	}
}

function descriptorFromStats(stats: SentenceStats): CandidateDescriptor {
	return {
		family: stats.family,
		lengthBucket: stats.lengthBucket,
		decoration: stats.decoration,
		seedOverlap: 1,
	};
}

function trainObservation(state: NetworkState, stats: SentenceStats): void {
	const positive = descriptorFromStats(stats);
	train(state, encode(stats, positive), 1);
	train(
		state,
		encode(stats, {
			...positive,
			family: FAMILIES[
				(FAMILIES.indexOf(positive.family) + 1) % FAMILIES.length
			] as Family,
			seedOverlap: 0,
		}),
		0,
	);
	train(
		state,
		encode(stats, {
			...positive,
			lengthBucket: (positive.lengthBucket + 2) % LENGTH_BUCKETS,
			seedOverlap: 0,
		}),
		0,
	);
	train(
		state,
		encode(stats, {
			...positive,
			decoration: DECORATIONS[
				(DECORATIONS.indexOf(positive.decoration) + 4) % DECORATIONS.length
			] as Decoration,
			seedOverlap: 0,
		}),
		0,
	);
	state.exampleCount += 1;
}

function applyDecoration(text: string, decoration: Decoration): string {
	switch (decoration) {
		case "period":
			return `${text}。`;
		case "bang":
			return `${text}！`;
		case "question":
			return `${text}？`;
		case "mixed":
			return `${text}！？`;
		case "ellipsis":
			return `${text}…`;
		case "wave":
			return `${text}〜`;
		case "www":
			return `${text}www`;
		case "grass":
			return `${text} 草`;
		case "paren":
			return `（${text}）`;
		case "quote":
			return `「${text}」`;
		default:
			return text;
	}
}

function estimateTokens(text: string): number {
	return Math.max(
		1,
		Math.ceil(text.replace(/[！？。…〜（）「」\s]/gu, "").length / 3),
	);
}

function weightedPick<T extends { count: number }>(items: T[]): T | undefined {
	const total = items.reduce((sum, item) => sum + item.count, 0);
	if (total <= 0) return undefined;
	let roll = Math.random() * total;
	for (const item of items) {
		roll -= item.count;
		if (roll <= 0) return item;
	}
	return items.at(-1);
}

export class LanguageModel {
	private state: NetworkState = initialState();
	private readonly lexemes = new Map<string, LexemeRow>();

	async load(db: Db): Promise<void> {
		this.lexemes.clear();
		const [rows, saved] = await Promise.all([
			db.lexeme.findMany(),
			db.neuralModel.findUnique({ where: { id: MODEL_ID } }),
		]);
		for (const row of rows) this.addLexeme(row);
		if (saved && validState(saved.state)) {
			this.state = structuredClone(saved.state);
			this.state.exampleCount = saved.exampleCount;
		} else {
			this.state = initialState();
		}
	}

	get vocabularySize(): number {
		return this.lexemes.size;
	}

	get exampleCount(): number {
		return this.state.exampleCount;
	}

	compatibility(stats: SentenceStats, candidate: CandidateDescriptor): number {
		return forward(this.state, encode(stats, candidate)).output;
	}

	nextState(stats: SentenceStats[]): NetworkState {
		const next = structuredClone(this.state);
		for (const item of stats) trainObservation(next, item);
		return next;
	}

	async persistBatch(
		tx: DbTransaction,
		postId: string,
		authorId: string,
		sentences: Array<{ tokens: DetailedToken[]; stats: SentenceStats }>,
		state: NetworkState,
	): Promise<void> {
		for (
			let sentenceIndex = 0;
			sentenceIndex < sentences.length;
			sentenceIndex += 1
		) {
			const sentence = sentences[sentenceIndex] as {
				tokens: DetailedToken[];
				stats: SentenceStats;
			};
			for (const token of sentence.tokens) {
				await tx.lexeme.upsert({
					where: {
						surface_pos_detail_basicForm_conjugation: {
							surface: token.text,
							pos: token.pos,
							detail: token.detail,
							basicForm: token.basicForm,
							conjugation: token.conjugation,
						},
					},
					create: {
						surface: token.text,
						pos: token.pos,
						detail: token.detail,
						basicForm: token.basicForm,
						conjugation: token.conjugation,
					},
					update: { count: { increment: 1 } },
				});
			}
			await tx.sentenceFeature.create({
				data: {
					postId,
					sentenceIndex,
					authorId,
					features: sentence.stats as unknown as Prisma.InputJsonValue,
				},
			});
		}
		await tx.neuralModel.upsert({
			where: { id: MODEL_ID },
			create: {
				id: MODEL_ID,
				version: MODEL_VERSION,
				exampleCount: state.exampleCount,
				state: state as unknown as Prisma.InputJsonValue,
			},
			update: {
				version: MODEL_VERSION,
				exampleCount: state.exampleCount,
				state: state as unknown as Prisma.InputJsonValue,
			},
		});
	}

	commitBatch(tokens: DetailedToken[][], state: NetworkState): void {
		for (const sentence of tokens) {
			for (const token of sentence) {
				this.addLexeme({
					surface: token.text,
					pos: token.pos,
					detail: token.detail,
					basicForm: token.basicForm,
					conjugation: token.conjugation,
					count: 1,
				});
			}
		}
		this.state = state;
	}

	generate(
		stats: SentenceStats,
		seed: DetailedToken[],
		targetTokens = 8,
	): string {
		const candidates = new Map<string, CandidateDescriptor>();
		let attempts = 0;
		while (
			candidates.size < CANDIDATE_COUNT &&
			attempts < CANDIDATE_COUNT * 12
		) {
			attempts += 1;
			const sentenceCount = targetTokens > 14 ? 3 : targetTokens > 7 ? 2 : 1;
			const parts: string[] = [];
			const used = new Set<string>();
			let family: Family = "statement";
			let overlap = 0;
			for (let index = 0; index < sentenceCount; index += 1) {
				const template = TEMPLATES[
					Math.floor(Math.random() * TEMPLATES.length)
				] as Template;
				if (used.has(template.id)) continue;
				const value = template.slot ? this.pickSlot(template.slot, seed) : "";
				if (template.slot && !value) continue;
				const text = template.slot
					? template.text.replaceAll(`{${template.slot}}`, value)
					: template.text;
				if (parts.length === 0) family = template.family;
				if (
					seed.some(
						(token) => token.text === value || token.basicForm === value,
					)
				)
					overlap += 1;
				parts.push(text);
				used.add(template.id);
			}
			if (parts.length === 0) continue;
			const decoration =
				attempts % 3 === 0
					? stats.decoration
					: (DECORATIONS[
							Math.floor(Math.random() * DECORATIONS.length)
						] as Decoration);
			const text = applyDecoration(parts.join("。"), decoration);
			if (text.length > 280) continue;
			candidates.set(text, {
				family,
				lengthBucket: lengthBucket(estimateTokens(text)),
				decoration,
				seedOverlap: Math.min(1, overlap / Math.max(1, parts.length)),
			});
		}
		let best = "";
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const [text, descriptor] of candidates) {
			const estimate = estimateTokens(text);
			const heuristic =
				descriptor.seedOverlap * 2 -
				Math.abs(targetTokens - estimate) * 0.12 +
				Number(descriptor.family === stats.family) * 0.75 +
				Number(descriptor.decoration === stats.decoration) * 0.5;
			const neural =
				this.state.exampleCount >= 20
					? forward(this.state, encode(stats, descriptor)).output * 4
					: 0;
			const score = heuristic + neural + Math.random() * 0.01;
			if (score > bestScore) {
				best = text;
				bestScore = score;
			}
		}
		return best;
	}

	private pickSlot(slot: Slot, seed: DetailedToken[]): string {
		const pos =
			slot === "noun"
				? "名詞"
				: slot === "verb"
					? "動詞"
					: slot === "adjective"
						? "形容詞"
						: "副詞";
		const seedWords = new Set(
			seed.flatMap((token) => [token.text, token.basicForm]),
		);
		const merged = new Map<string, number>();
		for (const row of this.lexemes.values()) {
			if (row.pos !== pos) continue;
			if (slot === "noun" && ["非自立", "接尾", "代名詞"].includes(row.detail))
				continue;
			const text =
				slot === "verb" || slot === "adjective"
					? row.basicForm || row.surface
					: row.surface;
			if (!text || text.length > 30) continue;
			merged.set(
				text,
				(merged.get(text) ?? 0) + row.count * (seedWords.has(text) ? 4 : 1),
			);
		}
		return (
			weightedPick([...merged].map(([text, count]) => ({ text, count })))
				?.text ?? ""
		);
	}

	private addLexeme(row: LexemeRow): void {
		const key = [
			row.surface,
			row.pos,
			row.detail,
			row.basicForm,
			row.conjugation,
		].join("\t");
		const current = this.lexemes.get(key);
		this.lexemes.set(key, { ...row, count: row.count + (current?.count ?? 0) });
	}
}
