# Future MDCL Commands - Enhancement Roadmap

## Overview
This document outlines potential new command types that could enhance the MDCL extension for creating more interactive and powerful documentation, tutorials, and code labs.

## Proposed Command Categories

### 1. Environment & Variable Management
These commands help manage the execution environment across multiple commands.

#### Set Environment Variable
```markdown
`export API_KEY=your-key-here` {{ setenv }}
`NODE_ENV=production` {{ setenv }}
```
- Sets environment variables that persist for subsequent commands in the same session
- Useful for configuration and setup steps

#### Expand Variables
```markdown
`echo $HOME` {{ expand }}
`${WORKSPACE_ROOT}/config` {{ expand }}
```
- Expands and displays environment variables
- Helps users understand their environment

#### Secret Input
```markdown
`Enter API Key:` {{ secret }}
`Database Password:` {{ secret mask="*" }}
```
- Prompts for sensitive input with masked characters
- Stores securely for session use

### 2. File & Directory Operations
Enhanced file management beyond just opening files.

#### Create File
```markdown
`package.json` {{ create }}
```
````markdown
```json
{
  "name": "my-app",
  "version": "1.0.0"
}
``` {{ create "package.json" }}
````
- Creates a new file with specified content
- Content can be inline or in a code block above

#### Create Directory
```markdown
`src/components` {{ mkdir }}
`./test/fixtures` {{ mkdir recursive }}
```
- Creates directories
- Optional recursive flag for nested directories

#### Rename/Move
```markdown
`old-name.js -> new-name.js` {{ rename }}
`temp.txt -> archive/temp.txt` {{ move }}
```
- Rename or move files and directories

#### Delete
```markdown
`temp.log` {{ delete }}
`node_modules` {{ delete confirm }}
```
- Delete files or directories
- Optional confirmation prompt

#### Download
```markdown
`config.json` {{ download "https://example.com/config.json" }}
`data.csv` {{ download "https://api.example.com/export" }}
```
- Download files from URLs
- Useful for fetching templates or sample data

### 3. Validation & Testing
Commands that validate outputs and ensure correct execution.

#### Expect Output
```markdown
`npm test` {{ expect "All tests passed" }}
`node --version` {{ expect regex="v\d+\.\d+\.\d+" }}
```
- Run command and validate output contains expected text
- Support for regex patterns

#### Assert Version
```markdown
`node --version` {{ assert ">= 18.0.0" }}
`python --version` {{ assert "3.9+" }}
```
- Check version requirements
- Useful for prerequisites

#### Check Existence
```markdown
`package.json` {{ exists }}
`node_modules/react` {{ exists dir }}
```
- Verify files or directories exist
- Good for validation steps

#### Wait & Retry
```markdown
`curl localhost:3000` {{ wait 5 retry 3 }}
`docker ps` {{ wait until="my-container" timeout=30 }}
```
- Wait for services to be ready
- Retry commands with configurable attempts

### 4. Process & Execution Control
Advanced command execution patterns.

#### Background Execution
```markdown
`npm start` {{ background }}
`python server.py` {{ background name="server" }}
```
- Run commands in background
- Named processes for later reference

#### Kill Process
```markdown
`server` {{ kill }}
`3000` {{ kill port }}
`node` {{ kill process }}
```
- Kill background processes by name
- Kill processes on specific ports
- Kill by process name

#### Sequence
```markdown
`npm install && npm build && npm test` {{ sequence }}
```
```markdown
{{ sequence }}
1. `npm install`
2. `npm build`
3. `npm test`
{{ /sequence }}
```
- Run multiple commands in order
- Stop on first failure

#### Parallel
```markdown
`npm test` {{ parallel "npm lint" "npm typecheck" }}
```
```markdown
{{ parallel }}
- `npm test`
- `npm lint`
- `npm typecheck`
{{ /parallel }}
```
- Run commands simultaneously
- Wait for all to complete

### 5. User Interaction
Commands that interact with the user during execution.

#### Text Input
```markdown
`Enter project name:` {{ input }}
`Username:` {{ input default="admin" }}
```
- Prompt for user input
- Optional default values

#### Choice Selection
```markdown
`Select environment:` {{ choice ["dev", "staging", "prod"] }}
`Continue?` {{ confirm }}
```
- Multiple choice selection
- Yes/no confirmation

#### Multi-select
```markdown
`Select features:` {{ multiselect ["auth", "database", "api", "ui"] }}
```
- Allow multiple selections
- Returns array of choices

### 6. Output & Display
Enhanced output formatting and saving.

#### Save Output
```markdown
`npm list` {{ save "dependencies.txt" }}
`git log --oneline` {{ save append="history.log" }}
```
- Save command output to file
- Append option for logs

#### Display as Table
```markdown
`data.csv` {{ table }}
`ps aux` {{ table headers }}
```
- Format output as table
- Auto-detect CSV/TSV

#### Syntax Highlight
```markdown
`cat config.json` {{ highlight "json" }}
`example.py` {{ highlight "python" line-numbers }}
```
- Syntax highlighting for output
- Optional line numbers

#### Progress Indicator
```markdown
`npm install` {{ progress }}
`download-large-file.sh` {{ progress percent }}
```
- Show progress bar
- Percent-based or spinner

### 7. Navigation & Documentation
Commands for better documentation flow.

#### Navigate to Section
```markdown
`#installation` {{ goto }}
`step-3` {{ goto smooth }}
```
- Jump to document sections
- Smooth scrolling option

#### Open Browser
```markdown
`https://docs.example.com` {{ browse }}
`http://localhost:3000` {{ browse wait }}
```
- Open URLs in browser
- Optional wait for user

#### Bookmarks
```markdown
`checkpoint-1` {{ bookmark }}
`Return to checkpoint-1` {{ goto-bookmark }}
```
- Create navigation points
- Return to saved positions

### 8. Conditional Execution
Commands with conditional logic.

#### If Condition
```markdown
`npm test` {{ if "CI=true" }}
`docker-compose up` {{ if exists="docker-compose.yml" }}
```
- Conditional execution based on environment
- File existence checks

#### Platform Specific
```markdown
`brew install node` {{ platform "macos" }}
`apt-get install nodejs` {{ platform "linux" }}
`choco install nodejs` {{ platform "windows" }}
```
- Platform-specific commands
- Auto-detect and run appropriate command

#### Require Prerequisites
```markdown
`docker` {{ require }}
`python >= 3.8` {{ require version }}
```
- Check prerequisites before continuing
- Clear error messages if missing

### 9. Templates & Snippets
Code generation and templates.

#### Insert Snippet
```markdown
`react-component` {{ snippet }}
`express-route` {{ snippet name="UserRoute" }}
```
- Insert predefined code snippets
- Variable substitution

#### Apply Template
```markdown
`dockerfile` {{ template "node" }}
`.gitignore` {{ template "javascript" }}
```
- Create files from templates
- Language/framework specific

#### Merge Content
```markdown
```json
{ "scripts": { "test": "jest" } }
``` {{ merge "package.json" }}
```
- Merge JSON/YAML content
- Useful for configuration updates

### 10. Status & Feedback
User feedback and status messages.

#### Status Messages
```markdown
`Installing dependencies...` {{ status }}
`✓ Setup complete` {{ status success }}
`⚠ Optional step` {{ status warning }}
`✗ Error occurred` {{ status error }}
```
- Display status messages
- Different severity levels

#### Notifications
```markdown
`Build complete!` {{ notify }}
`Tests failed` {{ notify error sound }}
```
- System notifications
- Optional sound alerts

#### Hints & Tips
```markdown
`API_KEY: Your API key from the dashboard` {{ hint }}
`⚠️ This will delete all data` {{ warning }}
`ℹ️ See troubleshooting guide` {{ info }}
```
- Inline hints and tips
- Different message types

## Implementation Considerations

### Priority Levels

#### High Priority (Core Functionality)
1. **setenv** - Essential for environment configuration
2. **input/choice** - Basic user interaction
3. **wait/retry** - Handle async operations
4. **background** - Long-running processes
5. **create** - File creation
6. **expect** - Output validation

#### Medium Priority (Enhanced Workflows)
1. **sequence/parallel** - Complex execution patterns
2. **save** - Output persistence
3. **if/require** - Conditional logic
4. **status** - User feedback
5. **delete/rename** - File operations

#### Low Priority (Nice to Have)
1. **snippet/template** - Code generation
2. **browse** - External navigation
3. **table** - Output formatting
4. **notify** - System notifications

### Technical Notes

#### Command Syntax Patterns
- Simple: `` `command` {{ action }} ``
- With parameters: `` `command` {{ action "param" }} ``
- With options: `` `command` {{ action key="value" }} ``
- Multi-line:
  ```
  {{ action }}
  content
  {{ /action }}
  ```

#### State Management
- Environment variables persist within session
- Background processes tracked by name
- Input values can be referenced later
- Bookmarks saved in document context

#### Error Handling
- All commands should have clear error messages
- Validation commands should not stop execution on failure
- Retry logic with exponential backoff
- Timeout options for long-running commands

#### Security Considerations
- Secret inputs never logged or displayed
- File operations require confirmation for destructive actions
- Download commands validate URLs
- Template/snippet expansion sanitized

## Next Steps

1. **Community Feedback**: Gather input on most desired features
2. **Prototype**: Build proof-of-concept for high-priority commands
3. **API Design**: Define consistent command interface
4. **Testing**: Create comprehensive test suite
5. **Documentation**: Write user guides and examples
6. **Release**: Incremental releases with feature groups

## Example Use Case: Full Setup Tutorial

```markdown
# Project Setup Tutorial

## Prerequisites
`node --version` {{ assert ">= 18.0.0" }}
`git --version` {{ require }}

## Initialize Project
`Enter project name:` {{ input }}
`Select framework:` {{ choice ["React", "Vue", "Angular"] }}

## Setup Environment
`NODE_ENV=development` {{ setenv }}
`PORT=3000` {{ setenv }}

## Create Project Structure
`src/components` {{ mkdir }}
`src/utils` {{ mkdir }}
`public` {{ mkdir }}

## Install Dependencies
`npm init -y` {{ execute }}
`npm install express` {{ progress }}

## Create Initial Files
```javascript
const express = require('express');
const app = express();
app.listen(3000);
``` {{ create "server.js" }}

## Start Development Server
`npm start` {{ background name="dev-server" }}
`curl localhost:3000` {{ wait 5 retry 3 }}

## Run Tests
`npm test` {{ expect "All tests passed" }}

## Success!
`✓ Setup complete!` {{ status success }}
`http://localhost:3000` {{ browse }}
```

This example shows how multiple command types work together to create a comprehensive, interactive tutorial experience.