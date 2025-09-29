# CodeLab Extension - Quick Start Guide

## Testing the Extension

1. **Open in VS Code**:
   ```bash
   code .
   ```

2. **Launch Extension Development Host**:
   - Press `F5` or go to Run → Start Debugging
   - A new VS Code window will open with the extension loaded

3. **Test with MDCL file**:
   - In the new window, open `command-examples.mdcl`
   - You should see:
     - CodeLens hints above each command
     - A status bar item "MDCL Preview"
     - Syntax highlighting for MDCL commands
     - Automatic preview panel opening

4. **Test Features**:
   - **CodeLens**: Click the hints above commands to execute them
   - **Preview**: Auto-opens with live preview
   - **Execute**: Commands marked with `{{ execute }}` will run in terminal
   - **Copy**: Commands marked with `{{ copy }}` will copy to clipboard
   - **Open**: File paths marked with `{{ open }}` will open in editor
   - **Admonitions**: See styled callout boxes for notes, tips, warnings, etc.
   - **Quizzes**: Interactive quiz questions with validation

## Building for Production

1. **Use the build script** (recommended):
   ```bash
   ./build.sh
   ```
   This will:
   - Install dependencies
   - Bundle with esbuild
   - Create the `.vsix` package

2. **Manual build**:
   ```bash
   npm install
   npm run package
   npx @vscode/vsce package
   ```

3. **Install locally**:
   ```bash
   code --install-extension codelabv2-1.1.0.vsix
   ```

## Publishing to Marketplace

1. **Create publisher account** at https://marketplace.visualstudio.com/manage

2. **Get Personal Access Token** from Azure DevOps

3. **Login with vsce**:
   ```bash
   npx @vscode/vsce login mjtechguy
   ```

4. **Publish**:
   ```bash
   npx @vscode/vsce publish
   ```

## Configuration

Users can configure the extension in VS Code settings:

- `mdcl.openRelative`: "File" or "Workspace" - determines how relative paths are resolved
- `mdcl.enableCodeLens`: true/false - toggle CodeLens hints
- `mdcl.autoOpenPreview`: true/false - automatically open preview for .mdcl files
- `mdcl.interruptDelay`: milliseconds - delay between interrupt signal and command execution

## File Structure

```
codelab-v2/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── commandParser.ts      # Parses MDCL syntax
│   ├── commandExecutor.ts    # Executes commands
│   ├── codeLensProvider.ts   # Provides CodeLens hints
│   ├── previewPanel.ts       # WebView preview panel
│   ├── quizProcessor.ts      # Quiz parsing and rendering
│   └── answerKeyLoader.ts    # Answer key YAML loader
├── syntaxes/
│   └── mdcl.tmLanguage.json  # Syntax highlighting grammar
├── icons/                    # Extension and file icons
├── esbuild.js                # Build configuration
├── package.json              # Extension manifest
└── tsconfig.json             # TypeScript configuration
```