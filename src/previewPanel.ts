import * as vscode from 'vscode';
import * as path from 'path';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { CommandParser, MDCLCommand } from './commandParser';
import { CommandExecutor } from './commandExecutor';
import { QuizProcessor } from './quizProcessor';
import { AnswerKeyLoader } from './answerKeyLoader';
import { AnswerKey } from './types/quiz';

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
    private scrollSyncEnabled: boolean = true;
    private isScrolling: boolean = false;
    private quizProcessor: QuizProcessor;
    private answerKeyLoader: AnswerKeyLoader;
    private currentAnswerKey: AnswerKey | null = null;

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
        this.quizProcessor = new QuizProcessor();
        this.answerKeyLoader = new AnswerKeyLoader();

        // Configure marked with syntax highlighting
        marked.use(
            markedHighlight({
                langPrefix: 'hljs language-',
                highlight(code, lang) {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    return hljs.highlight(code, { language }).value;
                }
            })
        );

        // Initial update
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
                    case 'syncScrollFromPreview':
                        // Sync scroll from preview to editor
                        if (this.scrollSyncEnabled && !this.isScrolling) {
                            this.isScrolling = true;
                            this.syncScrollToEditor(message.scrollPercentage);
                            setTimeout(() => {
                                this.isScrolling = false;
                            }, 100);
                        }
                        break;
                    case 'checkQuizAnswer':
                        // Load the appropriate answer key (custom or default)
                        const answerKeyToUse = message.answerKey
                            ? await this.answerKeyLoader.loadAnswerKey(this._document.uri, message.answerKey)
                            : this.currentAnswerKey;

                        const result = this.answerKeyLoader.validateAnswer(
                            message.quizId,
                            message.answer,
                            answerKeyToUse
                        );
                        this._panel.webview.postMessage({
                            type: 'quizResult',
                            quizId: message.quizId,
                            ...result
                        });
                        break;
                }
            },
            null,
            this._disposables
        );

        // Listen to editor scroll events
        vscode.window.onDidChangeTextEditorVisibleRanges(event => {
            if (event.textEditor.document.uri.toString() === this._document.uri.toString() &&
                this.scrollSyncEnabled &&
                !this.isScrolling) {
                this.isScrolling = true;
                this.syncScrollToPreview(event.textEditor);
                setTimeout(() => {
                    this.isScrolling = false;
                }, 100);
            }
        }, null, this._disposables);

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

    private syncScrollToPreview(editor: vscode.TextEditor) {
        // Calculate the scroll percentage based on visible ranges
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length === 0) return;

        const firstVisibleLine = visibleRanges[0].start.line;
        const totalLines = editor.document.lineCount;
        const scrollPercentage = firstVisibleLine / totalLines;

        // Send scroll position to preview
        this._panel.webview.postMessage({
            type: 'syncScrollFromEditor',
            scrollPercentage: scrollPercentage
        });
    }

    private syncScrollToEditor(scrollPercentage: number) {
        // Find the editor for this document
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === this._document.uri.toString()
        );

        if (!editor) return;

        const totalLines = editor.document.lineCount;
        const targetLine = Math.floor(scrollPercentage * totalLines);
        const targetPosition = new vscode.Position(targetLine, 0);
        const targetRange = new vscode.Range(targetPosition, targetPosition);

        editor.revealRange(targetRange, vscode.TextEditorRevealType.AtTop);
    }

    private update() {
        this.commandCounter = 0; // Reset counter for each update
        this.quizProcessor.resetCounter(); // Reset quiz counter

        // Load answer key asynchronously without blocking
        this.answerKeyLoader.loadAnswerKey(this._document.uri)
            .then(key => {
                this.currentAnswerKey = key;
            })
            .catch(err => {
                console.log('Failed to load answer key:', err);
            });

        this._panel.webview.html = this.getHtmlContent(this._panel.webview);
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const content = this._document.getText();

        // First, process block commands BEFORE markdown parsing
        let processedContent = content;

        // Process code blocks that contain inline commands (must be done BEFORE markdown parsing to avoid syntax highlighting)
        const codeBlockWithCommandsRegex = /```\s*\n((?:.*\{\{\s*(?:execute|copy|open).*\n?)+)```/g;
        const inlineCommandBlocks = new Map<string, string>();

        processedContent = processedContent.replace(codeBlockWithCommandsRegex, (match, blockContent) => {
            const blockId = `INLINE_CMD_BLOCK_${Math.random().toString(36).substr(2, 9)}`;
            inlineCommandBlocks.set(blockId, blockContent);
            return `\`\`\`\n${blockId}\n\`\`\``;
        });

        // Updated regex to support language specification: ```python{{ execute }}
        const blockCommandRegex = /```(\w+)?\{\{\s*(execute|copy|open)(?:\s+(?:['"]([^'"]+)['"]|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}\s*\n([^`]*)```/g;

        processedContent = processedContent.replace(blockCommandRegex, (match, language, action, quotedTerminal, unquotedTerminal, interrupt, blockContent) => {
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
                interrupt: interrupt === 'interrupt' || unquotedTerminal === 'interrupt',
                language: language  // Store language for syntax highlighting
            };

            // Store block data for later processing
            if (!this.blockCommands) {
                this.blockCommands = new Map();
            }
            this.blockCommands.set(blockId, commandData);

            // Return markdown that will be preserved through parsing
            return `\`\`\`\n${blockId}\n\`\`\``;
        });

        // Process quiz blocks BEFORE markdown parsing
        const quizBlockRegex = /```quiz(?:\s+id=["']([^"']+)["'])?(?:\s+answerKey=["']([^"']+)["'])?\s*\n([^`]*)```/g;
        const quizBlocks = new Map<string, string>();

        processedContent = processedContent.replace(quizBlockRegex, (match, quizId, answerKey, quizContent) => {
            const quiz = this.quizProcessor.parseQuizBlock(quizContent, quizId, answerKey);
            if (quiz) {
                const quizHtml = this.quizProcessor.generateQuizHTML(quiz);
                const quizMarkerId = `QUIZ_BLOCK_${Math.random().toString(36).substr(2, 9)}`;
                quizBlocks.set(quizMarkerId, quizHtml);
                return `\`\`\`\n${quizMarkerId}\n\`\`\``;
            }
            return match;
        });

        // Parse the markdown to HTML
        let htmlContent = marked.parse(processedContent) as string;

        // Replace quiz block placeholders with actual quiz HTML
        quizBlocks.forEach((quizHtml, quizMarkerId) => {
            const blockRegex = new RegExp(`<pre><code[^>]*>${quizMarkerId}\\s*</code></pre>`, 'g');
            htmlContent = htmlContent.replace(blockRegex, quizHtml);
        });

        // Process the block command placeholders
        if (this.blockCommands) {
            this.blockCommands.forEach((commandData, blockId) => {
                const blockRegex = new RegExp(`<pre><code[^>]*>${blockId}\\s*</code></pre>`, 'g');

                htmlContent = htmlContent.replace(blockRegex, () => {
                    const { commands, action, terminal, interrupt, language } = commandData;

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

                    // Display commands with syntax highlighting if language is specified
                    let displayCommands: string;
                    if (language) {
                        // Apply syntax highlighting to the entire block
                        const codeText = commands.join('\n');
                        const lang = hljs.getLanguage(language) ? language : 'plaintext';
                        const highlighted = hljs.highlight(codeText, { language: lang }).value;
                        displayCommands = `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
                    } else {
                        // No syntax highlighting - display as plain text
                        displayCommands = commands.map((cmd: string) =>
                            `<div class="block-command-line"><code>${this.escapeHtml(cmd)}</code></div>`
                        ).join('');
                    }

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

        // Process inline command blocks (code blocks with individual command buttons)
        if (inlineCommandBlocks.size > 0) {
            inlineCommandBlocks.forEach((blockContent, blockId) => {
                const blockRegex = new RegExp(`<pre><code[^>]*>${blockId}\\s*</code></pre>`, 'g');

                htmlContent = htmlContent.replace(blockRegex, () => {
                    // Process each line in the code block
                    const lines = blockContent.split('\n');
                    const processedLines = lines.map((line: string) => {
                        // Check if this line contains a command
                        const commandMatch = line.match(/`([^`]+)`\s*\{\{\s*(execute|copy|open)(?:\s+(?:['"]([^'"]+)['"]|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/);

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
                        return this.escapeHtml(line);
                    }).join('<br>');

                    // Return as a styled code block with commands
                    return `<div class="command-block">${processedLines}</div>`;
                });
            });
        }

        // Process inline commands (not in code blocks)
        const inlineCommandRegex = /<code>([^<]+)<\/code>\s*\{\{\s*(execute|copy|open)(?:\s+(?:&#39;([^&]+)&#39;|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/g;

        htmlContent = htmlContent.replace(inlineCommandRegex, (match, command, action, quotedTerminal, unquotedTerminal, interrupt) => {
            return this.createCommandButton(command, action, quotedTerminal, unquotedTerminal, interrupt);
        });

        // Process note, info, tip, warning, and danger messages
        const messageRegex = /<code>([^<]+)<\/code>\s*\{\{\s*(note|info|tip|warning|danger|hint)\s*\}\}/g;

        htmlContent = htmlContent.replace(messageRegex, (match, message, type) => {
            const unescapedMessage = message
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');

            return this.createMessageBox(unescapedMessage, type);
        });

        // Process inline quiz questions
        const inlineQuizRegex = /<code>([^<]+)<\/code>\s*\{\{\s*quiz(?:\s+id=(?:&#39;|&quot;)([^&]+)(?:&#39;|&quot;))?(?:\s+answerKey=(?:&#39;|&quot;)([^&]+)(?:&#39;|&quot;))?\s*\}\}/g;

        htmlContent = htmlContent.replace(inlineQuizRegex, (match, question, quizId, answerKey) => {
            const unescapedQuestion = question
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');

            const quiz = this.quizProcessor.parseInlineQuiz(unescapedQuestion, quizId, answerKey);
            return this.quizProcessor.generateQuizHTML(quiz);
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
                    /* Syntax highlighting styles using VSCode theme colors */
                    pre code.hljs {
                        display: block;
                        overflow-x: auto;
                        padding: 0;
                        background: transparent;
                    }
                    .hljs {
                        color: var(--vscode-editor-foreground);
                    }
                    .hljs-comment,
                    .hljs-quote {
                        color: var(--vscode-editor-foreground);
                        opacity: 0.6;
                        font-style: italic;
                    }
                    .hljs-keyword,
                    .hljs-selector-tag,
                    .hljs-subst {
                        color: var(--vscode-symbolIcon-keywordForeground, #569CD6);
                    }
                    .hljs-number,
                    .hljs-literal,
                    .hljs-variable,
                    .hljs-template-variable,
                    .hljs-tag .hljs-attr {
                        color: var(--vscode-symbolIcon-variableForeground, #9CDCFE);
                    }
                    .hljs-string,
                    .hljs-doctag {
                        color: var(--vscode-symbolIcon-stringForeground, #CE9178);
                    }
                    .hljs-title,
                    .hljs-section,
                    .hljs-selector-id {
                        color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
                        font-weight: bold;
                    }
                    .hljs-type,
                    .hljs-class .hljs-title {
                        color: var(--vscode-symbolIcon-classForeground, #4EC9B0);
                    }
                    .hljs-tag,
                    .hljs-name,
                    .hljs-attribute {
                        color: var(--vscode-symbolIcon-propertyForeground, #569CD6);
                        font-weight: normal;
                    }
                    .hljs-regexp,
                    .hljs-link {
                        color: var(--vscode-symbolIcon-operatorForeground, #D4D4D4);
                    }
                    .hljs-symbol,
                    .hljs-bullet {
                        color: var(--vscode-symbolIcon-enumMemberForeground, #4FC1FF);
                    }
                    .hljs-built_in,
                    .hljs-builtin-name {
                        color: var(--vscode-symbolIcon-methodForeground, #DCDCAA);
                    }
                    .hljs-meta {
                        color: var(--vscode-symbolIcon-constantForeground, #4FC1FF);
                    }
                    .hljs-deletion {
                        background: rgba(255, 0, 0, 0.2);
                    }
                    .hljs-addition {
                        background: rgba(0, 255, 0, 0.2);
                    }
                    .hljs-emphasis {
                        font-style: italic;
                    }
                    .hljs-strong {
                        font-weight: bold;
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
                    /* Admonition Styles - Hugo LoveIt Theme */
                    .admonition {
                        border-radius: 4px;
                        padding: 16px;
                        margin: 16px 0;
                        border-left: 4px solid;
                        position: relative;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24);
                    }
                    .admonition::before {
                        position: absolute;
                        top: -12px;
                        left: 16px;
                        padding: 2px 8px;
                        border-radius: 3px;
                        font-size: 11px;
                        font-weight: 600;
                        color: white;
                        letter-spacing: 0.5px;
                    }
                    .admonition-content {
                        display: flex;
                        align-items: flex-start;
                        gap: 12px;
                        margin-top: 4px;
                    }
                    .admonition-icon {
                        font-size: 20px;
                        flex-shrink: 0;
                    }
                    .admonition-text {
                        flex: 1;
                        line-height: 1.6;
                        font-size: 14px;
                        color: var(--vscode-editor-foreground);
                    }
                    /* Note - Blue */
                    .admonition-note {
                        background-color: rgba(33, 150, 243, 0.05);
                        border-left-color: #2196f3;
                    }
                    .admonition-note::before {
                        content: 'NOTE';
                        background: #2196f3;
                    }
                    .admonition-note .admonition-icon {
                        color: #2196f3;
                    }
                    /* Info - Light Blue */
                    .admonition-info {
                        background-color: rgba(0, 188, 212, 0.05);
                        border-left-color: #00bcd4;
                    }
                    .admonition-info::before {
                        content: 'INFO';
                        background: #00bcd4;
                    }
                    .admonition-info .admonition-icon {
                        color: #00bcd4;
                    }
                    /* Tip - Green */
                    .admonition-tip {
                        background-color: rgba(76, 175, 80, 0.05);
                        border-left-color: #4caf50;
                    }
                    .admonition-tip::before {
                        content: 'TIP';
                        background: #4caf50;
                    }
                    .admonition-tip .admonition-icon {
                        color: #4caf50;
                    }
                    /* Warning - Orange */
                    .admonition-warning {
                        background-color: rgba(255, 152, 0, 0.05);
                        border-left-color: #ff9800;
                    }
                    .admonition-warning::before {
                        content: 'WARNING';
                        background: #ff9800;
                    }
                    .admonition-warning .admonition-icon {
                        color: #ff9800;
                    }
                    /* Danger - Red */
                    .admonition-danger {
                        background-color: rgba(244, 67, 54, 0.05);
                        border-left-color: #f44336;
                    }
                    .admonition-danger::before {
                        content: 'DANGER';
                        background: #f44336;
                    }
                    .admonition-danger .admonition-icon {
                        color: #f44336;
                    }
                    /* Quiz Styles - Green Question Theme */
                    .quiz-container {
                        background-color: rgba(100, 221, 23, 0.05);
                        border-left: 4px solid #64dd17;
                        border-radius: 4px;
                        padding: 20px;
                        margin: 16px 0;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24);
                        position: relative;
                    }
                    .quiz-container::before {
                        content: "QUESTION";
                        position: absolute;
                        top: -12px;
                        left: 16px;
                        background: #64dd17;
                        color: white;
                        padding: 2px 8px;
                        border-radius: 3px;
                        font-size: 11px;
                        font-weight: 600;
                        letter-spacing: 0.5px;
                    }
                    .quiz-container.quiz-inline {
                        background-color: rgba(100, 221, 23, 0.05);
                        border-left: 3px solid #64dd17;
                        padding: 12px 16px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }
                    .quiz-container.quiz-inline::before {
                        display: none;
                    }
                    .quiz-icon {
                        font-size: 20px;
                        margin-right: 8px;
                        color: #64dd17;
                    }
                    .quiz-question {
                        font-size: 16px;
                        font-weight: 500;
                        margin-bottom: 16px;
                        margin-top: 8px;
                        color: var(--vscode-editor-foreground);
                    }
                    .quiz-question-inline {
                        display: flex;
                        align-items: center;
                        font-size: 15px;
                        font-weight: 500;
                    }
                    .quiz-options {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .quiz-option {
                        display: flex;
                        align-items: center;
                        padding: 10px 14px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-editorWidget-border);
                        border-radius: 4px;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    .quiz-option:hover {
                        background-color: rgba(100, 221, 23, 0.08);
                        border-color: #64dd17;
                    }
                    .quiz-option input[type="radio"] {
                        margin-right: 10px;
                    }
                    .option-label {
                        font-weight: 600;
                        margin-right: 8px;
                    }
                    .quiz-input-group {
                        display: flex;
                        gap: 8px;
                        align-items: center;
                    }
                    .quiz-text-input {
                        flex: 1;
                        padding: 6px 10px;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        font-size: 14px;
                    }
                    .quiz-text-input:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                    }
                    .quiz-actions {
                        margin-top: 16px;
                        display: flex;
                        gap: 10px;
                    }
                    .quiz-check-btn, .quiz-show-btn, .quiz-reset-btn {
                        padding: 6px 16px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 13px;
                        font-weight: 500;
                        transition: all 0.2s;
                    }
                    .quiz-check-btn {
                        background-color: #64dd17;
                        color: white;
                        font-weight: 600;
                    }
                    .quiz-check-btn:hover {
                        background-color: #76ff03;
                        box-shadow: 0 2px 4px rgba(100, 221, 23, 0.3);
                    }
                    .quiz-check-inline {
                        padding: 6px 12px;
                    }
                    .quiz-show-btn {
                        background-color: var(--vscode-editorWidget-background);
                        color: var(--vscode-editorWidget-foreground);
                        border: 1px solid var(--vscode-editorWidget-border);
                    }
                    .quiz-reset-btn {
                        background-color: var(--vscode-textLink-foreground);
                        color: var(--vscode-editor-background);
                    }
                    .quiz-feedback {
                        margin-top: 12px;
                        padding: 10px;
                        border-radius: 4px;
                        font-size: 14px;
                        display: none;
                    }
                    .quiz-feedback-inline {
                        margin: 0;
                        padding: 8px;
                    }
                    .quiz-feedback.correct {
                        display: block;
                        background-color: rgba(76, 175, 80, 0.1);
                        border: 1px solid rgba(76, 175, 80, 0.3);
                        color: var(--vscode-testing-iconPassed, #4CAF50);
                    }
                    .quiz-feedback.incorrect {
                        display: block;
                        background-color: rgba(244, 67, 54, 0.1);
                        border: 1px solid rgba(244, 67, 54, 0.3);
                        color: var(--vscode-testing-iconFailed, #f44336);
                    }
                    .quiz-option.selected {
                        background-color: var(--vscode-list-activeSelectionBackground);
                    }
                    .quiz-option.correct-answer {
                        border: 2px solid #4CAF50;
                        background-color: rgba(76, 175, 80, 0.1);
                    }
                    .quiz-option.wrong-answer {
                        border: 2px solid #f44336;
                        background-color: rgba(244, 67, 54, 0.1);
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

                    // Save scroll position and sync with editor
                    let scrollTimer;
                    let isScrollingFromEditor = false;

                    window.addEventListener('scroll', () => {
                        clearTimeout(scrollTimer);
                        scrollTimer = setTimeout(() => {
                            // Save scroll position
                            vscode.postMessage({
                                type: 'saveScrollPosition',
                                scrollPosition: window.scrollY
                            });

                            // Sync scroll to editor (if not scrolling from editor)
                            if (!isScrollingFromEditor) {
                                const scrollPercentage = window.scrollY / (document.body.scrollHeight - window.innerHeight);
                                vscode.postMessage({
                                    type: 'syncScrollFromPreview',
                                    scrollPercentage: scrollPercentage
                                });
                            }
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
                            const quizId = e.target.getAttribute('data-quiz-id');

                            if (commandData) {
                                const command = JSON.parse(commandData);
                                vscode.postMessage({
                                    type: 'executeCommand',
                                    command: command,
                                    commandId: commandId
                                });
                            } else if (quizId) {
                                // Handle quiz button clicks
                                if (e.target.classList.contains('quiz-check-btn')) {
                                    handleQuizCheck(quizId);
                                } else if (e.target.classList.contains('quiz-show-btn')) {
                                    handleQuizShow(quizId);
                                } else if (e.target.classList.contains('quiz-reset-btn')) {
                                    handleQuizReset(quizId);
                                }
                            }
                        }
                    });

                    // Quiz helper functions
                    function handleQuizCheck(quizId) {
                        const container = document.querySelector(\`[data-quiz-id="\${quizId}"]\`);
                        if (!container) return;

                        let answer;
                        if (container.classList.contains('quiz-inline')) {
                            // Text input quiz
                            const input = container.querySelector('.quiz-text-input');
                            answer = input ? input.value.trim() : '';
                        } else {
                            // Multiple choice quiz
                            const checked = container.querySelector('input[type="radio"]:checked');
                            answer = checked ? checked.value : '';
                        }

                        if (!answer) {
                            showFeedback(quizId, false, 'Please select or enter an answer');
                            return;
                        }

                        // Get custom answer key if specified
                        const answerKey = container.getAttribute('data-answer-key');

                        // Send to extension for validation
                        vscode.postMessage({
                            type: 'checkQuizAnswer',
                            quizId: quizId,
                            answer: answer,
                            answerKey: answerKey
                        });
                    }

                    function handleQuizShow(quizId) {
                        // This will be implemented if answer key allows showing answers
                        showFeedback(quizId, false, 'Check your answer first');
                    }

                    function handleQuizReset(quizId) {
                        const container = document.querySelector(\`[data-quiz-id="\${quizId}"]\`);
                        if (!container) return;

                        // Clear selections
                        const radios = container.querySelectorAll('input[type="radio"]');
                        radios.forEach(r => r.checked = false);

                        const textInput = container.querySelector('.quiz-text-input');
                        if (textInput) textInput.value = '';

                        // Clear feedback
                        const feedback = document.getElementById(\`feedback-\${quizId}\`);
                        if (feedback) {
                            feedback.className = 'quiz-feedback';
                            feedback.innerHTML = '';
                        }

                        // Reset buttons
                        const checkBtn = container.querySelector('.quiz-check-btn');
                        const showBtn = container.querySelector('.quiz-show-btn');
                        const resetBtn = container.querySelector('.quiz-reset-btn');
                        if (checkBtn) checkBtn.style.display = 'inline-block';
                        if (showBtn) showBtn.style.display = 'none';
                        if (resetBtn) resetBtn.style.display = 'none';
                    }

                    function showFeedback(quizId, correct, message, correctAnswer) {
                        const feedback = document.getElementById(\`feedback-\${quizId}\`);
                        if (!feedback) return;

                        feedback.className = \`quiz-feedback \${correct ? 'correct' : 'incorrect'}\`;
                        let feedbackHTML = \`\${correct ? '✅' : '❌'} \${message}\`;

                        if (correctAnswer && !correct) {
                            feedbackHTML += \`<br><strong>Correct answer:</strong> \${correctAnswer}\`;
                        }

                        feedback.innerHTML = feedbackHTML;

                        // Update buttons
                        const container = document.querySelector(\`[data-quiz-id="\${quizId}"]\`);
                        if (container) {
                            const checkBtn = container.querySelector('.quiz-check-btn');
                            const resetBtn = container.querySelector('.quiz-reset-btn');
                            if (checkBtn) checkBtn.style.display = 'none';
                            if (resetBtn) resetBtn.style.display = 'inline-block';
                        }
                    }

                    // Listen for messages from extension
                    window.addEventListener('message', (event) => {
                        const message = event.data;
                        if (message.type === 'quizResult') {
                            const feedbackMessage = message.correct ?
                                'Correct!' + (message.explanation ? \`: \${message.explanation}\` : '') :
                                'Incorrect' + (message.explanation ? \`: \${message.explanation}\` : '');

                            showFeedback(message.quizId, message.correct, feedbackMessage, message.correctAnswer);
                        } else if (message.type === 'syncScrollFromEditor') {
                            // Handle scroll sync from editor
                            isScrollingFromEditor = true;
                            const targetY = message.scrollPercentage * (document.body.scrollHeight - window.innerHeight);
                            window.scrollTo(0, targetY);
                            setTimeout(() => {
                                isScrollingFromEditor = false;
                            }, 150);
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

    private createMessageBox(message: string, type: 'note' | 'info' | 'tip' | 'warning' | 'danger' | 'hint'): string {
        let icon = '';
        let className = 'admonition';
        let label = '';

        switch (type) {
            case 'note':
                icon = '📝';
                className += ' admonition-note';
                label = 'NOTE';
                break;
            case 'info':
                icon = 'ℹ️';
                className += ' admonition-info';
                label = 'INFO';
                break;
            case 'tip':
            case 'hint':
                icon = '💡';
                className += ' admonition-tip';
                label = 'TIP';
                break;
            case 'warning':
                icon = '⚠️';
                className += ' admonition-warning';
                label = 'WARNING';
                break;
            case 'danger':
                icon = '🔥';
                className += ' admonition-danger';
                label = 'DANGER';
                break;
        }

        return `<div class="${className}" data-admonition-type="${type}">
            <div class="admonition-content">
                <span class="admonition-icon">${icon}</span>
                <span class="admonition-text">${this.escapeHtml(message)}</span>
            </div>
        </div>`;
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