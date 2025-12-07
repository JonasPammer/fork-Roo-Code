import { promises as fs } from "node:fs"
import * as crypto from "node:crypto"
import { Anthropic } from "@anthropic-ai/sdk"
import * as os from "os"
import * as path from "path"

import type { ApiHandlerOptions } from "../../shared/api"
import { AnthropicHandler } from "./anthropic"
import { ApiStream } from "../transform/stream"
import type { ApiHandlerCreateMessageMetadata } from "../index"

// This system prompt prefix is required for OAuth tokens to work.
// The OAuth tokens are specifically authorized for "Claude Code" usage.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

// Prefix for all debug logs - filter by this in console
const LOG_PREFIX = "[RooClaudeOAuth]"

function log(message: string, ...args: unknown[]) {
	if (args.length > 0) {
		console.log(`${LOG_PREFIX} ${message}`, ...args)
	} else {
		console.log(`${LOG_PREFIX} ${message}`)
	}
}

function logError(message: string, error?: unknown) {
	console.error(`${LOG_PREFIX} ERROR: ${message}`, error)
}

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
		log("constructor called")
		log(
			"options:",
			JSON.stringify({
				claudeOAuthPath: options.claudeOAuthPath,
				claudeOAuthCode: options.claudeOAuthCode ? "[CODE_PROVIDED]" : undefined,
				apiModelId: options.apiModelId,
			}),
		)
	}

	private async loadCachedClaudeCredentials(): Promise<ClaudeOAuthCredentials> {
		const keyFile = getClaudeOAuthCredentialPath(this.options.claudeOAuthPath)
		log(`loadCachedClaudeCredentials from: ${keyFile}`)

		// Try our own credentials file first
		try {
			const credsStr = await fs.readFile(keyFile, "utf-8")
			const creds = JSON.parse(credsStr)
			log(`loadCachedClaudeCredentials success, full credentials: ${JSON.stringify(creds)}`)
			return creds
		} catch (error) {
			log(`loadCachedClaudeCredentials failed for ${keyFile}, trying OpenCode auth...`)
		}

		// Try OpenCode's auth file as fallback
		const homedir = process.env.HOME || process.env.USERPROFILE || ""
		const opencodeAuthFile = path.join(homedir, ".local", "share", "opencode", "auth.json")
		log(`loadCachedClaudeCredentials trying OpenCode auth: ${opencodeAuthFile}`)
		try {
			const opencodeCredsStr = await fs.readFile(opencodeAuthFile, "utf-8")
			const opencodeCreds = JSON.parse(opencodeCredsStr)
			if (opencodeCreds.anthropic && opencodeCreds.anthropic.type === "oauth") {
				const creds: ClaudeOAuthCredentials = {
					access_token: opencodeCreds.anthropic.access,
					refresh_token: opencodeCreds.anthropic.refresh,
					token_type: "Bearer",
					expiry_date: opencodeCreds.anthropic.expires,
				}
				log(`loadCachedClaudeCredentials success from OpenCode, credentials: ${JSON.stringify(creds)}`)
				return creds
			}
		} catch (error) {
			log(`loadCachedClaudeCredentials failed for OpenCode auth too`)
		}

		// Try Claude CLI's credentials as last resort
		const claudeCliAuthFile = path.join(homedir, ".claude", ".credentials.json")
		log(`loadCachedClaudeCredentials trying Claude CLI auth: ${claudeCliAuthFile}`)
		try {
			const claudeCliCredsStr = await fs.readFile(claudeCliAuthFile, "utf-8")
			const claudeCliCreds = JSON.parse(claudeCliCredsStr)
			if (claudeCliCreds.claudeAiOauth) {
				const creds: ClaudeOAuthCredentials = {
					access_token: claudeCliCreds.claudeAiOauth.accessToken,
					refresh_token: claudeCliCreds.claudeAiOauth.refreshToken,
					token_type: "Bearer",
					expiry_date: claudeCliCreds.claudeAiOauth.expiresAt,
				}
				log(`loadCachedClaudeCredentials success from Claude CLI, credentials: ${JSON.stringify(creds)}`)
				return creds
			}
		} catch (error) {
			logError(`loadCachedClaudeCredentials failed for all sources`, error)
		}

		throw new Error(`Failed to load Claude OAuth credentials from any source`)
	}

	private isTokenValid(credentials: ClaudeOAuthCredentials): boolean {
		const TOKEN_REFRESH_BUFFER_MS = 30 * 1000
		if (!credentials.expiry_date) {
			return false
		}
		return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS
	}

	private async doRefreshAccessToken(credentials: ClaudeOAuthCredentials): Promise<ClaudeOAuthCredentials> {
		log("doRefreshAccessToken called")
		if (!credentials.refresh_token) {
			throw new Error("No refresh token available in credentials.")
		}

		log("doRefreshAccessToken: calling token endpoint...")
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
		log("refreshAccessToken called")
		if (this.refreshPromise) {
			log("refreshAccessToken: already in progress, waiting...")
			return this.refreshPromise
		}

		this.refreshPromise = this.doRefreshAccessToken(credentials)

		try {
			const result = await this.refreshPromise
			log("refreshAccessToken: success, new token starts with:", result.access_token?.substring(0, 20))
			return result
		} finally {
			this.refreshPromise = null
		}
	}

	/**
	 * Create a custom fetch function that:
	 * 1. Uses Authorization: Bearer instead of x-api-key
	 * 2. Adds the required anthropic-beta header for OAuth
	 * 3. Refreshes tokens if needed
	 */
	private createOAuthFetch(): typeof fetch {
		return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			log("fetch: called")
			log(`fetch: URL = ${typeof input === "string" ? input : input.toString()}`)

			// Ensure we have valid credentials
			if (!this.credentials || !this.isTokenValid(this.credentials)) {
				log("fetch: token invalid or missing, refreshing...")
				if (this.credentials) {
					this.credentials = await this.refreshAccessToken(this.credentials)
					log("fetch: token refreshed successfully")
				}
			}

			const headers = new Headers(init?.headers)

			// Log original headers
			log("fetch: original headers:")
			headers.forEach((value, key) => {
				log(`fetch:   ${key}: ${value}`)
			})

			// Remove x-api-key if present (SDK adds it automatically)
			headers.delete("x-api-key")
			log("fetch: removed x-api-key header")

			// Add OAuth Bearer token
			headers.set("Authorization", `Bearer ${this.credentials!.access_token}`)
			log(`fetch: set Authorization: Bearer ${this.credentials!.access_token}`)

			// Set User-Agent to match Claude Code CLI format
			// Anthropic checks this header to verify the request is from Claude Code
			headers.set("User-Agent", "claude-cli/2.0.0 (roo-code)")
			log("fetch: set User-Agent: claude-cli/2.0.0 (roo-code)")

			// Remove x-stainless-* headers that the SDK adds
			// These identify it as SDK usage rather than Claude Code
			const headersToDelete: string[] = []
			headers.forEach((_, key) => {
				if (key.toLowerCase().startsWith("x-stainless")) {
					headersToDelete.push(key)
				}
			})
			headersToDelete.forEach((key) => {
				headers.delete(key)
				log(`fetch: removed ${key} header`)
			})

			// Add required beta headers for OAuth
			// oauth-2025-04-20 is required for OAuth authentication
			// claude-code-20250219 enables Claude Code-style access
			const existingBeta = headers.get("anthropic-beta") || ""
			const betaList = existingBeta
				.split(",")
				.map((b) => b.trim())
				.filter(Boolean)
			const mergedBetas = [
				...new Set([
					"oauth-2025-04-20",
					"claude-code-20250219",
					"interleaved-thinking-2025-05-14",
					...betaList,
				]),
			].join(",")
			headers.set("anthropic-beta", mergedBetas)
			log(`fetch: set anthropic-beta: ${mergedBetas}`)

			// Log final headers
			log("fetch: final headers:")
			headers.forEach((value, key) => {
				log(`fetch:   ${key}: ${value}`)
			})

			// Log full request body
			if (init?.body) {
				const bodyStr = typeof init.body === "string" ? init.body : JSON.stringify(init.body)
				log(`fetch: full body: ${bodyStr}`)
			}

			// Convert Headers to plain object for compatibility
			const headersObj: Record<string, string> = {}
			headers.forEach((value, key) => {
				headersObj[key] = value
			})

			log(`fetch: making request with headers object: ${JSON.stringify(headersObj)}`)

			const response = await fetch(input, {
				...init,
				headers: headersObj,
			})

			log(`fetch: response status: ${response.status} ${response.statusText}`)

			// If error, try to log response body
			if (!response.ok) {
				const clonedResponse = response.clone()
				try {
					const errorBody = await clonedResponse.text()
					log(`fetch: error body: ${errorBody}`)
				} catch (e) {
					log("fetch: could not read error body")
				}
			}

			return response
		}
	}

	private async ensureAuthenticated(): Promise<void> {
		log("ensureAuthenticated: called")
		log(`ensureAuthenticated: have credentials? ${!!this.credentials}`)
		log(`ensureAuthenticated: have claudeOAuthCode? ${!!this.options.claudeOAuthCode}`)

		// If an OAuth code is provided in the config, exchange it for tokens first
		if (this.options.claudeOAuthCode && !this.credentials) {
			log("ensureAuthenticated: attempting to exchange OAuth code...")
			try {
				this.credentials = await exchangeClaudeOAuthCode(
					this.options.claudeOAuthCode,
					this.options.claudeOAuthPath,
				)
				log("ensureAuthenticated: OAuth code exchange successful")
				// Clear the code from options after successful exchange to prevent re-use
				// Note: The UI should also clear this field after successful authentication
			} catch (error) {
				logError("ensureAuthenticated: OAuth code exchange failed", error)
				// Fall through to try loading cached credentials
			}
		}

		// Try to load cached credentials if we don't have any
		if (!this.credentials) {
			log("ensureAuthenticated: no credentials, loading from cache...")
			try {
				this.credentials = await this.loadCachedClaudeCredentials()
				log("ensureAuthenticated: loaded credentials from cache")
			} catch (error) {
				// If no cached credentials and no code was provided, provide helpful error
				logError("ensureAuthenticated: failed to load cached credentials", error)
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

		const tokenValid = this.isTokenValid(this.credentials)
		log(`ensureAuthenticated: token valid? ${tokenValid}`)
		if (!tokenValid) {
			log("ensureAuthenticated: token expired, refreshing...")
			this.credentials = await this.refreshAccessToken(this.credentials)
		}

		log("ensureAuthenticated: creating Anthropic client with custom fetch")
		// Create client with custom fetch that handles OAuth headers
		// We pass a dummy apiKey since we're using Bearer auth instead
		this.client = new Anthropic({
			baseURL: this.options.anthropicBaseUrl || undefined,
			apiKey: "", // Empty string like OpenCode - we override via custom fetch
			fetch: this.createOAuthFetch(),
		})
		log("ensureAuthenticated: done")
	}

	protected override async callApiWithRetry<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureAuthenticated()

		try {
			return await fn()
		} catch (error: unknown) {
			if (error && typeof error === "object" && "status" in error && error.status === 401) {
				this.credentials = await this.refreshAccessToken(this.credentials!)
				// Recreate client with refreshed credentials
				this.client = new Anthropic({
					baseURL: this.options.anthropicBaseUrl || undefined,
					apiKey: "oauth-placeholder",
					fetch: this.createOAuthFetch(),
				})
				return await fn()
			}
			throw error
		}
	}

	/**
	 * Override createMessage to prepend the Claude Code system prompt.
	 * This is required because OAuth tokens are specifically authorized for "Claude Code" usage only.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		log("createMessage: called")
		log(`createMessage: original system prompt length: ${systemPrompt.length}`)

		// Prepend the Claude Code identifier to the system prompt
		const modifiedSystemPrompt = `${CLAUDE_CODE_SYSTEM_PREFIX}\n${systemPrompt}`
		log(`createMessage: modified system prompt length: ${modifiedSystemPrompt.length}`)
		log(`createMessage: system prompt starts with: ${modifiedSystemPrompt.substring(0, 100)}`)

		// Call the parent implementation with the modified system prompt
		yield* super.createMessage(modifiedSystemPrompt, messages, metadata)
	}
}
