// kilocode_change: Morph fast apply -- file added

import path from "path"
import { promises as fs } from "fs"
import OpenAI from "openai"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { ToolUse, AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "../../shared/tools"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import { Experiments, ProviderSettings } from "@roo-code/types"
import { getKiloBaseUriFromToken } from "../../shared/kilocode/token"
import { DEFAULT_HEADERS } from "../../api/providers/constants"
import { TelemetryService } from "@roo-code/telemetry"

// Morph model pricing per 1M tokens
const MORPH_MODEL_PRICING = {
	"morph-v3-fast": {
		inputPrice: 0.8, // $0.8 per 1M tokens
		outputPrice: 1.2, // $1.2 per 1M tokens
	},
	"morph-v3-large": {
		inputPrice: 0.9, // $0.9 per 1M tokens
		outputPrice: 1.9, // $1.9 per 1M tokens
	},
	auto: {
		inputPrice: 0.9, // Default to morph-v3-large pricing
		outputPrice: 1.9,
	},
} as const

function calculateMorphCost(inputTokens: number, outputTokens: number, model: string): number {
	const normalizedModel = model.replace("morph/", "") // Remove OpenRouter prefix if present
	const pricing =
		MORPH_MODEL_PRICING[normalizedModel as keyof typeof MORPH_MODEL_PRICING] || MORPH_MODEL_PRICING["auto"]

	const inputCost = (pricing.inputPrice / 1_000_000) * inputTokens
	const outputCost = (pricing.outputPrice / 1_000_000) * outputTokens

	return inputCost + outputCost
}

async function validateParams(
	cline: Task,
	targetFile: string | undefined,
	instructions: string | undefined,
	codeEdit: string | undefined,
	pushToolResult: PushToolResult,
): Promise<boolean> {
	if (!targetFile) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("edit_file")
		pushToolResult(await cline.sayAndCreateMissingParamError("edit_file", "target_file"))
		return false
	}

	if (!instructions) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("edit_file")
		pushToolResult(await cline.sayAndCreateMissingParamError("edit_file", "instructions"))
		return false
	}

	if (codeEdit === undefined) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("edit_file")
		pushToolResult(await cline.sayAndCreateMissingParamError("edit_file", "code_edit"))
		return false
	}

	return true
}

export async function editFileTool(
	cline: Task,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
): Promise<void> {
	const target_file: string | undefined = block.params.target_file
	const instructions: string | undefined = block.params.instructions
	const code_edit: string | undefined = block.params.code_edit

	try {
		// Handle partial tool use
		if (block.partial) {
			const partialMessageProps = {
				tool: "editFile" as const,
				path: getReadablePath(cline.cwd, removeClosingTag("target_file", target_file)),
				instructions: removeClosingTag("instructions", instructions),
				codeEdit: removeClosingTag("code_edit", code_edit),
			}
			await cline.ask("tool", JSON.stringify(partialMessageProps), block.partial).catch(() => {
				// Roo tools ignore exceptions as well here
			})
			return
		}

		// Validate required parameters
		if (!(await validateParams(cline, target_file, instructions, code_edit, pushToolResult))) {
			return
		}

		// At this point we know all parameters are defined, so we can safely cast them
		const targetFile = target_file as string
		const editInstructions = instructions as string
		const editCode = code_edit as string

		// Validate and resolve the file path
		const absolutePath = path.resolve(cline.cwd, targetFile)
		const relPath = getReadablePath(cline.cwd, absolutePath)

		// Check if file access is allowed
		const accessAllowed = cline.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await cline.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		// Check if file exists
		if (!(await fileExistsAtPath(absolutePath))) {
			await fs.writeFile(absolutePath, "")
		}

		// Read the original file content
		const originalContent = await fs.readFile(absolutePath, "utf-8")

		// Check if Morph is available
		const morphApplyResult = await applyMorphEdit(originalContent, editInstructions, editCode, cline, relPath)

		if (!morphApplyResult.success) {
			cline.consecutiveMistakeCount++
			cline.recordToolError("edit_file")
			pushToolResult(formatResponse.toolError(`Failed to apply edit using Morph: ${morphApplyResult.error}`))
			return
		}

		const newContent = morphApplyResult.result!

		// Show the diff and ask for approval
		cline.diffViewProvider.editType = "modify"
		await cline.diffViewProvider.open(relPath)

		// Stream the content to show the diff
		await cline.diffViewProvider.update(newContent, true)
		cline.diffViewProvider.scrollToFirstDiff()

		// Ask for user approval
		const approved = await askApproval(
			"tool",
			JSON.stringify({
				tool: "editedExistingFile",
				path: relPath,
				isProtected: cline.rooProtectedController?.isWriteProtected(relPath) || false,
				instructions: editInstructions,
			}),
			undefined,
			cline.rooProtectedController?.isWriteProtected(relPath) || false,
		)

		if (!approved) {
			await cline.diffViewProvider.revertChanges()
			pushToolResult(formatResponse.toolResult("Edit cancelled by user."))
			return
		}

		// Apply the changes
		await cline.diffViewProvider.saveChanges()

		// Track file context
		await cline.fileContextTracker.trackFileContext(relPath, "roo_edited")
		cline.didEditFile = true
		cline.consecutiveMistakeCount = 0

		// Get the formatted response message
		const message = await cline.diffViewProvider.pushToolWriteResult(cline, cline.cwd, false)
		pushToolResult(message)

		await cline.diffViewProvider.reset()
	} catch (error) {
		TelemetryService.instance.captureException(error, { context: "editFileTool" })
		await handleError("editing file with Morph", error as Error)
		await cline.diffViewProvider.reset()
	}
}

interface MorphApplyResult {
	success: boolean
	result?: string
	error?: string
}

async function applyMorphEdit(
	originalContent: string,
	instructions: string,
	codeEdit: string,
	cline: Task,
	filePath?: string,
): Promise<MorphApplyResult> {
	try {
		// Get the current API configuration
		const provider = cline.providerRef.deref()
		if (!provider) {
			return { success: false, error: "No API provider available" }
		}

		const state = await provider.getState()

		// Check if user has Morph enabled via OpenRouter or direct API
		const morphConfig = await getMorphConfiguration(state.experiments, state.apiConfiguration, state)
		if (!morphConfig.available) {
			return { success: false, error: morphConfig.error || "Morph is not available" }
		}

		// Create api_req_started message for tracking
		const morphApiReqIndex = cline.clineMessages.length

		// Create a verbose request description similar to regular API requests
		const fileName = filePath ? path.basename(filePath) : "unknown file"
		const truncatedCodeEdit = codeEdit.length > 500 ? codeEdit.substring(0, 500) + "\n...(truncated)" : codeEdit
		const morphRequestDescription = [
			`Morph FastApply Edit (${morphConfig.model})`,
			``,
			`File: ${fileName}`,
			`Instructions: ${instructions}`,
			``,
			`Code Edit:`,
			"```",
			truncatedCodeEdit,
			"```",
			``,
			`Original Content: ${originalContent.length} characters`,
		].join("\n")

		await cline.say(
			"api_req_started",
			JSON.stringify({
				request: morphRequestDescription,
				apiProtocol: "openai",
			}),
		)

		// Create OpenAI client for Morph API
		const client = new OpenAI({
			apiKey: morphConfig.apiKey,
			baseURL: morphConfig.baseUrl,
			defaultHeaders: {
				"X-KiloCode-TaskId": cline.taskId,
				...DEFAULT_HEADERS,
			},
		})

		// Apply the edit using Morph's format
		const prompt = `<instructions>${instructions}</instructions>\n<code>${originalContent}</code>\n<update>${codeEdit}</update>`

		const response = await client.chat.completions.create(
			{
				model: morphConfig.model!,
				messages: [
					{
						role: "user",
						content: prompt,
					},
				],
			},
			{
				timeout: 30000, // 30 second timeout
			},
		)

		const mergedCode = response.choices[0]?.message?.content
		if (!mergedCode) {
			return { success: false, error: "Morph API returned empty response" }
		}

		// Extract usage information from response
		const usage = response.usage
		const inputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const cost = calculateMorphCost(inputTokens, outputTokens, morphConfig.model!)

		// Update the api_req_started message with usage and cost data
		const existingData = JSON.parse(cline.clineMessages[morphApiReqIndex].text || "{}")
		cline.clineMessages[morphApiReqIndex].text = JSON.stringify({
			...existingData,
			tokensIn: inputTokens,
			tokensOut: outputTokens,
			cost: cost,
		})

		return { success: true, result: mergedCode }
	} catch (error) {
		TelemetryService.instance.captureException(error, { context: "applyMorphEdit" })
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error occurred",
		}
	}
}

interface MorphConfiguration {
	available: boolean
	apiKey?: string
	baseUrl?: string
	model?: string
	error?: string
}

async function getMorphConfiguration(
	experiments: Experiments,
	apiConfig: ProviderSettings,
	globalState: any, // kilocode_change: Added to access global morphApiKey
): Promise<MorphConfiguration> {
	// Check if Morph is enabled in API configuration
	if (experiments.morphFastApply !== true) {
		return {
			available: false,
			error: "Morph is disabled. Enable it in API Options > Enable Editing with Morph FastApply",
		}
	}

	// Check if user has direct Morph API key in global settings
	const hasGlobalMorphApiKey = Boolean(globalState.morphApiKey)

	// Check if provider supports Morph natively (openrouter only for now)
	const isOpenRouterProvider = apiConfig.apiProvider === "openrouter" && Boolean(apiConfig.openRouterApiKey)
	const hasNativeMorphSupport = isOpenRouterProvider

	// Morph is available if: (provider supports it natively) OR (has global morph API key)
	// If neither condition is met, behave as if Morph is disabled entirely
	if (!hasNativeMorphSupport && !hasGlobalMorphApiKey) {
		return {
			available: false,
			error: "Morph is disabled. Enable it in API Options > Enable Editing with Morph FastApply",
		}
	}

	// Priority 1: Use direct Morph API key if available
	if (hasGlobalMorphApiKey) {
		return {
			available: true,
			apiKey: globalState.morphApiKey,
			baseUrl: "https://api.morphllm.com/v1",
			model: "auto",
		}
	}

	// Priority 2: Use KiloCode provider
	if (apiConfig.apiProvider === "kilocode") {
		const token = apiConfig.kilocodeToken
		if (!token) {
			return { available: false, error: "No KiloCode token available to use Morph" }
		}
		return {
			available: true,
			apiKey: token,
			baseUrl: `${getKiloBaseUriFromToken(token)}/api/openrouter/`,
			model: "morph/morph-v3-large", // Morph model via OpenRouter
		}
	}

	// Priority 3: Use OpenRouter provider
	if (apiConfig.apiProvider === "openrouter") {
		const token = apiConfig.openRouterApiKey
		if (!token) {
			return { available: false, error: "No OpenRouter API token available to use Morph" }
		}
		return {
			available: true,
			apiKey: token,
			baseUrl: apiConfig.openRouterBaseUrl || "https://openrouter.ai/api/v1",
			model: "morph/morph-v3-large", // Morph model via OpenRouter
		}
	}

	// This should not be reached due to the check above, but included for completeness
	return {
		available: false,
		error: "Morph configuration error. Please check your settings.",
	}
}
