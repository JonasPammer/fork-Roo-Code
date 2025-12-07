import React from "react"
import { VSCodeTextField, VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings } from "@roo-code/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

interface ClaudeOAuthProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const ClaudeOAuth: React.FC<ClaudeOAuthProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const { t } = useAppTranslation()

	const handlePathChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("claudeOAuthPath", element.value)
	}

	const handleCodeChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField("claudeOAuthCode", element.value)
	}

	const handleStartOAuth = () => {
		vscode.postMessage({ type: "startClaudeOAuth" })
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<p className="text-sm text-vscode-descriptionForeground mb-3">
					Use your Claude Pro or Max subscription to access Claude models directly via OAuth. This uses
					Anthropic's official OAuth flow similar to Claude Code.
				</p>
			</div>

			<div>
				<VSCodeButton onClick={handleStartOAuth} style={{ width: "100%" }}>
					Start OAuth Flow (opens browser)
				</VSCodeButton>
				<p className="text-xs text-vscode-descriptionForeground mt-2">
					Click to open the authorization page. After authorizing, copy the code shown and paste it below.
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.claudeOAuthCode || ""}
					style={{ width: "100%", marginTop: 3 }}
					type="text"
					onInput={handleCodeChange}
					placeholder="Paste authorization code here (format: code#state)">
					Authorization Code
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					After authorizing in your browser, paste the full code (including #state suffix if present).
				</p>
			</div>

			<div>
				<VSCodeTextField
					value={apiConfiguration?.claudeOAuthPath || ""}
					style={{ width: "100%", marginTop: 3 }}
					type="text"
					onInput={handlePathChange}
					placeholder="~/.claude/oauth_creds.json (default)">
					Credentials Path (Optional)
				</VSCodeTextField>
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					Custom path for storing OAuth credentials. Leave empty to use the default location.
				</p>
			</div>
		</div>
	)
}
