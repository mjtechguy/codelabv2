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
   - In the new window, open the `test.mdcl` file
   - You should see:
     - CodeLens hints above each command
     - A status bar item "MDCL Preview"
     - Syntax highlighting for MDCL commands

4. **Test Features**:
   - **CodeLens**: Click the hints above commands to execute them
   - **Preview**: Click the status bar item or use Command Palette → "Open MDCL Preview"
   - **Execute**: Commands marked with `{{ execute }}` will run in terminal
   - **Copy**: Commands marked with `{{ copy }}` will copy to clipboard
   - **Open**: File paths marked with `{{ open }}` will open in editor

## Building for Production

1. **Install vsce** (VS Code Extension manager):
   ```bash
   npm install -g vsce
   ```

2. **Package the extension**:
   ```bash
   vsce package
   ```
   This creates a `.vsix` file

3. **Install locally**:
   ```bash
   code --install-extension codelab-0.0.1.vsix
   ```

## Publishing to Marketplace

1. **Create publisher account** at https://marketplace.visualstudio.com/manage

2. **Get Personal Access Token** from Azure DevOps

3. **Login with vsce**:
   ```bash
   vsce login mjtechguy
   ```

4. **Publish**:
   ```bash
   vsce publish
   ```

## Configuration

Users can configure the extension in VS Code settings:

- `mdcl.openRelative`: "File" or "Workspace" - determines how relative paths are resolved
- `mdcl.enableCodeLens`: true/false - toggle CodeLens hints
- `mdcl.interruptDelay`: milliseconds - delay between interrupt signal and command execution

## File Structure

```
codelab-v2/
├── src/
│   ├── extension.ts         # Main extension entry point
│   ├── commandParser.ts     # Parses MDCL syntax
│   ├── commandExecutor.ts   # Executes commands
│   ├── codeLensProvider.ts  # Provides CodeLens hints
│   └── previewPanel.ts      # WebView preview panel
├── syntaxes/
│   └── mdcl.tmLanguage.json # Syntax highlighting grammar
├── package.json             # Extension manifest
└── tsconfig.json           # TypeScript configuration
```