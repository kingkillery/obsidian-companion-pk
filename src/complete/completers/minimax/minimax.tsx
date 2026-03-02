import { Notice } from "obsidian";
import { Completer, Model, Prompt } from "../../complete";
import {
	SettingsUI as ProviderSettingsUI,
	Settings as ProviderSettings,
	parse_settings as parse_provider_settings,
} from "./provider_settings";
import {
	SettingsUI as ModelSettingsUI,
	parse_settings as parse_model_settings,
	Settings as ModelSettings,
} from "./model_settings";
import Mustache from "mustache";

export default class MiniMaxModel implements Model {
	id: string;
	name: string;
	description: string;
	Settings = ModelSettingsUI;

	provider_settings: ProviderSettings;

	constructor(
		provider_settings: string,
		id: string,
		name: string,
		description: string
	) {
		this.id = id;
		this.name = name;
		this.description = description;
		this.provider_settings = parse_provider_settings(provider_settings);
	}

	async prepare(prompt: Prompt, settings: ModelSettings): Promise<Prompt> {
		const budget = settings.prompt_length || 6000;
		return {
			prefix: prompt.prefix.slice(-budget),
			suffix: prompt.suffix.slice(0, Math.ceil(budget / 10)),
		};
	}

	build_body(
		prompt: Prompt,
		model_settings: ModelSettings,
		stream: boolean
	): {
		model: string;
		max_tokens: number;
		system?: string;
		messages: { role: string; content: string }[];
		stream?: boolean;
		temperature?: number;
		top_p?: number;
		stop_sequences?: string[];
	} {
		const budget = model_settings.prompt_length || 6000;
		const prepared = {
			prefix: prompt.prefix.slice(-budget),
			suffix: prompt.suffix.slice(0, Math.ceil(budget / 10)),
		};
		const body: any = {
			model: this.id,
			max_tokens: model_settings.max_tokens || 64,
			messages: [
				{
					role: "user",
					content: Mustache.render(
						model_settings.user_prompt,
						prepared
					),
				},
			],
		};
		if (model_settings.system_prompt) {
			body.system = model_settings.system_prompt;
		}
		body.stop_sequences = ["\n\n", "---"];
		if (stream) body.stream = true;
		if (model_settings.temperature !== undefined)
			body.temperature = model_settings.temperature;
		if (model_settings.top_p !== undefined)
			body.top_p = model_settings.top_p;
		return body;
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const model_settings = parse_model_settings(settings);
		const endpoint = this.provider_settings.endpoint.replace(/\/$/, "");

		const response = await fetch(`${endpoint}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.provider_settings.api_key,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(
				this.build_body(prompt, model_settings, false)
			),
		});

		if (response.status === 429) {
			new Notice("MiniMax rate limit exceeded. Please wait.");
			throw new Error("Rate limit");
		}
		if (response.status === 401) {
			new Notice("MiniMax API key is invalid.");
			throw new Error("Unauthorized");
		}
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`MiniMax API error ${response.status}: ${text}`);
		}

		const data = await response.json();
		const text =
			data.content
				?.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("") || "";

		return this.interpret(prompt, text);
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		const model_settings = parse_model_settings(settings);
		const endpoint = this.provider_settings.endpoint.replace(/\/$/, "");

		const response = await fetch(`${endpoint}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": this.provider_settings.api_key,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(
				this.build_body(prompt, model_settings, true)
			),
		});

		if (!response.ok || !response.body) {
			throw new Error(`MiniMax stream error: ${response.status}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let sseBuf = "";
		// Buffer early tokens so interpret() sees enough text for sanitize
		let preambleBuf = "";
		let flushed = false;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				sseBuf += decoder.decode(value, { stream: true });
				const lines = sseBuf.split("\n");
				sseBuf = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (payload === "[DONE]") {
						if (!flushed && preambleBuf.length > 0) {
							const cleaned = this.interpret(prompt, preambleBuf);
							if (cleaned.trim()) yield cleaned;
						}
						return;
					}

					let event: any;
					try {
						event = JSON.parse(payload);
					} catch {
						continue;
					}

					if (event.type === "content_block_delta") {
						const token = event.delta?.text || "";
						if (!token) continue;
						if (!flushed) {
							preambleBuf += token;
							if (preambleBuf.length >= 30 || (preambleBuf.length >= 4 && !/^(Here|Sure|```)/i.test(preambleBuf))) {
								const cleaned = this.interpret(prompt, preambleBuf);
								if (cleaned.trim()) yield cleaned;
								flushed = true;
							}
						} else {
							yield token;
						}
					}
				}
			}
			if (!flushed && preambleBuf.length > 0) {
				const cleaned = this.interpret(prompt, preambleBuf);
				if (cleaned.trim()) yield cleaned;
			}
		} finally {
			reader.releaseLock();
		}
	}

	interpret(prompt: Prompt, completion: string) {
		// Strip common chat-model preamble (require colon to avoid false positives)
		completion = completion
			.replace(/^Here[''\u2019]?s?( is)?( the)?( completion| text| continuation)?:\s*/i, "")
			.replace(/^Sure[,!.]\s*/i, "")
			.replace(/^```[a-z]*\n?/, "")
			.replace(/\n?```\s*$/, "")
			.trimEnd();

		if (!completion) return "";

		const response_punctuation = " \n.,?!:;";
		const prompt_punctuation = " \n";

		if (
			prompt.prefix.length !== 0 &&
			!prompt_punctuation.includes(
				prompt.prefix[prompt.prefix.length - 1]
			) &&
			!response_punctuation.includes(completion[0])
		) {
			completion = " " + completion;
		}

		return completion;
	}
}

export class MiniMaxComplete implements Completer {
	id: string = "minimax";
	name: string = "MiniMax";
	description: string = "MiniMax API (Anthropic-compatible)";

	async get_models(settings: string) {
		return [
			new MiniMaxModel(
				settings,
				"MiniMax-M2.5-highspeed",
				"MiniMax M2.5 Highspeed",
				"MiniMax M2.5 high-speed model"
			),
			new MiniMaxModel(
				settings,
				"MiniMax-M2.5",
				"MiniMax M2.5",
				"MiniMax M2.5 standard model"
			),
		];
	}

	Settings = ProviderSettingsUI;
}
