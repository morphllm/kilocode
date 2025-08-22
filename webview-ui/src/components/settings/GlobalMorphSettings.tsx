// kilocode_change: Morph fast apply - global settings version

import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

export const GlobalMorphSettings = ({ morphApiKey }: { morphApiKey?: string }) => {
	const { t } = useAppTranslation()

	const handleMorphApiKeyChange = (value: string) => {
		vscode.postMessage({
			type: "morphApiKey",
			text: value || "",
		})
	}

	return (
		<div>
			<VSCodeTextField
				type="password"
				value={morphApiKey || ""}
				placeholder={t("settings:experimental.MORPH_FAST_APPLY.placeholder")}
				onChange={(e) => handleMorphApiKeyChange((e.target as any)?.value || "")}
				className="w-full">
				{t("settings:experimental.MORPH_FAST_APPLY.apiKey")}
			</VSCodeTextField>
			<div className="text-xs px-1 py-1 mt-2 flex gap-2">
				<span className="codicon codicon-warning" />
				<span>{t("settings:experimental.MORPH_FAST_APPLY.warning")}</span>
			</div>
		</div>
	)
}
