import * as vscode from 'vscode';
import { ConfigLoader } from './configLoader';
import { LLMClient } from './llmClient';
import { TutorialContextExtractor } from './tutorialContext';
import { ChatMessage, ChatConfig } from '../types/chat';

// Local session structure for ChatPanel (not using SessionManager)
interface LocalChatSession {
    documentUri: string;
    messages: ChatMessage[];
}

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _document: vscode.TextDocument;
    private _disposables: vscode.Disposable[] = [];
    private _config: ChatConfig | null = null;
    private _llmClient: LLMClient | null = null;
    private _session: LocalChatSession;
    private _abortController: AbortController | null = null;

    public static createOrShow(
        extensionUri: vscode.Uri,
        document: vscode.TextDocument
    ): ChatPanel {
        const column = vscode.ViewColumn.Beside;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            ChatPanel.currentPanel._document = document;
            ChatPanel.currentPanel.loadSession();
            return ChatPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'mdclChat',
            'CodeLab Chat',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, document);
        return ChatPanel.currentPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        document: vscode.TextDocument
    ) {
        this._panel = panel;
        this._document = document;
        this._session = {
            documentUri: document.uri.toString(),
            messages: []
        };

        this.initialize();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'sendMessage':
                        await this.handleUserMessage(message.content);
                        break;
                    case 'clearChat':
                        this.clearChat();
                        break;
                    case 'stopGeneration':
                        this.stopGeneration();
                        break;
                    case 'openConfig':
                        await this.openConfig();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async initialize() {
        await this.loadConfig();
        this.loadSession();
        this.update();
    }

    private async loadConfig() {
        this._config = await ConfigLoader.loadConfig();

        if (this._config) {
            const defaultModel = ConfigLoader.getDefaultModel(this._config);
            if (defaultModel) {
                this._llmClient = new LLMClient(defaultModel);
                this._panel.webview.postMessage({
                    type: 'configLoaded',
                    model: defaultModel.model
                });
            }
        } else {
            this._panel.webview.postMessage({
                type: 'configError',
                message: 'Configuration not loaded. Please set up your config file.'
            });
        }
    }

    private loadSession() {
        // For now, start fresh. In the future, could persist to workspace state
        this._session = {
            documentUri: this._document.uri.toString(),
            messages: []
        };

        // Add system message with tutorial context
        const context = TutorialContextExtractor.extractContext(this._document);
        const contextFormatted = TutorialContextExtractor.formatContextForLLM(context);

        const defaultModel = this._config ? ConfigLoader.getDefaultModel(this._config) : null;
        const systemPrompt = defaultModel?.systemPrompt ||
            'You are a helpful tutor. Answer questions about the tutorial content provided as context. Be concise and educational.';

        this._session.messages.push({
            role: 'system',
            content: `${systemPrompt}\n\n${contextFormatted}`,
            timestamp: Date.now()
        });
    }

    private async handleUserMessage(content: string) {
        if (!this._llmClient || !this._config) {
            this._panel.webview.postMessage({
                type: 'error',
                message: 'Chat is not configured. Please set up your .codelab/config.yaml file.'
            });
            return;
        }

        // Add user message
        const userMessage: ChatMessage = {
            role: 'user',
            content,
            timestamp: Date.now()
        };

        this._session.messages.push(userMessage);

        this._panel.webview.postMessage({
            type: 'userMessage',
            message: userMessage
        });

        // Show thinking indicator
        // Create abort controller for this generation
        this._abortController = new AbortController();

        this._panel.webview.postMessage({
            type: 'thinking',
            thinking: true
        });

        try {
            let assistantContent = '';

            // Send to LLM with streaming
            await this._llmClient.sendMessage(
                this._session.messages,
                (chunk: string) => {
                    // Check if aborted
                    if (this._abortController?.signal.aborted) {
                        throw new Error('Generation stopped by user');
                    }
                    assistantContent += chunk;
                    this._panel.webview.postMessage({
                        type: 'streamChunk',
                        content: chunk
                    });
                },
                this._abortController.signal // Pass the abort signal
            );

            // Add assistant message to session
            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now()
            };

            this._session.messages.push(assistantMessage);

            this._panel.webview.postMessage({
                type: 'thinking',
                thinking: false
            });

            this._panel.webview.postMessage({
                type: 'assistantMessage',
                message: assistantMessage
            });

            // Clear abort controller
            this._abortController = null;

        } catch (error) {
            this._panel.webview.postMessage({
                type: 'thinking',
                thinking: false
            });

            // Clear abort controller
            this._abortController = null;

            // Don't show error if it was manually stopped
            if (error instanceof Error &&
                (error.message === 'Generation stopped by user' ||
                 error.message === 'Request was aborted' ||
                 error.message === 'Stream reading aborted')) {
                return;
            }

            this._panel.webview.postMessage({
                type: 'error',
                message: `Error: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    private stopGeneration() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        this._panel.webview.postMessage({
            type: 'thinking',
            thinking: false
        });
    }

    private clearChat() {
        this.loadSession();
        this._panel.webview.postMessage({
            type: 'chatCleared'
        });
    }

    private async openConfig() {
        const configPath = ConfigLoader.getConfigPath();
        if (configPath) {
            const document = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(document);
        }
    }

    private update() {
        this._panel.webview.html = this.getHtmlContent(this._panel.webview);
    }

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeLab Chat</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
        }

        .header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background-color: var(--vscode-sideBar-background);
        }

        .header h3 {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .header-actions button {
            padding: 4px 8px;
            font-size: 11px;
            border: none;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            border-radius: 2px;
        }

        .header-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .message {
            display: flex;
            flex-direction: column;
            max-width: 85%;
            animation: fadeIn 0.2s ease-in;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user {
            align-self: flex-end;
        }

        .message.assistant {
            align-self: flex-start;
        }

        .message-header {
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 4px;
            opacity: 0.7;
        }

        .message.user .message-header {
            text-align: right;
        }

        .message-content {
            padding: 10px 14px;
            border-radius: 8px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .message.assistant .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }

        .thinking {
            display: none;
            align-self: flex-start;
            padding: 10px 14px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            font-style: italic;
            opacity: 0.7;
        }

        .thinking.active {
            display: block;
        }

        .thinking::after {
            content: '...';
            animation: dots 1.5s steps(4, end) infinite;
        }

        @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
        }

        .input-container {
            padding: 16px;
            border-top: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-sideBar-background);
        }

        .input-wrapper {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }

        textarea {
            flex: 1;
            padding: 10px 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: 13px;
            resize: none;
            min-height: 40px;
            max-height: 120px;
        }

        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        button.send-btn {
            padding: 10px 20px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
        }

        button.send-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        button.stop-btn {
            padding: 10px 20px;
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            display: none;
        }

        button.stop-btn.active {
            display: block;
        }

        button.stop-btn:hover {
            background-color: var(--vscode-inputValidation-errorBorder);
        }

        button.send-btn.hidden {
            display: none;
        }

        .error-message {
            padding: 12px;
            background-color: rgba(244, 67, 54, 0.1);
            border: 1px solid rgba(244, 67, 54, 0.3);
            border-radius: 4px;
            color: var(--vscode-errorForeground);
            margin: 8px 16px;
        }

        .config-warning {
            padding: 12px;
            background-color: rgba(255, 152, 0, 0.1);
            border: 1px solid rgba(255, 152, 0, 0.3);
            border-radius: 4px;
            margin: 8px 16px;
        }

        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>💬 Tutorial Assistant</h3>
        <div class="header-actions">
            <button id="configBtn">⚙️ Config</button>
            <button id="clearBtn">🗑️ Clear</button>
        </div>
    </div>

    <div class="chat-container" id="chatContainer">
        <div class="message assistant">
            <div class="message-header">Assistant</div>
            <div class="message-content">Hi! I'm VSLabsAI. I'm here to help you with this tutorial. Ask me anything about the content, commands, or concepts covered.</div>
        </div>
    </div>

    <div class="thinking" id="thinking">Thinking</div>

    <div class="input-container">
        <div class="input-wrapper">
            <textarea
                id="messageInput"
                placeholder="Ask a question about the tutorial..."
                rows="1"
            ></textarea>
            <button class="send-btn" id="sendBtn">Send</button>
            <button class="stop-btn" id="stopBtn">Stop</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const stopBtn = document.getElementById('stopBtn');
        const clearBtn = document.getElementById('clearBtn');
        const configBtn = document.getElementById('configBtn');
        const thinking = document.getElementById('thinking');

        let currentStreamingMessage = null;
        let isGenerating = false;

        // Auto-resize textarea
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = messageInput.scrollHeight + 'px';
        });

        // Send message on Enter (Shift+Enter for new line)
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendBtn.addEventListener('click', sendMessage);
        stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));
        clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearChat' }));
        configBtn.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }));

        function sendMessage() {
            const content = messageInput.value.trim();
            if (!content) return;

            vscode.postMessage({
                type: 'sendMessage',
                content: content
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        function addMessage(role, content) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;

            messageDiv.innerHTML = \`
                <div class="message-header">\${role === 'user' ? 'You' : 'Assistant'}</div>
                <div class="message-content">\${escapeHtml(content)}</div>
            \`;

            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Listen for messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.type) {
                case 'userMessage':
                    addMessage('user', message.message.content);
                    break;

                case 'thinking':
                    thinking.classList.toggle('active', message.thinking);
                    isGenerating = message.thinking;

                    // Toggle send/stop buttons
                    if (isGenerating) {
                        sendBtn.classList.add('hidden');
                        stopBtn.classList.add('active');
                        currentStreamingMessage = document.createElement('div');
                        currentStreamingMessage.className = 'message assistant';
                        currentStreamingMessage.innerHTML = \`
                            <div class="message-header">Assistant</div>
                            <div class="message-content"></div>
                        \`;
                        chatContainer.appendChild(currentStreamingMessage);
                    } else {
                        sendBtn.classList.remove('hidden');
                        stopBtn.classList.remove('active');
                    }
                    break;

                case 'streamChunk':
                    if (currentStreamingMessage) {
                        const content = currentStreamingMessage.querySelector('.message-content');
                        content.textContent += message.content;
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    break;

                case 'assistantMessage':
                    currentStreamingMessage = null;
                    break;

                case 'error':
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'error-message';
                    errorDiv.textContent = message.message;
                    chatContainer.appendChild(errorDiv);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    break;

                case 'chatCleared':
                    chatContainer.innerHTML = \`
                        <div class="message assistant">
                            <div class="message-header">Assistant</div>
                            <div class="message-content">Hi! I'm VSLabsAI. I'm here to help you with this tutorial. Ask me anything about the content, commands, or concepts covered.</div>
                        </div>
                    \`;
                    break;

                case 'configError':
                    const warningDiv = document.createElement('div');
                    warningDiv.className = 'config-warning';
                    warningDiv.innerHTML = \`
                        ⚠️ \${message.message}<br>
                        <button onclick="vscode.postMessage({ type: 'openConfig' })" style="margin-top: 8px;">Open Config</button>
                    \`;
                    chatContainer.insertBefore(warningDiv, chatContainer.firstChild);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
