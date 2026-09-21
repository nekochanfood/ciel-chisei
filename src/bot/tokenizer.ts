import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import kuromoji, { type KuromojiTokenizer } from "kuromoji";
import * as mfm from "mfm-js";

export const BOS = "<BOS>";
export const EOS = "<EOS>";

/**
 * 品詞タグ付きの形態素。kuromoji が使えないフォールバック時は
 * pos が "unknown" になる。絵文字は装飾扱いで学習しない。
 */
export type DetailedToken = {
	text: string;
	pos: string;
	detail: string;
};

let kuromojiTokenizer: KuromojiTokenizer | null = null;
let loadPromise: Promise<void> | null = null;
let tokenizerKind: "kuromoji" | "segmenter" = "segmenter";

export function getTokenizerKind(): "kuromoji" | "segmenter" {
	return tokenizerKind;
}

function resolveDicPath(): string {
	if (process.env.KUROMOJI_DIC_PATH) {
		return process.env.KUROMOJI_DIC_PATH;
	}
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve("kuromoji/package.json");
		return join(dirname(pkgPath), "dict");
	} catch {
		return join(process.cwd(), "node_modules", "kuromoji", "dict");
	}
}

export async function loadTokenizer(): Promise<void> {
	if (kuromojiTokenizer) {
		return;
	}
	loadPromise ??= (async () => {
		try {
			kuromojiTokenizer = await new Promise<KuromojiTokenizer>(
				(resolve, reject) => {
					kuromoji
						.builder({ dicPath: resolveDicPath() })
						.build((err, tokenizer) => {
							if (err) {
								reject(err);
							} else {
								resolve(tokenizer);
							}
						});
				},
			);
			tokenizerKind = "kuromoji";
		} catch (error) {
			console.warn(
				"[tokenizer] kuromoji unavailable, falling back to Intl.Segmenter",
				error,
			);
			kuromojiTokenizer = null;
			tokenizerKind = "segmenter";
		}
	})();
	await loadPromise;
}

type MfmSegment =
	| { type: "text"; text: string }
	| { type: "custom_emoji"; emoji: string };

// カスタム絵文字リテラル。時刻 (12:30) を壊さないよう英字を必須にする。
const CUSTOM_EMOJI_REGEX = /:(?=[a-zA-Z0-9_+-]*[a-zA-Z])[a-zA-Z0-9_+-]+:/g;
/** Unicode emoji components stripped before learning (alternation so combining marks match singly). */
const EMOJI_SINGLE_CHARS = [
	0xfe0f, // variation selector 16
	0x200d, // zero width joiner
	0x20e3, // combining enclosing keycap
	...Array.from(
		{ length: 0xe007f - 0xe0020 + 1 },
		(_, index) => 0xe0020 + index,
	), // flag tags
].map((code) => String.fromCodePoint(code));
const UNICODE_EMOJI_REGEX = new RegExp(
	`\\p{Extended_Pictographic}|${EMOJI_SINGLE_CHARS.join("|")}`,
	"gu",
);

/** 句読点・空白・長音だけのトークンは学習しない (発話時の装飾レイヤーに任せる)。 */
const PUNCT_ONLY_REGEX = /^[\p{P}\sー〜～゠]+$/u;

function toDetailed(
	text: string,
	pos: string,
	detail: string,
): DetailedToken | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed === BOS || trimmed === EOS) {
		return null;
	}
	if (PUNCT_ONLY_REGEX.test(trimmed)) {
		return null;
	}
	return { text: trimmed, pos, detail };
}

const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

function segmentWithFallback(text: string): DetailedToken[] {
	const out: DetailedToken[] = [];
	for (const { segment } of wordSegmenter.segment(text)) {
		const token = toDetailed(segment, "unknown", "");
		if (token) {
			out.push(token);
		}
	}
	return out;
}

function segmentWithKuromoji(text: string): DetailedToken[] {
	if (!kuromojiTokenizer || text.trim().length === 0) {
		return segmentWithFallback(text);
	}
	try {
		const out: DetailedToken[] = [];
		for (const node of kuromojiTokenizer.tokenize(text)) {
			const token = toDetailed(node.surface_form, node.pos, node.pos_detail_1);
			if (token) {
				out.push(token);
			}
		}
		return out;
	} catch {
		return segmentWithFallback(text);
	}
}

export function extractMfmSegments(content: string): MfmSegment[] {
	let nodes: mfm.MfmNode[];
	try {
		nodes = mfm.parse(content);
	} catch {
		return [{ type: "text", text: content }];
	}

	const segments: MfmSegment[] = [];

	function walk(nodeList: mfm.MfmNode[]): void {
		for (const node of nodeList) {
			switch (node.type) {
				case "text":
					segments.push({ type: "text", text: node.props.text });
					break;
				case "unicodeEmoji":
					segments.push({ type: "text", text: node.props.emoji });
					break;
				case "emojiCode":
					segments.push({
						type: "custom_emoji",
						emoji: `:${node.props.name}:`,
					});
					break;
				case "bold":
				case "italic":
				case "strike":
				case "small":
				case "fn":
				case "quote":
				case "plain":
				case "link":
					if (node.children) {
						walk(node.children);
					}
					break;
				case "mention":
				case "url":
				case "blockCode":
				case "inlineCode":
				case "mathInline":
				case "mathBlock":
				case "search":
					// Ignore non-natural text
					break;
				default:
					if (
						"children" in node &&
						Array.isArray((node as { children?: mfm.MfmNode[] }).children)
					) {
						walk((node as { children: mfm.MfmNode[] }).children);
					}
					break;
			}
		}
	}

	walk(nodes);
	return segments;
}

function cleanPlainText(text: string): string {
	return (
		text
			// Markdown リンクはテキスト部だけ残す
			.replace(/\[([^\]]*)\]\([^()\s]*\)/g, "$1 ")
			.replace(/<((?:https?:\/\/)[^<>\s]*)>/g, " ")
			// メールアドレスは丸ごと除去 (ドメイン除去より先)
			.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
			.replace(/https?:\/\/\S+/gi, " ")
			// スキームなしドメイン (example.com, www.example.com/path)
			.replace(
				/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d{1,5})?(?:\/[^\s]*)?/g,
				" ",
			)
			// IP アドレスと localhost:port (貼られたサーバ住所など)
			.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/[^\s]*)?/g, " ")
			.replace(/localhost:\d{1,5}(?:\/[^\s]*)?/gi, " ")
			.replace(/@[a-zA-Z0-9_]{3,32}/g, " ")
			// 絵文字は装飾でしかないため学習前に除去する
			.replace(CUSTOM_EMOJI_REGEX, " ")
			.replace(UNICODE_EMOJI_REGEX, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

function segmentRegion(cleaned: string): DetailedToken[] {
	if (!cleaned) {
		return [];
	}
	return segmentWithKuromoji(cleaned);
}

/** 投稿本文を品詞付き形態素列に分解する (句読点は除去済み)。 */
export async function tokenizeDetailed(text: string): Promise<DetailedToken[]> {
	// loadTokenizer() 呼び忘れでも kuromoji が使われるよう初回に自動ロードする
	await loadTokenizer();
	const segments = extractMfmSegments(text);
	if (segments.length === 0) {
		return [];
	}

	const allTokens: DetailedToken[] = [];
	for (const segment of segments) {
		if (segment.type === "custom_emoji") {
			// カスタム絵文字も装飾扱いで学習しない
			continue;
		}
		const cleaned = cleanPlainText(segment.text);
		if (!cleaned) {
			continue;
		}
		allTokens.push(...segmentRegion(cleaned));
	}
	return allTokens;
}

/** 投稿本文を形態素の表層形列に分解する (句読点は除去済み)。 */
export async function tokenize(text: string): Promise<string[]> {
	const detailed = await tokenizeDetailed(text);
	return detailed.map((token) => token.text);
}

/** 学習単位に文分割する。区切り文字自体は残す (後の句読点除去に任せる)。 */
export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[。！？!?…\n])/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

export function joinTokens(tokens: string[]): string {
	let out = "";
	for (const token of tokens) {
		if (token === BOS || token === EOS) {
			continue;
		}
		if (!out) {
			out = token;
			continue;
		}
		const prev = out[out.length - 1] ?? "";
		const needsSpace =
			/[A-Za-z0-9]$/.test(prev) && /[A-Za-z0-9]/.test(token[0] ?? "");
		out += needsSpace ? ` ${token}` : token;
	}
	return out.trim();
}
