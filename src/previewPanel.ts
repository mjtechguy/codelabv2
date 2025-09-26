import * as vscode from 'vscode';
import * as path from 'path';
import { marked } from 'marked';
import { CommandParser, MDCLCommand } from './commandParser';
import { CommandExecutor } from './commandExecutor';

export class MDCLPreviewPanel {
    public static currentPanel: MDCLPreviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _document: vscode.TextDocument;
    private _disposables: vscode.Disposable[] = [];
    private parser: CommandParser;
    private executor: CommandExecutor;
    private blockCommands?: Map<string, any>;
    private scrollPosition: number = 0;
    private executedCommands: Set<string> = new Set();
    private commandCounter: number = 0;

    public static createOrShow(
        extensionUri: vscode.Uri,
        document: vscode.TextDocument,
        executor: CommandExecutor
    ): MDCLPreviewPanel {
        const column = vscode.ViewColumn.Beside;

        if (MDCLPreviewPanel.currentPanel) {
            MDCLPreviewPanel.currentPanel._panel.reveal(column);
            MDCLPreviewPanel.currentPanel._document = document;
            MDCLPreviewPanel.currentPanel.update();
            return MDCLPreviewPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'mdclPreview',
            'CodeLab Preview',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        MDCLPreviewPanel.currentPanel = new MDCLPreviewPanel(panel, extensionUri, document, executor);
        return MDCLPreviewPanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        document: vscode.TextDocument,
        executor: CommandExecutor
    ) {
        this._panel = panel;
        this._document = document;
        this.parser = new CommandParser();
        this.executor = executor;

        this.update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'executeCommand':
                        const command = message.command as MDCLCommand;
                        await this.executor.execute(command, this._document.uri);
                        // Mark command as executed
                        if (message.commandId) {
                            this.executedCommands.add(message.commandId);
                            // Trigger update to refresh button styles
                            this.update();
                        }
                        break;
                    case 'saveScrollPosition':
                        this.scrollPosition = message.scrollPosition;
                        break;
                }
            },
            null,
            this._disposables
        );

        vscode.workspace.onDidChangeTextDocument(
            (e) => {
                if (e.document.uri.toString() === this._document.uri.toString()) {
                    this.update();
                }
            },
            null,
            this._disposables
        );
    }

    private update() {
        this.commandCounter = 0; // Reset counter for each update
        this._panel.webview.html = this.getHtmlContent(this._panel.webview);
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const content = this._document.getText();

        // First, process block commands BEFORE markdown parsing
        let processedContent = content;
        const blockCommandRegex = /```\{\{\s*(execute|copy|open)(?:\s+(?:['"]([^'"]+)['"]|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}\s*\n([^`]*)```/g;

        processedContent = processedContent.replace(blockCommandRegex, (match, action, quotedTerminal, unquotedTerminal, interrupt, blockContent) => {
            // Extract commands from the block
            const commands: string[] = [];
            const backtickPattern = /`([^`]+)`/g;
            let cmdMatch;

            while ((cmdMatch = backtickPattern.exec(blockContent)) !== null) {
                commands.push(cmdMatch[1]);
            }

            // If no backticks found, treat each non-empty line as a command
            if (commands.length === 0) {
                commands.push(...blockContent.split('\n').filter((line: string) => line.trim()).map((line: string) => line.trim()));
            }

            // Create a unique marker for this block that we'll replace after markdown parsing
            const blockId = `MDCL_BLOCK_${Math.random().toString(36).substr(2, 9)}`;
            const commandData = {
                commands,
                action: action || 'execute',
                terminal: quotedTerminal || unquotedTerminal,
                interrupt: interrupt === 'interrupt' || unquotedTerminal === 'interrupt'
            };

            // Store block data for later processing
            if (!this.blockCommands) {
                this.blockCommands = new Map();
            }
            this.blockCommands.set(blockId, commandData);

            // Return markdown that will be preserved through parsing
            return `\`\`\`\n${blockId}\n\`\`\``;
        });

        // Parse the markdown to HTML
        let htmlContent = marked.parse(processedContent) as string;

        // Process the block command placeholders
        if (this.blockCommands) {
            this.blockCommands.forEach((commandData, blockId) => {
                const blockRegex = new RegExp(`<pre><code[^>]*>${blockId}\\s*</code></pre>`, 'g');

                htmlContent = htmlContent.replace(blockRegex, () => {
                    const { commands, action, terminal, interrupt } = commandData;

                    // Create command object
                    // Wrap in eval to reduce command echo
                    const joinedCommands = commands.join(' && ');
                    const cmdObj: any = {
                        command: `eval "${joinedCommands.replace(/"/g, '\\"')}"`,
                        action: action
                    };

                    let buttonText = 'Run All';
                    let buttonClass = 'execute-btn';

                    if (action === 'execute') {
                        if (terminal && terminal !== 'interrupt') {
                            cmdObj.terminal = terminal;
                            buttonText = `Run All in ${terminal}`;
                        } else if (interrupt) {
                            cmdObj.interrupt = true;
                            buttonText = 'Interrupt & Run All';
                        }
                    }

                    // Display commands nicely with a single execute button
                    const displayCommands = commands.map((cmd: string) =>
                        `<div class="block-command-line"><code>${this.escapeHtml(cmd)}</code></div>`
                    ).join('');

                    // Generate unique ID for this block command using counter
                    const commandId = `block_${this.commandCounter++}`;
                    const isExecuted = this.executedCommands.has(commandId);
                    const executedClass = isExecuted ? ' executed' : '';

                    return `<div class="command-block">
                        ${displayCommands}
                        <div class="block-execute-btn-container">
                            <button class="${buttonClass} block-execute-btn${executedClass}" data-command='${JSON.stringify(cmdObj).replace(/'/g, '&#39;')}' data-command-id="${commandId}">${buttonText}</button>
                        </div>
                    </div>`;
                });
            });

            // Clear the block commands for next render
            this.blockCommands.clear();
        }

        // Process inline commands (not in code blocks)
        const inlineCommandRegex = /<code>([^<]+)<\/code>\s*\{\{\s*(execute|copy|open)(?:\s+(?:&#39;([^&]+)&#39;|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/g;

        htmlContent = htmlContent.replace(inlineCommandRegex, (match, command, action, quotedTerminal, unquotedTerminal, interrupt) => {
            return this.createCommandButton(command, action, quotedTerminal, unquotedTerminal, interrupt);
        });

        // Process commands inside regular code blocks (for individual command buttons)
        const codeBlockRegex = /<pre><code[^>]*>([^<]*)<\/code><\/pre>/g;

        htmlContent = htmlContent.replace(codeBlockRegex, (match, codeContent) => {
            // Skip if this was a block command placeholder
            if (codeContent.startsWith('MDCL_BLOCK_')) {
                return match;
            }

            // Check if this code block contains individual command patterns
            const commandPattern = /`([^`]+)`\s*\{\{\s*(execute|copy|open)(?:\s+(?:['"]([^'"]+)['"]|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/g;

            if (commandPattern.test(codeContent)) {
                // Process each line in the code block
                const lines = codeContent.split('\n');
                const processedLines = lines.map((line: string) => {
                    // Unescape HTML entities first
                    const unescapedLine = line
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&');

                    // Check if this line contains a command
                    const commandMatch = unescapedLine.match(/`([^`]+)`\s*\{\{\s*(execute|copy|open)(?:\s+(?:['"]([^'"]+)['"]|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/);

                    if (commandMatch) {
                        const [fullMatch, command, action, quotedTerminal, unquotedTerminal, interrupt] = commandMatch;
                        // Generate unique ID for commands in code blocks
                        const commandId = `cmd_${this.commandCounter++}`;
                        const isExecuted = this.executedCommands.has(commandId);
                        const executedClass = isExecuted ? ' executed' : '';

                        // Build the command object
                        const cmdObj: any = {
                            command: command,
                            action: action
                        };

                        let buttonClass = 'execute-btn';
                        let buttonText = 'Run';

                        switch (action) {
                            case 'copy':
                                buttonClass = 'copy-btn';
                                buttonText = 'Copy';
                                break;
                            case 'open':
                                buttonClass = 'open-btn';
                                buttonText = 'Open';
                                break;
                            case 'execute':
                                const terminal = quotedTerminal || (unquotedTerminal !== 'interrupt' ? unquotedTerminal : undefined);
                                if (terminal) {
                                    cmdObj.terminal = terminal;
                                    buttonText = `Run in ${terminal}`;
                                } else if (interrupt === 'interrupt' || unquotedTerminal === 'interrupt') {
                                    cmdObj.interrupt = true;
                                    buttonText = 'Interrupt & Run';
                                }
                                break;
                        }

                        return `<code>${this.escapeHtml(command)}</code> <button class="${buttonClass}${executedClass}" data-command='${JSON.stringify(cmdObj).replace(/'/g, '&#39;')}' data-command-id="${commandId}">${buttonText}</button>`;
                    }

                    // Return the line as-is if it's not a command
                    return this.escapeHtml(unescapedLine);
                }).join('<br>');

                // Return as a styled code block with commands
                return `<div class="command-block">${processedLines}</div>`;
            }

            // Return unmodified if no commands found
            return match;
        });

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>CodeLab Preview</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        padding: 20px;
                        line-height: 1.8;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        max-width: 900px;
                        margin: 0 auto;
                    }
                    p {
                        margin: 1em 0;
                    }
                    p:empty {
                        display: none;
                    }
                    br {
                        display: block;
                        margin: 0.5em 0;
                        content: "";
                    }
                    code {
                        background-color: var(--vscode-textBlockQuote-background);
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: 'Courier New', Courier, monospace;
                    }
                    pre {
                        background-color: var(--vscode-textBlockQuote-background);
                        padding: 12px;
                        border-radius: 4px;
                        overflow-x: auto;
                    }
                    button {
                        margin-left: 8px;
                        padding: 4px 12px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 500;
                        transition: all 0.2s;
                    }
                    .execute-btn {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .execute-btn:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .copy-btn {
                        background-color: var(--vscode-editorWidget-background);
                        color: var(--vscode-editorWidget-foreground);
                        border: 1px solid var(--vscode-editorWidget-border);
                    }
                    .copy-btn:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .open-btn {
                        background-color: var(--vscode-textLink-foreground);
                        color: var(--vscode-editor-background);
                    }
                    .open-btn:hover {
                        opacity: 0.8;
                    }
                    h1, h2, h3, h4, h5, h6 {
                        color: var(--vscode-editor-foreground);
                        margin-top: 24px;
                        margin-bottom: 16px;
                    }
                    a {
                        color: var(--vscode-textLink-foreground);
                    }
                    .command-block {
                        background-color: var(--vscode-textBlockQuote-background);
                        padding: 16px;
                        border-radius: 6px;
                        margin: 16px 0;
                        font-family: 'Courier New', Courier, monospace;
                        line-height: 1.8;
                        border-left: 4px solid var(--vscode-textLink-foreground);
                    }
                    .command-block code {
                        background: none;
                        padding: 0;
                        color: var(--vscode-textPreformat-foreground);
                    }
                    .block-command-line {
                        padding: 4px 0;
                        margin: 2px 0;
                    }
                    .block-execute-btn-container {
                        margin-top: 16px;
                        padding-top: 12px;
                        border-top: 1px solid var(--vscode-editorWidget-border);
                    }
                    .block-execute-btn {
                        margin-left: 8px;
                        padding: 4px 12px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 500;
                        transition: all 0.2s;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .block-execute-btn:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    button.executed {
                        border: 2px solid #4CAF50 !important;
                        box-shadow: 0 0 4px rgba(76, 175, 80, 0.4);
                        position: relative;
                    }
                    button.executed::after {
                        content: '✓';
                        position: absolute;
                        top: -8px;
                        right: -8px;
                        background: #4CAF50;
                        color: white;
                        border-radius: 50%;
                        width: 16px;
                        height: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 10px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                ${htmlContent}
                <script>
                    const vscode = acquireVsCodeApi();

                    // Restore scroll position on load
                    const savedScrollPosition = ${this.scrollPosition};
                    if (savedScrollPosition > 0) {
                        setTimeout(() => {
                            window.scrollTo(0, savedScrollPosition);
                        }, 0);
                    }

                    // Save scroll position on scroll
                    let scrollTimer;
                    window.addEventListener('scroll', () => {
                        clearTimeout(scrollTimer);
                        scrollTimer = setTimeout(() => {
                            vscode.postMessage({
                                type: 'saveScrollPosition',
                                scrollPosition: window.scrollY
                            });
                        }, 100);
                    });

                    // Save scroll position before unload
                    window.addEventListener('beforeunload', () => {
                        vscode.postMessage({
                            type: 'saveScrollPosition',
                            scrollPosition: window.scrollY
                        });
                    });

                    document.addEventListener('click', (e) => {
                        if (e.target.tagName === 'BUTTON') {
                            const commandData = e.target.getAttribute('data-command');
                            const commandId = e.target.getAttribute('data-command-id');
                            if (commandData) {
                                const command = JSON.parse(commandData);
                                vscode.postMessage({
                                    type: 'executeCommand',
                                    command: command,
                                    commandId: commandId
                                });
                            }
                        }
                    });
                </script>
            </body>
            </html>`;
    }

    private createCommandButton(command: string, action: string, quotedTerminal?: string, unquotedTerminal?: string, interrupt?: string): string {
        // Unescape HTML entities in the command if needed
        const unescapedCommand = command
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');

        let buttonClass = 'execute-btn';
        let buttonText = 'Run';

        // Build the command object for the button
        const cmdObj: any = {
            command: unescapedCommand,
            action: action
        };

        switch (action) {
            case 'copy':
                buttonClass = 'copy-btn';
                buttonText = 'Copy';
                break;
            case 'open':
                buttonClass = 'open-btn';
                buttonText = 'Open';
                break;
            case 'execute':
                const terminal = quotedTerminal || (unquotedTerminal !== 'interrupt' ? unquotedTerminal : undefined);
                if (terminal) {
                    cmdObj.terminal = terminal;
                    buttonText = `Run in ${terminal}`;
                } else if (interrupt === 'interrupt' || unquotedTerminal === 'interrupt') {
                    cmdObj.interrupt = true;
                    buttonText = 'Interrupt & Run';
                }
                break;
        }

        // Generate unique ID for this command using counter
        const commandId = `cmd_${this.commandCounter++}`;
        const isExecuted = this.executedCommands.has(commandId);
        const executedClass = isExecuted ? ' executed' : '';

        return `<code>${this.escapeHtml(unescapedCommand)}</code> <button class="${buttonClass}${executedClass}" data-command='${JSON.stringify(cmdObj).replace(/'/g, '&#39;')}' data-command-id="${commandId}">${buttonText}</button>`;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    public dispose() {
        MDCLPreviewPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}