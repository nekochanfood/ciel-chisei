declare module "kuromoji" {
	export interface KuromojiToken {
		word_id: number;
		word_type: string;
		word_position: number;
		surface_form: string;
		pos: string;
		pos_detail_1: string;
		pos_detail_2: string;
		pos_detail_3: string;
		conjugated_type: string;
		conjugated_form: string;
		basic_form: string;
		reading: string;
		pronunciation: string;
	}

	export interface KuromojiTokenizer {
		tokenize(text: string): KuromojiToken[];
	}

	export interface KuromojiBuilder {
		build(
			callback: (err: Error | null, tokenizer: KuromojiTokenizer) => void,
		): void;
	}

	const kuromoji: {
		builder(options: { dicPath?: string }): KuromojiBuilder;
	};
	export default kuromoji;
}
