import type { App, Editor } from "obsidian";
import type { MarkdownView } from "obsidian";
import type { TFile } from "obsidian";
import type Companion from "../main";

export interface SlashContext {
	app: App;
	editor: Editor;
	view: MarkdownView;
	plugin: Companion;
	command_trigger: "/" | "@";
	file: TFile | null;
	cursor: {
		line: number;
		ch: number;
	};
	line_text: string;
	selected_text: string;
	query: string;
	trigger_range: {
		from: {
			line: number;
			ch: number;
		};
		to: {
			line: number;
			ch: number;
		};
	};
	frontmatter: Record<string, unknown> | null;
}

export interface SlashSuggestion {
	id: string;
	title: string;
	description: string;
	score: number;
}

export interface LinkIntelligenceSuggestion {
	target_path: string;
	target_title: string;
	score: number;
	reason: string;
}
