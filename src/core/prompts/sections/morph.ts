import { checkMorphAvailability } from "../tools"

// Helper function to generate morph instructions when available
export function getMorphInstructions(
	cwd: string,
	supportsComputerUse: boolean,
	settings?: Record<string, any>,
): string {
	const morphAvailable = checkMorphAvailability({ cwd, supportsComputerUse, settings })
	return morphAvailable
		? `

		Morph FastApply is enabled. When making any file edits, you MUST ALWAYS use the \`edit_file\` tool instead of other editing tools like \`write_to_file\`, \`search_and_replace\`, or \`apply_diff\`. The \`edit_file\` tool uses a less intelligent specialized model to apply code edits to files.**
`
		: ""
}
