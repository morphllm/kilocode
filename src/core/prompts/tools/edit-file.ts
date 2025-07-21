export function getEditFileDescription(): string {
	return `## edit_file

**Description**: Use this tool to make an edit to an existing file.

This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.

When writing the edit, you should specify each edit in sequence, with the special comment \`// ... existing code ...\` to represent unchanged code in between edited lines.

**Example Format**:
\`\`\`
// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...
THIRD_EDIT
// ... existing code ...
\`\`\`

**REQUIRED Parameters**:

1. **target_file** (string): The target file to modify. Always specify the full path to the file you want to edit.

2. **instructions** (string): A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit. Use the first person to describe what you are going to do. Use it to disambiguate uncertainty in the edit.

3. **code_edit** (string): Specify ONLY the precise lines of code that you wish to edit. NEVER specify or write out unchanged code. Instead, represent all unchanged code using the comment of the language you're editing in - example: \`// ... existing code ...\`

**Critical Rules**:
- You should bias towards repeating as few lines of the original file as possible to convey the change
- Each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity
- DO NOT omit spans of pre-existing code (or comments) without using the \`// ... existing code ...\` comment to indicate its absence
- If you omit the existing code comment, the model may inadvertently delete these lines
- If you plan on deleting a section, you must provide context before and after to delete it
- ALWAYS make all edits to a file in a single edit_file call instead of multiple edit_file calls to the same file

**Deletion Example**: 
If the initial code is:
\`\`\`
Block 1
Block 2  
Block 3
\`\`\`
And you want to remove Block 2, you would output:
\`\`\`
// ... existing code ...
Block 1
Block 3
// ... existing code ...
\`\`\`

**ALL THREE PARAMETERS (target_file, instructions, code_edit) ARE MANDATORY**`
}
