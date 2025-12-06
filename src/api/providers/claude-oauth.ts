import { promises as fs } from "node:fs"
import * as crypto from "node:crypto"
import { Anthropic } from "@anthropic-ai/sdk"
import * as os from "os"
import * as path from "path"

import type { ApiHandlerOptions } from "../../shared/api"
import { AnthropicHandler } from "./anthropic"

const CLAUDE_OAUTH_DIR = ".claude"
const CLAUDE_OAUTH_CREDENTIAL_FILENAME = "oauth_creds.json"
const CLAUDE_OAUTH_PENDING_FILENAME = "oauth_pending.json"
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference"

interface ClaudeOAuthCredentials {
	access_token: string
	refresh_token: string
	token_type: string
	expiry_date: number
}

interface ClaudeOAuthPending {
	verifier: string
	createdAt: number
}

interface ClaudeOAuthHandlerOptions extends ApiHandlerOptions {
	claudeOAuthPath?: string
	claudeOAuthCode?: string
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

function getClaudeOAuthPendingPath(): string {
	return path.join(os.homedir(), CLAUDE_OAUTH_DIR, CLAUDE_OAUTH_PENDING_FILENAME)
}

/**
 * Generate PKCE (Proof Key for Code Exchange) challenge and verifier.
 * Based on RFC 7636 and opencode's implementation.
 */
function generatePKCE(): { verifier: string; challenge: string } {
	// Generate a random 32-byte verifier and encode as base64url
	const verifierBytes = crypto.randomBytes(32)
	const verifier = verifierBytes.toString("base64url")

	// Generate SHA-256 hash of verifier and encode as base64url
	const challengeBytes = crypto.createHash("sha256").update(verifier).digest()
	const challenge = challengeBytes.toString("base64url")

	return { verifier, challenge }
}

/**
 * Generate the authorization URL for Claude OAuth.
 * Returns the URL and the PKCE verifier that must be stored for the exchange step.
 */
export function generateClaudeOAuthUrl(): { url: string; verifier: string } {
	const pkce = generatePKCE()

	const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL)
	url.searchParams.set("code", "true")
	url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI)
	url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES)
	url.searchParams.set("code_challenge", pkce.challenge)
	url.searchParams.set("code_challenge_method", "S256")
	url.searchParams.set("state", pkce.verifier)

	return {
		url: url.toString(),
		verifier: pkce.verifier,
	}
}

/**
 * Start the OAuth flow by generating the authorization URL and saving the pending state.
 * Returns the URL that should be opened in the browser.
 */
export async function startClaudeOAuthFlow(): Promise<string> {
	const { url, verifier } = generateClaudeOAuthUrl()

	// Save the pending state
	const pendingPath = getClaudeOAuthPendingPath()
	const pendingDir = path.dirname(pendingPath)
	await fs.mkdir(pendingDir, { recursive: true })

	const pending: ClaudeOAuthPending = {
		verifier,
		createdAt: Date.now(),
	}
	await fs.writeFile(pendingPath, JSON.stringify(pending, null, 2))

	return url
}

/**
 * Load the pending OAuth state (PKCE verifier).
 */
async function loadPendingOAuthState(): Promise<ClaudeOAuthPending | null> {
	try {
		const pendingPath = getClaudeOAuthPendingPath()
		const content = await fs.readFile(pendingPath, "utf-8")
		return JSON.parse(content) as ClaudeOAuthPending
	} catch {
		return null
	}
}

/**
 * Clear the pending OAuth state after successful exchange.
 */
async function clearPendingOAuthState(): Promise<void> {
	try {
		const pendingPath = getClaudeOAuthPendingPath()
		await fs.unlink(pendingPath)
	} catch {
		// Ignore errors if file doesn't exist
	}
}

/**
 * Exchange the authorization code for access and refresh tokens.
 * The code format from Anthropic is: {code}#{state}
 *
 * @param codeInput The authorization code (may include #state suffix)
 * @param credentialPath Optional custom path for storing credentials
 * @returns The OAuth credentials
 */
export async function exchangeClaudeOAuthCode(
	codeInput: string,
	credentialPath?: string,
): Promise<ClaudeOAuthCredentials> {
	// Load the pending state to get the verifier
	const pending = await loadPendingOAuthState()
	if (!pending) {
		throw new Error(
			"No pending OAuth state found. Please start the OAuth flow first by opening the authorization URL.",
		)
	}

	// Check if the pending state is too old (more than 10 minutes)
	const TEN_MINUTES_MS = 10 * 60 * 1000
	if (Date.now() - pending.createdAt > TEN_MINUTES_MS) {
		await clearPendingOAuthState()
		throw new Error("OAuth state expired. Please start the OAuth flow again.")
	}

	// Parse the code - it may be in format "code#state" or just "code"
	const splits = codeInput.split("#")
	const code = splits[0]
	const state = splits[1] // May be undefined if user only pasted the code

	// Exchange the code for tokens
	const response = await fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			code,
			state: state || pending.verifier, // Use state from code if available, otherwise from pending
			grant_type: "authorization_code",
			client_id: CLAUDE_OAUTH_CLIENT_ID,
			redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
			code_verifier: pending.verifier,
		}),
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`OAuth code exchange failed: ${response.status} ${response.statusText}. Response: ${errorText}`)
	}

	const tokenData = (await response.json()) as {
		access_token: string
		refresh_token: string
		expires_in: number
		token_type?: string
		error?: string
		error_description?: string
	}

	if (tokenData.error) {
		throw new Error(`OAuth code exchange failed: ${tokenData.error} - ${tokenData.error_description}`)
	}

	// Create credentials object
	const credentials: ClaudeOAuthCredentials = {
		access_token: tokenData.access_token,
		refresh_token: tokenData.refresh_token,
		token_type: tokenData.token_type || "Bearer",
		expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
	}

	// Save credentials to file
	const filePath = getClaudeOAuthCredentialPath(credentialPath)
	const dir = path.dirname(filePath)
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(filePath, JSON.stringify(credentials, null, 2))

	// Clear the pending state
	await clearPendingOAuthState()

	return credentials
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
		// If an OAuth code is provided in the config, exchange it for tokens first
		if (this.options.claudeOAuthCode && !this.credentials) {
			try {
				this.credentials = await exchangeClaudeOAuthCode(
					this.options.claudeOAuthCode,
					this.options.claudeOAuthPath,
				)
				// Clear the code from options after successful exchange to prevent re-use
				// Note: The UI should also clear this field after successful authentication
			} catch (error) {
				console.error("Failed to exchange OAuth code:", error)
				// Fall through to try loading cached credentials
			}
		}

		// Try to load cached credentials if we don't have any
		if (!this.credentials) {
			try {
				this.credentials = await this.loadCachedClaudeCredentials()
			} catch (error) {
				// If no cached credentials and no code was provided, provide helpful error
				const authUrl = await startClaudeOAuthFlow()
				throw new Error(
					`No Claude OAuth credentials found. To authenticate:\n` +
						`1. Open this URL in your browser: ${authUrl}\n` +
						`2. Complete the authorization\n` +
						`3. Copy the code shown at the end\n` +
						`4. Paste it into the "Claude OAuth Code" field in provider settings`,
				)
			}
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
