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
import OpenAI from "openai";
import Mustache from "mustache";

declare global {
	interface Window {
		__companion_last_openrouter_payload?: unknown;
		__companion_last_openrouter_payload_preview?: string;
	}
}

const CONTINUATION_HARD_RULES =
	"Output only insertable continuation text at the cursor. Do not explain your reasoning, do not describe what to do, and do not provide planning/meta commentary. Match the surrounding format and tone. If the cursor is in a list item, continue with list-item content only.";
const MORPH_RESCUE_MODEL = "openai/gpt-oss-120b";

export default class OpenRouterModel implements Model {
	id: string;
	name: string;
	description: string;
	rate_limit_notice: Notice | null = null;
	rate_limit_notice_timeout: number | null = null;
	Settings = ModelSettingsUI;

	provider_settings: ProviderSettings;
	private payload_preview_timeout: number | null = null;

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
		const configured = settings.prompt_length || 20000;
		const budget = Math.min(Math.max(configured, 2000), 50000);
		const suffix_budget = Math.max(Math.min(Math.floor(budget * 0.25), 8000), 1000);
		const prepared: Prompt = {
			...prompt,
			prefix: prompt.prefix.slice(-budget),
			suffix: prompt.suffix.slice(0, suffix_budget),
		};
		prepared.context = prepared.context || prepared.prefix;
		prepared.last_line =
			prepared.last_line || (prepared.prefix.split(/\r?\n/).pop() || "");
		prepared["up_to_500-1500_chars_before_cursor"] =
			prepared["up_to_500-1500_chars_before_cursor"] ||
			prepared.prefix.slice(-1500);
		prepared["up_to_200-800_chars_after_cursor"] =
			prepared["up_to_200-800_chars_after_cursor"] ||
			prepared.suffix.slice(0, 800);
		prepared.reference_files_block = prepared.reference_files_block || "";
		return prepared;
	}

	async generate_messages(
		prompt: Prompt,
		model_settings: {
			system_prompt: string;
			user_prompt: string;
		}
	): Promise<{ role: "system" | "user"; content: string }[]> {
		const prepared = await this.prepare(prompt, model_settings);
		const system_content = model_settings.system_prompt
			? `${CONTINUATION_HARD_RULES}\n\n${model_settings.system_prompt}`
			: CONTINUATION_HARD_RULES;
		const user_content = Mustache.render(
			model_settings.user_prompt,
			prepared
		);

		// Morph models on OpenRouter reject multi-turn chat payloads and can echo
		// complex prompt scaffolding. Use a lean single-turn continuation prompt.
		if (this.id.startsWith("morph/")) {
			const morph_prompt = [
				CONTINUATION_HARD_RULES,
				"Text before cursor:",
				prepared.prefix,
				prepared.suffix ? `Text after cursor:\n${prepared.suffix}` : "",
				"Write only the continuation text at the cursor:",
			]
				.filter(Boolean)
				.join("\n\n");
			return [
				{
					role: "user",
					content: morph_prompt,
				},
			];
		}

		return [
			{
				role: "system",
				content: system_content,
			},
			{
				role: "user",
				content: user_content,
			},
		];
	}

	model_parameters(model_settings: {
		user_prompt: string;
		system_prompt: string;
		presence_penalty?: number;
		frequency_penalty?: number;
		top_p?: number;
		temperature?: number;
	}): {
		presence_penalty?: number;
		frequency_penalty?: number;
		top_p?: number;
		temperature?: number;
	} {
		return {
			presence_penalty: model_settings.presence_penalty,
			frequency_penalty: model_settings.frequency_penalty,
			top_p: model_settings.top_p,
			temperature: model_settings.temperature,
		};
	}

	create_rate_limit_notice() {
		if (this.rate_limit_notice) {
			window.clearTimeout(this.rate_limit_notice_timeout!);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		} else {
			this.rate_limit_notice = new Notice(
				"Rate limit exceeded. Please wait and try again.",
				250000
			);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		}
	}

	create_api_key_notice() {
		const notice: any = new Notice("", 5000);
		const notice_element = notice.noticeEl as HTMLElement;
		notice_element.createEl("span", {
			text: "OpenRouter API key is invalid. Please check your ",
		});
		notice_element.createEl("a", {
			text: "API key",
			href: "https://openrouter.ai/keys",
		});
		notice_element.createEl("span", {
			text: " in the plugin settings.",
		});
	}

	parse_api_error(e: { status?: number }) {
		if (e.status === 429) {
			this.create_rate_limit_notice();
			throw new Error();
		} else if (e.status === 401) {
			this.create_api_key_notice();
			throw new Error();
		}
		throw e;
	}

	private get_endpoint(): string {
		return "https://openrouter.ai/api/v1/chat/completions";
	}

	private async post_chat_completion(params: any): Promise<Response> {
		const controller = new AbortController();
		const timeout_id = window.setTimeout(() => controller.abort(), 45000);
		try {
			return await fetch(this.get_endpoint(), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.provider_settings.api_key}`,
				},
				body: JSON.stringify(params),
				signal: controller.signal,
			});
		} finally {
			window.clearTimeout(timeout_id);
		}
	}

	private async build_params(
		prompt: Prompt,
		model_settings: ModelSettings,
		stream: boolean,
		override_model?: string
	): Promise<any> {
		const model_id = override_model || this.id;
		const params: any = {
			...this.model_parameters(model_settings),
			messages: await this.generate_messages(prompt, model_settings),
			model: model_id,
			max_tokens: 400,
			stop: ["\n\n", "---"],
		};
		if (stream) {
			params.stream = true;
		}
		if (model_id.match(/gpt-oss|^o[1-9]/)) {
			params.reasoning_effort = "low";
		}
		return params;
	}

	private async request_completion_text(params: any): Promise<string> {
		const response = await this.post_chat_completion(params);
		if (!response.ok) {
			const text = await response.text();
			throw { status: response.status, message: text };
		}
		const body = await response.json();
		return this.extract_content(body.choices?.[0]?.message) || "";
	}

	private maybe_debug_payload(
		mode: "complete" | "stream",
		payload: unknown,
		attempt: "primary" | "rescue"
	): void {
		if (!this.provider_settings.debug_prompt_payload) {
			return;
		}
		const debug_payload = {
			mode,
			model: this.id,
			attempt,
			timestamp: new Date().toISOString(),
			payload,
		};
		window.__companion_last_openrouter_payload = debug_payload;
		console.log("[Companion] OpenRouter payload", debug_payload);
		const user_message =
			(debug_payload as any)?.payload?.messages?.find?.(
				(m: any) => m?.role === "user"
			)?.content || "";
		const preview = String(user_message)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 140);
		window.__companion_last_openrouter_payload_preview = preview;

		const companion = (window as any)?.app?.plugins?.plugins?.companion;
		if (companion?.statusBarItemEl) {
			companion.statusBarItemEl.setText(
				preview
					? `Payload preview: ${preview}`
					: "Payload preview: (empty user payload)"
			);
			if (this.payload_preview_timeout !== null) {
				window.clearTimeout(this.payload_preview_timeout);
			}
			this.payload_preview_timeout = window.setTimeout(() => {
				if (typeof companion.fillStatusbar === "function") {
					companion.fillStatusbar();
				}
				this.payload_preview_timeout = null;
			}, 12000);
		}

		new Notice(
			preview
				? `[Companion] Payload captured (${mode}): ${preview}`
				: `[Companion] OpenRouter payload captured (${mode}).`
		);
	}

	// Extract text from response, handling reasoning models that return
	// content in the reasoning field instead of content field
	private extract_content(message: any): string {
		if (message.content) return message.content;
		// Reasoning models (o1, gpt-oss, etc.) put output in reasoning
		if (message.reasoning) return message.reasoning;
		if (message.reasoning_details?.length) {
			return message.reasoning_details
				.filter((d: any) => d.text)
				.map((d: any) => d.text)
				.join("");
		}
		return "";
	}

	private strip_repeated_prefix(prompt: Prompt, completion: string): string {
		const max_head = Math.min(completion.length, 400);
		for (let i = max_head; i >= 12; i--) {
			const head = completion.slice(0, i);
			if (head && prompt.prefix.includes(head)) {
				return completion.slice(i);
			}
		}
		return completion;
	}

	private is_unusable_completion(prompt: Prompt, completion: string): boolean {
		const trimmed = completion.trim();
		if (!trimmed) {
			return true;
		}
		if (trimmed.length >= 8 && prompt.prefix.includes(trimmed)) {
			return true;
		}
		if (
			/\b(Text before cursor|Write only the continuation|Preserve the code's structure)\b/i.test(
				trimmed
			)
		) {
			return true;
		}
		return false;
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const model_settings = parse_model_settings(settings);

		try {
			const params = await this.build_params(prompt, model_settings, false);
			this.maybe_debug_payload("complete", params, "primary");
			const raw_completion = await this.request_completion_text(params);
			let interpreted = this.interpret(prompt, raw_completion);

			// Morph is very fast but occasionally returns prompt-echo/meta text.
			// Rescue those cases with a single fallback completion request.
			if (
				this.id.startsWith("morph/") &&
				this.is_unusable_completion(prompt, interpreted)
			) {
				const rescue_params = await this.build_params(
					prompt,
					model_settings,
					false,
					MORPH_RESCUE_MODEL
				);
				this.maybe_debug_payload("complete", rescue_params, "rescue");
				const rescue_text = await this.request_completion_text(rescue_params);
				interpreted = this.interpret(prompt, rescue_text);
			}

			return interpreted;
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		if (this.id.startsWith("morph/")) {
			const one_shot = await this.complete(prompt, settings);
			if (one_shot.trim()) {
				yield one_shot;
			}
			return;
		}

		const model_settings = parse_model_settings(settings);

		try {
			const params = await this.build_params(prompt, model_settings, true);
			this.maybe_debug_payload("stream", params, "primary");
			const response = await this.post_chat_completion(params);
			if (!response.ok || !response.body) {
				const text = await response.text();
				throw { status: response.status, message: text };
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let sse_buf = "";

			// Buffer early tokens so interpret() sees enough text for sanitize
			let buf = "";
			let flushed = false;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					sse_buf += decoder.decode(value, { stream: true });
					const lines = sse_buf.split("\n");
					sse_buf = lines.pop() || "";
					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const payload = line.slice(6).trim();
						if (!payload || payload === "[DONE]") {
							continue;
						}
						let event: any;
						try {
							event = JSON.parse(payload);
						} catch {
							continue;
						}

						const delta = event.choices?.[0]?.delta || {};
						const token = delta.content || delta.reasoning || "";
						if (!token) continue;
						if (!flushed) {
							buf += token;
							if (
								buf.length >= 30 ||
								(buf.length >= 4 && !/^(Here|Sure|```)/i.test(buf))
							) {
								const cleaned = this.interpret(prompt, buf);
								if (cleaned.trim()) yield cleaned;
								flushed = true;
							}
						} else {
							yield token;
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
			if (!flushed && buf.length > 0) {
				const cleaned = this.interpret(prompt, buf);
				if (cleaned.trim()) yield cleaned;
			}
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	interpret(prompt: Prompt, completion: string) {
		completion = this.strip_repeated_prefix(prompt, completion);
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

export class OpenRouterComplete implements Completer {
	id: string = "openrouter";
	name: string = "OpenRouter";
	description: string = "OpenRouter API — access hundreds of models";

	async get_models(settings: string) {
		const provider_settings = parse_provider_settings(settings);
		if (!provider_settings.api_key) {
			return this.fallback_models(settings);
		}
		try {
			const api = new OpenAI({
				apiKey: provider_settings.api_key,
				baseURL: "https://openrouter.ai/api/v1",
				dangerouslyAllowBrowser: true,
			});
			const models = await api.models.list();
			const list = models.data
				.sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
				.map(
					(m: any) =>
						new OpenRouterModel(
							settings,
							m.id,
							m.id,
							m.id
						)
				);
			if (list.length > 0) return list;
		} catch {
			// Fall through to fallback
		}
		return this.fallback_models(settings);
	}

	private fallback_models(settings: string) {
		return [
			new OpenRouterModel(
				settings,
				"morph/morph-v3-fast",
				"Morph v3 Fast",
				"Morph's fastest high-throughput model"
			),
			new OpenRouterModel(
				settings,
				"anthropic/claude-sonnet-4",
				"Claude Sonnet 4",
				"Anthropic's Claude Sonnet 4"
			),
			new OpenRouterModel(
				settings,
				"openai/gpt-4o",
				"GPT-4o",
				"OpenAI's GPT-4o"
			),
			new OpenRouterModel(
				settings,
				"google/gemini-2.5-pro",
				"Gemini 2.5 Pro",
				"Google's Gemini 2.5 Pro"
			),
			new OpenRouterModel(
				settings,
				"meta-llama/llama-4-maverick",
				"Llama 4 Maverick",
				"Meta's Llama 4 Maverick"
			),
		];
	}

	Settings = ProviderSettingsUI;
}
