import { promises as fs } from "node:fs"
import { Anthropic } from "@anthropic-ai/sdk"
import * as os from "os"
import * as path from "path"

import type { ApiHandlerOptions } from "../../shared/api"
import { AnthropicHandler } from "./anthropic"

const CLAUDE_OAUTH_DIR = ".claude"
const CLAUDE_OAUTH_CREDENTIAL_FILENAME = "oauth_creds.json"

interface ClaudeOAuthCredentials {
	access_token: string
	refresh_token: string
	token_type: string
	expiry_date: number
}

interface ClaudeOAuthHandlerOptions extends ApiHandlerOptions {
	claudeOAuthPath?: string
}

function getClaudeOAuthCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) {
			return path.join(os.homedir(), customPath.slice(2))
		}
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_CREDENTIAL_FILENAME)
}

export class ClaudeOAuthHandler extends AnthropicHandler {
	protected override options: ClaudeOAuthHandlerOptions
	private credentials: ClaudeOAuthCredentials | null = null
	private refreshPromise: Promise<ClaudeOAuthCredentials> | null = null

	constructor(options: ClaudeOAuthHandlerOptions) {
		super(options)
		this.options = options
	}

	private async loadCachedClaudeCredentials(): Promise<ClaudeOAuthCredentials> {
		try {
			const keyFile = getClaudeOAuthCredentialPath(this.options.claudeOAuthPath)
			const credsStr = await fs.readFile(keyFile, "utf-8")
			return JSON.parse(credsStr)
		} catch (error) {
			console.error(
				`Error reading or parsing credentials file at ${getClaudeOAuthCredentialPath(this.options.claudeOAuthPath)}`,
			)
			throw new Error(`Failed to load Claude OAuth credentials: ${error}`)
		}
	}

	private isTokenValid(credentials: ClaudeOAuthCredentials): boolean {
		const TOKEN_REFRESH_BUFFER_MS = 30 * 1000
		if (!credentials.expiry_date) {
			return false
		}
		return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS
	}

	private async doRefreshAccessToken(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
		if (!credentials.refresh_token) {
			throw new Error("No refresh token available in credentials.")
		}

		// Note: The actual OAuth token refresh endpoint for Claude Pro/Max
		// will need to be determined from Anthropic's OAuth documentation.
		// This is a placeholder implementation that follows the standard OAuth2 pattern.
		const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/oauth/token"

		const bodyData = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh_token,
		})

		const response = await fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: bodyData.toString(),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorText}`)
		}

		const tokenData = await response.json()

		if (tokenData.error) {
			throw new Error(`Token refresh failed: ${tokenData.error} - ${tokenData.error_description}`)
		}

		const newCredentials: ClaudeOAuthCredentials = {
			...credentials,
			access_token: tokenData.access_token,
			token_type: tokenData.token_type || credentials.token_type,
			refresh_token: tokenData.refresh_token || credentials.refresh_token,
			expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
		}

		const filePath = getClaudeOAuthCredentialPath(this.options.claudeOAuthPath)
		try {
			const dir = path.dirname(filePath)
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(filePath, JSON.stringify(newCredentials, null, 2))
		} catch (error) {
			console.error("Failed to save refreshed credentials:", error)
		}

		return newCredentials
	}

	private async refreshAccessToken(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials)

		try {
			const result = await this.refreshPromise
			return result
		} finally {
			this.refreshPromise = null
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		if (!this.credentials) {
			this.credentials = await this.loadCachedClaudeCredentials()
		}

		if (!this.isTokenValid(this.credentials)) {
			this.credentials = await this.refreshAccessToken(this.credentials)
		}

		this.client = new Anthropic({
			baseURL: this.options.anthropicBaseUrl || undefined,
			apiKey: this.credentials.access_token,
		})
	}

	protected override async callApiWithRetry<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureAuthenticated()

		try {
			return await fn()
		} catch (error: unknown) {
			if (error && typeof error === "object" && "status" in error && error.status === 401) {
				this.credentials = await this.refreshAccessToken(this.credentials!)
				this.client = new Anthropic({
					baseURL: this.options.anthropicBaseUrl || undefined,
					apiKey: this.credentials.access_token,
				})
				return await fn()
			}
			throw error
		}
	}
}
