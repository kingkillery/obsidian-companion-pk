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

const CONTINUATION_HARD_RULES =
	"Output only insertable continuation text at the cursor. Do not explain your reasoning, do not describe what to do, and do not provide planning/meta commentary. Match the surrounding format and tone. If the cursor is in a list item, continue with list-item content only.";

export default class ChatGPT implements Model {
	id: string;
	name: string;
	description: string;
	rate_limit_notice: Notice | null = null;
	rate_limit_notice_timeout: number | null = null;
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
		return [
			{
				role: "system",
				content: model_settings.system_prompt
					? `${CONTINUATION_HARD_RULES}\n\n${model_settings.system_prompt}`
					: CONTINUATION_HARD_RULES,
			},
			{
				role: "user",
				content: Mustache.render(
					model_settings.user_prompt,
					await this.prepare(prompt, model_settings)
				),
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
				'Rate limit exceeded. Check the "Rate limits" section in the plugin settings for more information.',
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
			text: "OpenAI API key is invalid. Please double-check your ",
		});
		notice_element.createEl("a", {
			text: "API key",
			href: "https://platform.openai.com/account/api-keys",
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

	get_api() {
		return new OpenAI({
			apiKey: this.provider_settings.api_key,
			dangerouslyAllowBrowser: true,
		});
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const model_settings = parse_model_settings(settings);

		try {
			const response = await this.get_api().chat.completions.create({
				...this.model_parameters(model_settings),
				messages: await this.generate_messages(prompt, model_settings),
				model: this.id,
				max_tokens: 128,
				stop: ["\n\n", "---"],
			});

			return this.interpret(
				prompt,
				response.choices[0]?.message.content || ""
			);
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		const model_settings = parse_model_settings(settings);

		try {
			const completion = await this.get_api().chat.completions.create({
				...this.model_parameters(model_settings),
				messages: await this.generate_messages(prompt, model_settings),
				model: this.id,
				max_tokens: 128,
				stop: ["\n\n", "---"],
				stream: true,
			});

			// Buffer early tokens so interpret() sees enough text for sanitize
			let buf = "";
			let flushed = false;
			for await (const chunk of completion) {
				const token = chunk.choices[0]?.delta?.content || "";
				if (!token) continue;
				if (!flushed) {
					buf += token;
					if (buf.length >= 30 || (buf.length >= 4 && !/^(Here|Sure|```)/i.test(buf))) {
						const cleaned = this.interpret(prompt, buf);
						if (cleaned.trim()) yield cleaned;
						flushed = true;
					}
				} else {
					yield token;
				}
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

export class ChatGPTComplete implements Completer {
	id: string = "openai-chatgpt";
	name: string = "OpenAI ChatGPT";
	description: string = "OpenAI's ChatGPT model";

	async get_models(settings: string) {
		return [
			new ChatGPT(
				settings,
				"gpt-4o-mini",
				"GPT-4o mini (recommended)",
				"Fast and cost-efficient OpenAI chat model"
			),
			new ChatGPT(
				settings,
				"gpt-4o",
				"GPT-4o",
				"Higher quality OpenAI chat model"
			),
			new ChatGPT(
				settings,
				"gpt-3.5-turbo",
				"GPT-3.5 Turbo (legacy)",
				"Legacy fallback chat model"
			),
		];
	}

	Settings = ProviderSettingsUI;
}
