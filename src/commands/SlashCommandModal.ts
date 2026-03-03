import { App, Modal } from "obsidian";
import type { SlashSuggestion } from "./types";

export class SlashCommandModal extends Modal {
	private get_suggestions: (query: string) => Promise<SlashSuggestion[]>;
	private on_command: (
		suggestion: SlashSuggestion
	) => Promise<unknown>;
	private trigger: "/" | "@";
	private on_close?: () => void;
	private query: string;
	private suggestions: SlashSuggestion[];
	private selected: number;
	private query_el: HTMLDivElement;
	private list_el: HTMLDivElement;
	private keydown_handler: ((event: KeyboardEvent) => void) | null;
	private refresh_timer: number | null;
	private refresh_request_id: number;

	constructor(
		app: App,
		query: string,
		trigger: "/" | "@",
		get_suggestions: (query: string) => Promise<SlashSuggestion[]>,
		on_command: (suggestion: SlashSuggestion) => Promise<unknown>,
		on_close?: () => void
	) {
		super(app);
		this.query = query;
		this.trigger = trigger;
		this.get_suggestions = get_suggestions;
		this.on_command = on_command;
		this.on_close = on_close;
		this.suggestions = [];
		this.selected = 0;
		this.keydown_handler = null;
		this.refresh_timer = null;
		this.refresh_request_id = 0;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("companion-slash-modal");

		this.query_el = contentEl.createEl("div", { cls: "companion-slash-query" });
		this.list_el = contentEl.createEl("div", {
			cls: "companion-slash-suggestions",
		});

		this.keydown_handler = (event: KeyboardEvent) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				if (!this.suggestions.length) {
					return;
				}
				this.selected = (this.selected + 1) % this.suggestions.length;
				this.renderSuggestions();
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				if (!this.suggestions.length) {
					return;
				}
				this.selected =
					(this.selected - 1 + this.suggestions.length) %
					this.suggestions.length;
				this.renderSuggestions();
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const suggestion = this.suggestions[this.selected];
				if (suggestion) {
					this.on_command(suggestion).catch((e) =>
						console.error("Failed slash command", e)
					);
				}
			}
			if (event.key === "Escape") {
				this.close();
			}
		};
		modalEl?.addEventListener("keydown", this.keydown_handler);

		this.scheduleRefresh(0);
	}

	onClose() {
		if (this.refresh_timer !== null) {
			window.clearTimeout(this.refresh_timer);
			this.refresh_timer = null;
		}
		this.refresh_request_id += 1;
		if (this.modalEl && this.keydown_handler) {
			this.modalEl.removeEventListener("keydown", this.keydown_handler);
		}
		this.keydown_handler = null;
		if (this.on_close) {
			this.on_close();
		}
		this.contentEl.empty();
	}

	setQuery(query: string) {
		this.query = query;
		this.scheduleRefresh();
	}

	setTrigger(trigger: "/" | "@") {
		this.trigger = trigger;
		this.scheduleRefresh();
	}

	private scheduleRefresh(delay_ms = 80) {
		if (this.refresh_timer !== null) {
			window.clearTimeout(this.refresh_timer);
		}
		this.refresh_timer = window.setTimeout(() => {
			this.refresh_timer = null;
			this.refresh_request_id += 1;
			void this.refresh(this.refresh_request_id);
		}, delay_ms);
	}

	private async refresh(request_id: number) {
		const suggestions = await this.get_suggestions(this.query);
		if (request_id !== this.refresh_request_id) {
			return;
		}
		if (!this.query_el || !this.list_el) {
			return;
		}
		this.suggestions = suggestions;
		if (this.suggestions.length > 0) {
			this.selected = 0;
		}
		this.renderSuggestions();
	}

	private async renderSuggestions() {
		if (!this.query_el || !this.list_el) {
			return;
		}
		this.query_el.setText(`${this.trigger}${this.query}`);
		this.list_el.empty();
		if (!this.suggestions.length) {
			this.list_el.setText("No matching actions yet.");
			return;
		}

		for (let idx = 0; idx < this.suggestions.length; idx++) {
			const suggestion = this.suggestions[idx]!;
			const row = this.list_el.createDiv({
				cls:
					"companion-slash-suggestion" +
					(idx === this.selected ? " is-selected" : ""),
				attr: { "data-index": idx.toString() },
			});
			row.createEl("strong", { text: suggestion.title });
			row.createEl("span", {
				text: suggestion.description,
			});
			row.onclick = () => {
				this.on_command(suggestion).catch((e) =>
					console.error("Failed slash command", e)
				);
			};
		}
	}
}
