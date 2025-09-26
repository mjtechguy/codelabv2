# CodeLab VS Code Extension

CodeLab is a Visual Studio Code extension that transforms markdown files (`.mdcl`) into interactive command execution environments. Perfect for creating executable documentation, tutorials, training materials, and technical runbooks with live command execution capabilities.

## Features

### 🎯 Interactive Markdown Commands
CodeLab extends standard markdown with special command tags that become executable:

- **Execute in Terminal**: Run commands in VS Code's integrated terminal with visual feedback
- **Copy to Clipboard**: Click to copy code snippets directly to clipboard
- **Open Files**: Open files relative to the current document or workspace
- **Terminal Targeting**: Execute commands in specific named terminal instances
- **Block Execution**: Run multiple commands with a single button
- **Execution Tracking**: Visual indicators (green checkmark) for executed commands

### 📝 Command Syntax

#### Individual Commands
Embed executable commands in markdown using backticks and action tags:

```markdown
`echo "Hello World"` {{ execute }}
`npm install` {{ execute }}
`./src/main.ts` {{ open }}
`const data = []` {{ copy }}
`npm test` {{ execute 't2' }}  # Execute in terminal named 't2'
`npm start` {{ execute interrupt }}  # Interrupt current process first
```

#### Multi-line Commands in Code Blocks
Create code blocks with multiple executable commands, each with its own button:

````markdown
```
`echo "First command"` {{ execute }}
`echo "Second command"` {{ execute }}
`echo "Third command"` {{ execute }}
```
````

#### Block Execution (Run All)
Execute multiple commands with a single "Run All" button:

````markdown
```{{ execute }}
echo "Command 1"
echo "Command 2"
echo "Command 3"
```
````

### 👁️ Live Preview Panel
- Automatically opens when viewing `.mdcl` files
- Side-by-side view with the source markdown
- Interactive command buttons with hover effects
- Auto-refresh on document changes
- Maintains scroll position when switching tabs
- Visual execution tracking with green checkmarks
- Styled code blocks with syntax highlighting

### 🔍 CodeLens Integration
- Inline executable commands appear as CodeLens hints above the code
- Click to run, copy, or open files directly from the editor
- Support for terminal targeting and interrupt commands
- Toggle visibility via extension settings

## Requirements

- Visual Studio Code version 1.85.0 or higher
- Node.js and npm (for development and building)

## Installation

### From VSIX Package
1. Download or build the `codelab-0.0.1.vsix` file
2. Install using one of these methods:
   - **Command line**: `code --install-extension codelab-0.0.1.vsix`
   - **VS Code GUI**:
     1. Open Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
     2. Click `...` menu → `Install from VSIX...`
     3. Select the `codelab-0.0.1.vsix` file

### Building from Source
```bash
# Clone the repository
git clone https://github.com/yourusername/codelab-v2.git
cd codelab-v2

# Install dependencies
npm install

# Build the extension
./build.sh

# Install the generated VSIX
code --install-extension codelab-0.0.1.vsix
```

## Extension Settings

Configure CodeLab through VS Code settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `mdcl.enableCodeLens` | Enable/disable CodeLens for executable commands | `true` |
| `mdcl.autoOpenPreview` | Automatically open preview for `.mdcl` files | `true` |
| `mdcl.openRelative` | Basis for opening files using relative paths | `"File"` |
| | • `"File"`: Relative to the current markdown file | |
| | • `"Workspace"`: Relative to the workspace folder | |
| `mdcl.interruptDelay` | Delay (ms) between interrupt signal and new command | `200` |

## Usage

### Creating Interactive Documentation

1. **Create a `.mdcl` file** (CodeLab markdown)
2. **Add command tags** using the syntax: `` `command` {{ action }} ``
3. **Preview automatically opens** (or use `Cmd+Shift+V` / `Ctrl+Shift+V`)
4. **Click buttons** in the preview or CodeLens to execute commands
5. **Track execution** with green checkmarks on executed commands

### Complete Example

Create a file named `tutorial.mdcl`:

```markdown
# My Project Setup

## Install Dependencies

First, let's install our project dependencies:
`npm install` {{ execute }}

## Run Tests

Run the test suite in a separate terminal:
`npm test` {{ execute 't2' }}

## Start Development Server

```{{ execute }}
echo "Starting development environment..."
npm run dev
```

## Multiple Commands Example

Run these commands individually:
```
`git status` {{ execute }}
`git branch` {{ execute }}
`git log --oneline -5` {{ execute }}
```

## Configuration

Copy this configuration to your clipboard:
`{ "port": 3000, "debug": true }` {{ copy }}

## Open Files

Open the main application file:
`src/index.ts` {{ open }}
```

## Commands

The extension provides the following commands:

- **MDCL: Open Preview** (`mdcl.openPreview`) - Opens the interactive preview panel
- **MDCL: Execute Command** (`mdcl.executeCommand`) - Executes a command in terminal
- **MDCL: Copy Command** (`mdcl.copyCommand`) - Copies command to clipboard
- **MDCL: Open File** (`mdcl.openFile`) - Opens a file in the editor
- **MDCL: Refresh CodeLens** (`mdcl.refreshCodeLens`) - Manually refresh code lenses

## Architecture

CodeLab is built with:
- **TypeScript** for type safety and better IDE support
- **VS Code Extension API** for deep editor integration
- **Marked.js** for markdown parsing and rendering
- **WebView API** for the interactive preview panel
- **CodeLens Provider** for inline command execution

## File Format

CodeLab uses `.mdcl` files (Markdown CodeLab) which are standard markdown files with embedded executable commands. The extension automatically activates when opening `.mdcl` files.

## Terminal Management

- Commands execute in terminals named "CodeLab - main" by default
- Create named terminals with `{{ execute 'terminalName' }}`
- Terminals persist across command executions
- Use `{{ execute interrupt }}` to send Ctrl+C before executing

## Features in Detail

### Execution Tracking
- Buttons show a green border and checkmark when executed
- Each button tracks independently (even duplicate commands)
- State persists within the current session

### Scroll Position Persistence
- Preview maintains scroll position when switching tabs
- Automatically restores position when returning to preview

### Block Commands
- Wrap multiple commands in eval to reduce terminal echo
- Commands are joined with `&&` for sequential execution
- Single "Run All" button for entire block

## Release Notes

### 0.0.1

Latest features:
- Interactive markdown command execution with `.mdcl` files
- Live preview panel with auto-open support
- CodeLens integration for inline execution
- Multi-terminal support with named terminals
- Visual execution tracking with green indicators
- Scroll position persistence
- Block command execution
- File opening with configurable paths

## Development

### Project Structure
```
codelab-v2/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── previewPanel.ts       # Preview panel implementation
│   ├── commandExecutor.ts    # Command execution logic
│   ├── commandParser.ts      # Command parsing from markdown
│   └── codeLensProvider.ts   # CodeLens provider
├── syntaxes/
│   └── mdcl.tmLanguage.json  # Syntax highlighting for .mdcl
├── package.json               # Extension manifest
├── tsconfig.json              # TypeScript configuration
└── build.sh                   # Build script
```

### Building the Extension

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Build VSIX package
./build.sh

# Watch for changes during development
npm run watch
```

### Testing

1. Press `F5` in VS Code to launch a new Extension Development Host
2. Create a `.mdcl` file to test the features
3. Use the preview panel and CodeLens to execute commands

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

---

**Enjoy creating interactive documentation with CodeLab!**
