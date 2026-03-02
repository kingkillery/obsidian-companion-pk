import * as React from "react";
import SettingsItem from "../../../components/SettingsItem";
import { z } from "zod";

export const settings_schema = z.object({
	api_key: z.string(),
	debug_prompt_payload: z.boolean().optional(),
});

export type Settings = z.infer<typeof settings_schema>;

const default_settings: Settings = {
	api_key: "",
	debug_prompt_payload: false,
};

export const parse_settings = (data: string | null): Settings => {
	if (data === null) {
		return default_settings;
	}
	try {
		const settings: unknown = JSON.parse(data);
		return settings_schema.parse(settings);
	} catch (e) {
		return default_settings;
	}
};

export function SettingsUI({
	settings,
	saveSettings,
}: {
	settings: string | null;
	saveSettings: (settings: string) => void;
}) {
	const parsed = parse_settings(settings);
	return (
		<>
			<SettingsItem
				name="API key"
				description={
					<>
						Your OpenRouter{" "}
						<a href="https://openrouter.ai/keys">API key</a>
					</>
				}
			>
				<input
					type="text"
					value={parsed.api_key}
					onChange={(e) =>
						saveSettings(
							JSON.stringify({
								...parsed,
								api_key: e.target.value,
							})
						)
					}
				/>
			</SettingsItem>
			<SettingsItem
				name="Debug payload logging"
				description="Capture and log the exact OpenRouter payload for completion debugging."
			>
				<div
					className={
						"checkbox-container" +
						(parsed.debug_prompt_payload ? " is-enabled" : "")
					}
					onClick={() =>
						saveSettings(
							JSON.stringify({
								...parsed,
								debug_prompt_payload: !parsed.debug_prompt_payload,
							})
						)
					}
				></div>
			</SettingsItem>
		</>
	);
}
