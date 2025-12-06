import { promises as fs } from "node:fs"
import { Anthropic } from "@anthropic-ai/sdk"
import * as os from "os"
import * as path from "path"

import type { ApiHandlerOptions } from "../../shared/api"
import { AnthropicHandler } from "./anthropic"

const CLAUDE_OAUTH_DIR = ".claude"
const CLAUDE_OAUTH_CREDENTIAL_FILENAME = "oauth_creds.json"
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"

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

		const response = await fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: credentials.refresh_token,
				client_id: CLAUDE_OAUTH_CLIENT_ID,
			}),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorText}`)
		}

		const tokenData = (await response.json()) as {
			access_token: string
			refresh_token?: string
			expires_in: number
			token_type?: string
			error?: string
			error_description?: string
		}

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
