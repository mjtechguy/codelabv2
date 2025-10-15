import * as vscode from 'vscode';
import { encode } from 'gpt-tokenizer';
import { ConfigLoader } from './configLoader';
import { LLMClient } from './llmClient';
import { TutorialContextExtractor } from './tutorialContext';
import { ContextManager } from './contextManager';
import { SessionManager } from './sessionManager';
import { SmartContextManager } from './smartContextManager';
import { ChatMessage, ChatSession, ChatConfig, ModelConfig, ContextItem } from '../types/chat';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vslabsai.chatView';
    private _view?: vscode.WebviewView;
    private _config: ChatConfig | null = null;
    private _llmClient: LLMClient | null = null;
    private _sessionManager: SessionManager;
    private _currentDocument: vscode.TextDocument | null = null;
    private _availableModels: ModelConfig[] = [];
    private _currentModel: ModelConfig | null = null;
    private _abortController: AbortController | null = null;
    private _openDocuments: Set<string> = new Set();  // Track all open documents
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._sessionManager = new SessionManager();
        this._sessionManager.initialize(_context); // Initialize with context for persistence

        // Track ALL open documents, not just mdcl
        this.trackOpenDocuments();

        // Listen for active editor changes (for ANY file type)
        const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                this.updateImplicitContext();
            }
        });
        this._disposables.push(activeEditorDisposable);

        // Listen for text document open/close events
        const openDisposable = vscode.workspace.onDidOpenTextDocument(document => {
            this._openDocuments.add(document.uri.toString());
            this.updateImplicitContext();
        });
        this._disposables.push(openDisposable);

        const closeDisposable = vscode.workspace.onDidCloseTextDocument(document => {
            this._openDocuments.delete(document.uri.toString());
            this.updateImplicitContext();
        });
        this._disposables.push(closeDisposable);

        // Set initial document if one is open (for backward compatibility with mdcl focus)
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            this.setActiveDocument(activeEditor.document);
        }
    }

    /**
     * Track all currently open documents
     */
    private trackOpenDocuments(): void {
        // Get all currently open text documents
        vscode.workspace.textDocuments.forEach(doc => {
            // Skip untitled documents and output channels
            if (doc.uri.scheme === 'file') {
                this._openDocuments.add(doc.uri.toString());
                console.log('Tracking open document:', doc.fileName);
            }
        });
        console.log('Total open documents tracked:', this._openDocuments.size);
    }

    /**
     * Update implicit context based on open files
     */
    private async updateImplicitContext(): Promise<void> {
        const session = this._sessionManager.getActiveSession();
        if (!session) return;

        // Convert open documents to array
        const implicitUris = Array.from(this._openDocuments);

        // Update session with implicit context
        this._sessionManager.updateImplicitContext(session.id, implicitUris);

        // Update UI
        this.updateContextDisplay();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'sendMessage':
                    await this.handleUserMessage(data.content);
                    break;
                case 'stopGeneration':
                    this.stopGeneration();
                    break;
                case 'clearChat':
                    this.clearChat();
                    break;
                case 'openConfig':
                    await this.openConfig();
                    break;
                case 'ready':
                    await this.initialize();
                    break;
                case 'switchModel':
                    await this.switchModel(data.modelName);
                    break;
                case 'newSession':
                    await this.createNewSession();
                    break;
                case 'switchSession':
                    await this.switchSession(data.sessionId);
                    break;
                case 'selectContext':
                    await this.selectContext();
                    break;
                case 'deleteSession':
                    await this.deleteSession(data.sessionId);
                    break;
                case 'removeContext':
                    await this.removeContextItem(data.uri, data.isImplicit);
                    break;
                case 'addOpenEditors':
                    await this.addOpenEditorsToContext();
                    break;
                case 'addCodebase':
                    await this.addCodebaseToContext();
                    break;
                case 'addFile':
                    await this.addFileToContext(data.uri);
                    break;
                case 'selectSymbols':
                    // TODO: Implement symbol selection
                    vscode.window.showInformationMessage('Symbol selection coming soon!');
                    break;
            }
        });
    }

    /**
     * Add all open editors to context
     */
    private async addOpenEditorsToContext(): Promise<void> {
        const session = this._sessionManager.getActiveSession();
        if (!session) return;

        const openDocs = Array.from(this._openDocuments);
        if (openDocs.length === 0) {
            vscode.window.showInformationMessage('No open editors to add');
            return;
        }

        // Add all open documents to explicit context
        const updatedUris = [...new Set([...session.contextUris, ...openDocs])];
        this._sessionManager.updateSessionContext(session.id, updatedUris, 'custom');

        await this.updateContextDisplay();
        this.updateContextBadge();
    }

    /**
     * Add entire codebase to context
     */
    private async addCodebaseToContext(): Promise<void> {
        const session = this._sessionManager.getActiveSession();
        if (!session) return;

        // Set context type to workspace
        this._sessionManager.updateSessionContext(session.id, [], 'workspace');

        await this.updateContextDisplay();
        this.updateContextBadge();

        vscode.window.showInformationMessage('Entire codebase added to context');
    }

    /**
     * Add a specific file to context
     */
    private async addFileToContext(uri: string): Promise<void> {
        const session = this._sessionManager.getActiveSession();
        if (!session || !uri) return;

        // Add file to explicit context if not already there
        if (!session.contextUris.includes(uri)) {
            const updatedUris = [...session.contextUris, uri];
            this._sessionManager.updateSessionContext(session.id, updatedUris, 'custom');

            await this.updateContextDisplay();
            this.updateContextBadge();
        }
    }

    private async initialize() {
        await this.loadConfig();

        // Always load a session, even without a document
        await this.loadSession();

        // Initialize implicit context with currently open files
        await this.updateImplicitContext();
    }

    private async setActiveDocument(document: vscode.TextDocument) {
        this._currentDocument = document;
        if (this._view) {
            await this.loadSession();
            this._view.webview.postMessage({
                type: 'documentChanged',
                filename: 'VSLABSAI: AI LEARNING ASSISTANT'
            });
        }
    }

    private async loadConfig() {
        this._config = await ConfigLoader.loadConfig();

        if (this._config) {
            this._availableModels = ConfigLoader.getModels(this._config);
            this._currentModel = ConfigLoader.getDefaultModel(this._config);

            if (this._currentModel) {
                this._llmClient = new LLMClient(this._currentModel);

                // Send model list to webview with full config including pricing
                this._view?.webview.postMessage({
                    type: 'configLoaded',
                    models: this._availableModels.map(m => ({
                        name: m.name || m.model,
                        model: m.model,
                        pricing: m.pricing // Include pricing information
                    })),
                    currentModel: this._currentModel.name || this._currentModel.model
                });
            }
        } else {
            this._view?.webview.postMessage({
                type: 'configError',
                message: 'Configuration not loaded. Click the gear icon to set up.'
            });
        }
    }

    private async switchModel(modelName: string) {
        const model = this._availableModels.find(m =>
            (m.name || m.model) === modelName
        );

        if (model) {
            this._currentModel = model;
            this._llmClient = new LLMClient(model);

            this._view?.webview.postMessage({
                type: 'modelSwitched',
                modelName: model.name || model.model,
                models: this._availableModels.map(m => ({
                    name: m.name || m.model,
                    model: m.model,
                    pricing: m.pricing // Include pricing information
                }))
            });
        }
    }

    private async loadSession() {
        // Get or create active session
        let session = this._sessionManager.getActiveSession();

        if (!session) {
            // Create default session with empty explicit context
            // (implicit context from open files will be added separately)
            const contextUris: string[] = [];
            const name = 'Chat 1';
            session = this._sessionManager.createSession(name, 'custom', contextUris);
        }

        // Combine explicit and implicit context URIs for initial load
        const allContextUris = [
            ...session.contextUris,
            ...(session.implicitContextUris || [])
        ];
        const uniqueContextUris = Array.from(new Set(allContextUris));

        // Build INITIAL smart context (summary for first load)
        const contextContent = await SmartContextManager.buildSmartContext(
            uniqueContextUris,
            uniqueContextUris.length === 1 ? 'file' : 'custom',
            undefined  // No query yet, will provide summary
        );

        // Clear existing system messages
        session.messages = session.messages.filter(m => m.role !== 'system');

        // Add system message with initial context
        const systemPrompt = this._currentModel?.systemPrompt ||
            this._config?.model?.systemPrompt ||
            'You are a helpful tutor. Answer questions about the tutorial content provided as context. Be concise and educational. When context is summarized, you can ask users to be more specific if they need detailed information.';

        if (contextContent) {
            session.messages.unshift({
                role: 'system',
                content: `${systemPrompt}\n\n${contextContent}`,
                timestamp: Date.now()
            });
        }

        // Update UI
        this.updateSessionsUI();
        this.updateContextBadge();
        await this.updateContextDisplay();  // Update context pills

        this._view?.webview.postMessage({
            type: 'sessionLoaded',
            filename: 'CODELAB: AI LEARNING ASSISTANT'
        });
    }

    private async handleUserMessage(content: string) {
        if (!this._llmClient || !this._config) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'Chat is not configured. Click the gear icon to set up.'
            });
            return;
        }

        const session = this._sessionManager.getActiveSession();
        if (!session) {
            this._view?.webview.postMessage({
                type: 'error',
                message: 'No active session. Please reload the chat.'
            });
            return;
        }

        // Combine explicit and implicit context URIs
        const allContextUris = [
            ...session.contextUris,
            ...(session.implicitContextUris || [])
        ];

        // Remove duplicates
        const uniqueContextUris = Array.from(new Set(allContextUris));

        // REBUILD context based on user's query for smart filtering
        const smartContext = await SmartContextManager.buildSmartContext(
            uniqueContextUris,
            uniqueContextUris.length === 1 ? 'file' : 'custom',
            content  // Use user's query to filter relevant context
        );

        // Update system message with query-specific context
        const systemPrompt = this._currentModel?.systemPrompt ||
            this._config?.model?.systemPrompt ||
            'You are a helpful tutor. Answer questions about the tutorial content provided as context. Be concise and educational.';

        // Replace system message with new context
        const systemMessage: ChatMessage = {
            role: 'system',
            content: `${systemPrompt}\n\n${smartContext}`,
            timestamp: Date.now()
        };

        // Build messages for LLM: system + previous conversation + new user message
        const userMessage: ChatMessage = {
            role: 'user',
            content,
            timestamp: Date.now()
        };

        // Get recent conversation history (last 10 non-system messages)
        const recentMessages = session.messages
            .filter(m => m.role !== 'system')
            .slice(-10);

        // Combine: system message + recent history + new user message
        const messagesForLLM = [
            systemMessage,
            ...recentMessages,
            userMessage
        ];

        // Add user message to session
        this._sessionManager.addMessage(session.id, userMessage);

        this._view?.webview.postMessage({
            type: 'userMessage',
            message: userMessage
        });

        // Show thinking indicator
        // Create abort controller for this generation
        this._abortController = new AbortController();

        this._view?.webview.postMessage({
            type: 'thinking',
            thinking: true
        });

        try {
            let assistantContent = '';

            // Send to LLM with streaming (use messagesForLLM, not session.messages)
            await this._llmClient.sendMessage(
                messagesForLLM,
                (chunk: string) => {
                    // Check if aborted
                    if (this._abortController?.signal.aborted) {
                        throw new Error('Generation stopped by user');
                    }
                    assistantContent += chunk;
                    this._view?.webview.postMessage({
                        type: 'streamChunk',
                        content: chunk
                    });
                },
                this._abortController.signal // Pass the abort signal to LLM client
            );

            // Add assistant message to session
            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: assistantContent,
                timestamp: Date.now()
            };

            this._sessionManager.addMessage(session.id, assistantMessage);

            this._view?.webview.postMessage({
                type: 'thinking',
                thinking: false
            });

            this._view?.webview.postMessage({
                type: 'assistantMessage',
                message: assistantMessage
            });

            // Clear abort controller
            this._abortController = null;

        } catch (error) {
            this._view?.webview.postMessage({
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
                // Send a message to indicate generation was stopped
                this._view?.webview.postMessage({
                    type: 'generationStopped',
                    message: 'Generation stopped'
                });
                return;
            }

            this._view?.webview.postMessage({
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
        this._view?.webview.postMessage({
            type: 'thinking',
            thinking: false
        });
    }

    private async clearChat() {
        const session = this._sessionManager.getActiveSession();
        if (session) {
            this._sessionManager.clearSession(session.id);
            await this.loadSession();
        }
        this._view?.webview.postMessage({
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

    private async createNewSession() {
        // Get name for new session
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for the new chat session',
            placeHolder: 'e.g., "Tutorial Part 1"',
            value: `Chat ${this._sessionManager.getSessionCount() + 1}`
        });

        if (!name) {
            return;
        }

        // Create session with current document as default context
        const contextUris = this._currentDocument ? [this._currentDocument.uri.toString()] : [];
        const session = this._sessionManager.createSession(name, 'file', contextUris);

        // Update UI
        this.updateSessionsUI();
        this.updateContextBadge();

        // Reload session
        await this.loadSession();
    }

    private async switchSession(sessionId?: string) {
        // If no sessionId provided, show picker
        if (!sessionId) {
            const sessions = this._sessionManager.getAllSessions();
            const activeSession = this._sessionManager.getActiveSession();

            const items = sessions.map(s => ({
                label: s.name,
                description: s.id === activeSession?.id ? '(Current)' : '',
                detail: `${s.messages.filter(m => m.role !== 'system').length} messages`,
                sessionId: s.id
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a chat session'
            });

            if (!selected) {
                return;
            }

            sessionId = selected.sessionId;
        }

        const session = this._sessionManager.setActiveSession(sessionId);
        if (!session) {
            return;
        }

        // Update UI
        this.updateSessionsUI();
        this.updateContextBadge();

        // Send messages to webview
        this._view?.webview.postMessage({
            type: 'sessionSwitched',
            messages: session.messages
        });
    }

    private async selectContext() {
        const items = await ContextManager.getAvailableContextItems();

        const quickPick = vscode.window.createQuickPick();
        quickPick.items = items.map(item => ({
            label: item.name,
            description: item.uri,
            detail: item.type
        }));
        quickPick.canSelectMany = true;
        quickPick.placeholder = 'Select files or folders for context';

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems;
            if (selected.length === 0) {
                quickPick.hide();
                return;
            }

            // Determine context type
            const hasFolder = selected.some(item => item.detail === 'folder');
            const contextType = hasFolder ? 'folder' : selected.length === 1 ? 'file' : 'custom';

            // Update active session context
            const activeSession = this._sessionManager.getActiveSession();
            if (activeSession) {
                const uris = selected.map(item => item.description || '');
                this._sessionManager.updateSessionContext(activeSession.id, uris, contextType);

                // Update UI
                this.updateContextBadge();

                // Reload session with new context
                this.loadSession().catch(err => console.error('Failed to reload session:', err));
            }

            quickPick.hide();
        });

        quickPick.show();
    }

    private async deleteSession(sessionId: string) {
        // Don't delete if it's the only session
        const sessions = this._sessionManager.getAllSessions();
        if (sessions.length <= 1) {
            vscode.window.showWarningMessage('Cannot delete the last chat session');
            return;
        }

        const deleted = this._sessionManager.deleteSession(sessionId);
        if (deleted) {
            this.updateSessionsUI();
            await this.loadSession();
        }
    }

    /**
     * Remove a context item from the session
     */
    private async removeContextItem(uri: string, isImplicit: boolean): Promise<void> {
        const session = this._sessionManager.getActiveSession();
        if (!session) return;

        if (isImplicit) {
            // For implicit context, we just remove it from tracking
            this._openDocuments.delete(uri);
            await this.updateImplicitContext();
        } else {
            // For explicit context, remove from session's context URIs
            const newContextUris = session.contextUris.filter(u => u !== uri);
            this._sessionManager.updateSessionContext(
                session.id,
                newContextUris,
                newContextUris.length === 0 ? 'custom' : session.contextType
            );
            this.updateContextBadge();
            await this.updateContextDisplay();
        }
    }

    private updateSessionsUI() {
        const sessions = this._sessionManager.getAllSessions();
        const activeSession = this._sessionManager.getActiveSession();

        this._view?.webview.postMessage({
            type: 'sessionsUpdated',
            sessions: sessions.map(s => ({
                id: s.id,
                name: s.name,
                contextType: s.contextType
            })),
            activeSessionId: activeSession?.id
        });
    }

    private updateContextBadge() {
        const activeSession = this._sessionManager.getActiveSession();
        if (!activeSession) {
            return;
        }

        // Count both explicit and implicit context
        const explicitCount = activeSession.contextUris.length;
        const implicitCount = activeSession.implicitContextUris?.length || 0;
        const totalCount = explicitCount + implicitCount;

        let contextText = '';

        if (totalCount === 0) {
            contextText = '';  // Don't show "No context", just leave empty
        } else if (activeSession.contextType === 'workspace') {
            contextText = 'Entire workspace';
        } else if (activeSession.contextType === 'folder') {
            // Show folder name
            const uri = vscode.Uri.parse(activeSession.contextUris[0]);
            const folderName = uri.fsPath.split('/').pop() || 'Folder';
            contextText = folderName;
        } else if (totalCount === 1) {
            // Try to get name from first available context
            const firstUri = activeSession.contextUris[0] || activeSession.implicitContextUris?.[0];
            if (firstUri) {
                const uri = vscode.Uri.parse(firstUri);
                contextText = uri.fsPath.split('/').pop() || 'File';
            }
        } else {
            contextText = `${totalCount} files`;
        }

        this._view?.webview.postMessage({
            type: 'contextUpdated',
            contextText
        });
    }

    /**
     * Update the context display with pills
     */
    private async updateContextDisplay(): Promise<void> {
        const activeSession = this._sessionManager.getActiveSession();
        if (!activeSession) {
            console.log('No active session for context display');
            return;
        }

        console.log('Updating context display - explicit:', activeSession.contextUris.length, 'implicit:', activeSession.implicitContextUris?.length || 0);

        const contextItems: ContextItem[] = [];

        // Add explicit context items
        for (const uriStr of activeSession.contextUris) {
            const uri = vscode.Uri.parse(uriStr);
            const name = uri.fsPath.split('/').pop() || 'Unknown';
            const ext = name.split('.').pop()?.toLowerCase() || '';

            contextItems.push({
                type: 'file',
                uri: uriStr,
                name,
                icon: this.getFileIcon(ext),
                isImplicit: false
            });
        }

        // Add implicit context items (open files)
        if (activeSession.implicitContextUris) {
            for (const uriStr of activeSession.implicitContextUris) {
                // Skip if already in explicit context
                if (activeSession.contextUris.includes(uriStr)) continue;

                const uri = vscode.Uri.parse(uriStr);
                const name = uri.fsPath.split('/').pop() || 'Unknown';
                const ext = name.split('.').pop()?.toLowerCase() || '';

                contextItems.push({
                    type: 'file',
                    uri: uriStr,
                    name,
                    icon: this.getFileIcon(ext),
                    isImplicit: true
                });
            }
        }

        // Send context items to webview
        this._view?.webview.postMessage({
            type: 'contextItemsUpdated',
            contextItems
        });
    }

    /**
     * Get icon identifier for file extension
     */
    private getFileIcon(ext: string): string {
        const iconMap: { [key: string]: string } = {
            'ts': 'codicon-file-text',
            'tsx': 'codicon-file-text',
            'js': 'codicon-file-text',
            'jsx': 'codicon-file-text',
            'md': 'codicon-markdown',
            'mdcl': 'codicon-markdown',
            'json': 'codicon-json',
            'yaml': 'codicon-file-text',
            'yml': 'codicon-file-text',
            'html': 'codicon-file-text',
            'css': 'codicon-file-text',
            'scss': 'codicon-file-text',
            'py': 'codicon-file-text',
            'java': 'codicon-file-text',
            'go': 'codicon-file-text',
            'rs': 'codicon-file-text',
            'c': 'codicon-file-text',
            'cpp': 'codicon-file-text',
            'h': 'codicon-file-text',
            'hpp': 'codicon-file-text',
            'sh': 'codicon-terminal',
            'bash': 'codicon-terminal',
            'sql': 'codicon-database'
        };

        return iconMap[ext] || 'codicon-file';
    }

    /**
     * Dispose of resources
     */
    public dispose(): void {
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeLab Chat</title>
    <style>
        /* Codicon font for VS Code icons */
        @font-face {
            font-family: 'codicon';
            src: url('vscode-resource:codicon.ttf') format('truetype');
        }

        .codicon {
            font-family: 'codicon';
            font-weight: normal;
            font-style: normal;
            display: inline-block;
            text-decoration: none;
            text-rendering: auto;
            text-align: center;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            user-select: none;
            -webkit-user-select: none;
            line-height: 1;
        }

        /* Icon codes */
        .codicon-file:before { content: '\\eac8' }
        .codicon-folder:before { content: '\\ea83' }
        .codicon-symbol-class:before { content: '\\eb5b' }
        .codicon-code:before { content: '\\eae8' }
        .codicon-terminal:before { content: '\\ea85' }
        .codicon-edit:before { content: '\\ea73' }
        .codicon-selection:before { content: '\\eab2' }
        .codicon-repo:before { content: '\\ea62' }
        .codicon-add:before { content: '\\ea60' }
        .codicon-close:before { content: '\\ea76' }
        .codicon-warning:before { content: '\\ea6c' }
        .codicon-trash:before { content: '\\ea81' }
        .codicon-settings-gear:before { content: '\\ea7a' }
        .codicon-attach:before { content: '\\eb16' }
        .codicon-send:before { content: '\\ead5' }
        .codicon-stop:before { content: '\\ead7' }
        .codicon-file-text:before { content: '\\eb08' }
        .codicon-markdown:before { content: '\\eb03' }
        .codicon-json:before { content: '\\eb0f' }
        .codicon-source-control:before { content: '\\ea68' }
        .codicon-database:before { content: '\\eb8c' }
        .codicon-tools:before { content: '\\eb40' }
        .codicon-symbol-namespace:before { content: '\\eb5e' }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-sideBar-background);
        }

        /* Chat Tabs */
        .chat-tabs {
            display: flex;
            align-items: center;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            height: 35px;
            padding: 0 8px;
            gap: 2px;
            overflow-x: auto;
            flex-shrink: 0;
        }

        .chat-tab {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 12px;
            font-size: 12px;
            color: var(--vscode-foreground);
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
            min-width: 80px;
            max-width: 150px;
            position: relative;
        }

        .chat-tab:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .chat-tab.active {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .chat-tab-close {
            margin-left: auto;
            opacity: 0.5;
            font-size: 16px;
            line-height: 1;
            padding: 0 2px;
        }

        .chat-tab:hover .chat-tab-close {
            opacity: 1;
        }

        .new-chat-btn {
            padding: 4px 8px;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 18px;
            border-radius: 4px;
            opacity: 0.7;
            margin-left: auto;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 28px;
        }

        .new-chat-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
            opacity: 1;
        }

        .header {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }

        .header-title {
            font-size: 13px;
            font-weight: 600;
        }

        .header-actions {
            display: flex;
            gap: 6px;
        }

        .model-selector {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .model-selector label {
            font-size: 11px;
            opacity: 0.8;
        }

        .model-selector select {
            flex: 1;
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 12px;
            cursor: pointer;
        }

        .model-selector select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .model-selector.hidden {
            display: none;
        }

        .icon-btn {
            padding: 4px 8px;
            font-size: 18px;
            font-weight: 400;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: all 0.2s;
        }

        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            opacity: 1;
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-height: 0;
        }

        /* Modern Chat Bubbles */
        .message {
            display: flex;
            flex-direction: column;
            gap: 4px;
            animation: slideIn 0.3s ease-out;
            max-width: 85%;
            margin-bottom: 16px;
        }

        .message-footer {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 4px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
        }

        .message-footer-meta {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
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
            opacity: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 4px;
            margin-bottom: 4px;
            position: relative;
            color: var(--vscode-editor-foreground);
        }

        .message-meta {
            font-size: 11px;
            opacity: 1;
            margin-left: auto;
            text-transform: none;
            color: var(--vscode-textLink-foreground);
            font-weight: normal;
        }

        .copy-message-btn {
            background: transparent;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px 12px;
            border-radius: 4px;
            transition: all 0.2s;
            font-size: 11px;
            font-weight: normal;
            margin-left: auto;
        }

        .copy-message-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .message.user .message-header {
            justify-content: flex-end;
        }

        /* Material Design Icons */
        .message-icon {
            width: 16px;
            height: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            font-size: 9px;
            font-weight: 600;
            flex-shrink: 0;
        }

        .message.user .message-icon {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #ffffff;
        }

        .message.assistant .message-icon {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border);
            color: var(--vscode-editor-foreground);
        }

        .message-content {
            padding: 10px 14px;
            border-radius: 16px;
            line-height: 1.5;
            font-size: 13px;
            position: relative;
            box-shadow: 0 1px 2px rgba(0,0,0,0.08);
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        /* User message bubble - blue/purple */
        .message.user .message-content {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #ffffff;
            border-radius: 16px 16px 4px 16px;
            white-space: pre-wrap;
        }

        /* Assistant message bubble - dark gray */
        .message.assistant .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 16px 16px 16px 4px;
            color: var(--vscode-editor-foreground);
        }

        /* Markdown styles for assistant messages */
        .message.assistant .message-content p {
            margin: 0.5em 0;
        }

        .message.assistant .message-content p:first-child {
            margin-top: 0;
        }

        .message.assistant .message-content p:last-child {
            margin-bottom: 0;
        }

        .message.assistant .message-content h1,
        .message.assistant .message-content h2,
        .message.assistant .message-content h3,
        .message.assistant .message-content h4,
        .message.assistant .message-content h5,
        .message.assistant .message-content h6 {
            margin: 0.8em 0 0.4em 0;
            font-weight: 600;
        }

        .message.assistant .message-content h1 { font-size: 1.4em; }
        .message.assistant .message-content h2 { font-size: 1.3em; }
        .message.assistant .message-content h3 { font-size: 1.2em; }
        .message.assistant .message-content h4 { font-size: 1.1em; }

        .message.assistant .message-content code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: 'Courier New', Courier, monospace;
            font-size: 0.9em;
        }

        .message.assistant .message-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 0.5em 0;
        }

        .message.assistant .message-content pre code {
            background: none;
            padding: 0;
        }

        .message.assistant .message-content ul,
        .message.assistant .message-content ol {
            margin: 0.5em 0;
            padding-left: 1.5em;
        }

        .message.assistant .message-content li {
            margin: 0.2em 0;
        }

        .message.assistant .message-content blockquote {
            border-left: 3px solid var(--vscode-textLink-foreground);
            margin: 0.5em 0;
            padding-left: 0.8em;
            opacity: 0.8;
        }

        .message.assistant .message-content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .message.assistant .message-content a:hover {
            text-decoration: underline;
        }

        /* Table with responsive wrapping */
        .message.assistant .message-content table {
            border-collapse: collapse;
            margin: 0.5em 0;
            width: 100%;
            font-size: 11px;
            display: block;
            overflow-x: auto;
            max-width: 100%;
        }

        .message.assistant .message-content thead,
        .message.assistant .message-content tbody {
            display: table;
            width: 100%;
            table-layout: fixed;
        }

        .message.assistant .message-content th,
        .message.assistant .message-content td {
            border: 1px solid var(--vscode-panel-border);
            padding: 4px 6px;
            text-align: left;
            overflow: hidden;
            text-overflow: ellipsis;
            word-wrap: break-word;
            max-width: 0;
        }

        .message.assistant .message-content th {
            background-color: var(--vscode-textBlockQuote-background);
            font-weight: 600;
        }

        .message.assistant .message-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 0.8em 0;
        }

        /* Syntax highlighting styles */
        .message.assistant .message-content .hljs {
            display: block;
            overflow-x: auto;
        }

        .message.assistant .message-content .hljs-keyword,
        .message.assistant .message-content .hljs-selector-tag {
            color: var(--vscode-symbolIcon-keywordForeground, #569CD6);
        }

        .message.assistant .message-content .hljs-string {
            color: var(--vscode-symbolIcon-stringForeground, #CE9178);
        }

        .message.assistant .message-content .hljs-number,
        .message.assistant .message-content .hljs-literal {
            color: var(--vscode-symbolIcon-numberForeground, #B5CEA8);
        }

        .message.assistant .message-content .hljs-function,
        .message.assistant .message-content .hljs-title {
            color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
        }

        .message.assistant .message-content .hljs-comment {
            color: var(--vscode-symbolIcon-constantForeground, #6A9955);
            font-style: italic;
        }

        .message.assistant .message-content .hljs-variable,
        .message.assistant .message-content .hljs-attr {
            color: var(--vscode-symbolIcon-variableForeground, #9CDCFE);
        }

        .message.assistant .message-content .hljs-class,
        .message.assistant .message-content .hljs-type {
            color: var(--vscode-symbolIcon-classForeground, #4EC9B0);
        }

        /* Modern Thinking Indicator */
        .thinking {
            display: none;
            align-self: flex-start;
            max-width: 85%;
            animation: slideIn 0.3s ease-out;
        }

        .thinking.active {
            display: block;
        }

        .thinking-bubble {
            padding: 12px 14px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 12px 12px 12px 2px;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }

        .thinking-dots {
            display: flex;
            gap: 4px;
        }

        .thinking-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--vscode-editor-foreground);
            opacity: 0.4;
            animation: pulse 1.4s ease-in-out infinite;
        }

        .thinking-dot:nth-child(2) {
            animation-delay: 0.2s;
        }

        .thinking-dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        @keyframes pulse {
            0%, 60%, 100% {
                opacity: 0.4;
                transform: scale(1);
            }
            30% {
                opacity: 1;
                transform: scale(1.2);
            }
        }

        /* Context Pills */
        .context-pills {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            min-height: 36px;
        }

        .context-pills.empty {
            display: none;
        }

        .context-pill {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            font-size: 12px;
            font-weight: 400;
            cursor: default;
            transition: all 0.1s;
            max-width: 200px;
        }

        .context-pill.implicit {
            opacity: 0.8;
            border-style: dashed;
        }

        .context-pill:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .context-pill-icon {
            flex-shrink: 0;
            font-size: 14px;
            margin-right: 2px;
        }

        .context-pill-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .context-pill-remove {
            margin-left: 2px;
            opacity: 0.6;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            flex-shrink: 0;
        }

        .context-pill-remove:hover {
            opacity: 1;
        }

        /* Confirmation Modal */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 2000;
            align-items: center;
            justify-content: center;
        }

        .modal-overlay.active {
            display: flex;
        }

        .modal-content {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }

        .modal-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            font-weight: 600;
            font-size: 14px;
            color: var(--vscode-foreground);
        }

        .modal-body {
            margin-bottom: 20px;
            font-size: 13px;
            line-height: 1.5;
            color: var(--vscode-foreground);
            opacity: 0.9;
        }

        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .modal-btn {
            padding: 6px 14px;
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.1s;
            font-weight: 500;
        }

        .modal-btn-cancel {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .modal-btn-cancel:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .modal-btn-delete {
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
            border-color: var(--vscode-inputValidation-errorBorder);
        }

        .modal-btn-delete:hover {
            filter: brightness(1.1);
        }

        /* Copy Button for Code Blocks */
        .message.assistant .message-content pre {
            position: relative;
        }

        .code-copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            padding: 4px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .message.assistant .message-content pre:hover .code-copy-btn {
            opacity: 1;
        }

        .code-copy-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .code-copy-btn.copied {
            background-color: var(--vscode-button-background);
            opacity: 1 !important;
        }

        .input-container {
            position: relative;
            padding: 8px 12px 12px 12px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            gap: 8px;
            flex-shrink: 0;
        }

        /* Context Menu Dropdown */
        .context-menu {
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            max-height: 400px;
            overflow-y: auto;
            display: none;
            z-index: 1000;
            margin-bottom: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }

        .context-menu.active {
            display: block;
        }

        .context-menu-search {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .context-menu-search input {
            width: 100%;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 12px;
            outline: none;
        }

        .context-menu-search input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .context-menu-section {
            padding: 4px 0;
        }

        .context-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--vscode-foreground);
            transition: background-color 0.1s;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .context-menu-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .context-menu-icon {
            width: 16px;
            text-align: center;
            flex-shrink: 0;
        }

        .context-menu-label {
            flex: 1;
        }

        .context-menu-description {
            opacity: 0.7;
            font-size: 11px;
            margin-left: auto;
        }

        /* Bottom Controls Row - Below Input */
        .bottom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 0 0 0;
            font-size: 12px;
        }

        /* Model selector with box */
        .model-selector-bottom {
            margin-left: auto;
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            overflow: hidden;
            height: 26px;
        }

        .model-selector-bottom.hidden {
            display: none;
        }

        .model-select-bottom {
            padding: 4px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: none;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.1s;
            height: 100%;
            min-width: 120px;
        }

        .model-select-bottom:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .model-select-bottom:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        /* Hash Mention Autocomplete */
        .hash-autocomplete {
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            max-height: 300px;
            overflow-y: auto;
            display: none;
            z-index: 100;
            margin-bottom: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }

        .hash-autocomplete.active {
            display: block;
        }

        .hash-option {
            padding: 8px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 12px;
            border-left: 2px solid transparent;
        }

        .hash-option:hover,
        .hash-option.selected {
            background-color: var(--vscode-list-hoverBackground);
            border-left-color: var(--vscode-focusBorder);
        }

        .hash-option-icon {
            flex-shrink: 0;
            width: 16px;
            text-align: center;
            opacity: 0.8;
            color: var(--vscode-textLink-foreground);
        }

        .hash-option-name {
            flex: 1;
            color: var(--vscode-textLink-foreground);
            font-weight: 500;
        }

        .hash-option-description {
            font-size: 11px;
            opacity: 0.6;
            margin-left: auto;
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
        }

        /* Input Container with Add Context */
        .input-wrapper {
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            background-color: var(--vscode-input-background);
            overflow: hidden;
        }

        .input-wrapper:focus-within {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .input-top-bar {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
            min-height: 28px;
        }

        .add-context-btn {
            padding: 2px 6px;
            background: transparent;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
            font-weight: 500;
            transition: all 0.1s;
            border-radius: 3px;
        }

        .add-context-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .input-text-area {
            display: flex;
            gap: 6px;
            align-items: flex-end;
            padding: 8px;
        }

        textarea {
            flex: 1;
            padding: 0;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            outline: none;
            min-height: 24px;
            max-height: 120px;
            line-height: 1.4;
        }

        textarea:focus {
            outline: none;
        }

        button.send-btn,
        button.stop-btn {
            padding: 10px 14px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            min-width: 44px;
            min-height: 40px;
        }

        button.stop-btn {
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }

        button.stop-btn:hover {
            background-color: var(--vscode-inputValidation-errorBorder);
        }

        button.send-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        button.send-btn.hidden,
        button.stop-btn.hidden {
            display: none;
        }

        .info-message {
            padding: 10px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            border-radius: 3px;
            font-size: 12px;
            margin: 8px 0;
        }

        .error-message {
            padding: 10px;
            background-color: rgba(244, 67, 54, 0.1);
            border: 1px solid rgba(244, 67, 54, 0.3);
            border-radius: 4px;
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin: 8px 0;
        }

        .welcome {
            padding: 32px 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }

        .welcome-icon {
            width: 64px;
            height: 64px;
            margin: 0 auto 16px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            font-weight: 600;
            color: #ffffff;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }

        .welcome-text {
            font-size: 13px;
            line-height: 1.5;
        }

        /* Context and Session Styles */
        .context-session-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .context-badge {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
        }

        .context-badge:hover {
            opacity: 0.8;
        }

        .session-selector {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .session-selector select {
            padding: 4px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
        }

        .session-selector select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .new-session-btn {
            padding: 2px 6px;
            font-size: 14px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }

        .new-session-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .session-selector.hidden {
            display: none;
        }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.0/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/highlight.min.js"></script>
    <script>
        // Configure marked to use highlight.js
        marked.setOptions({
            highlight: function(code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(code, { language: lang }).value;
                    } catch (err) {}
                }
                return code;
            }
        });
    </script>
</head>
<body>
    <!-- Confirmation Modal -->
    <div class="modal-overlay" id="confirmModal">
        <div class="modal-content">
            <div class="modal-header">
                <span class="codicon codicon-warning"></span>
                <span>Close Chat?</span>
            </div>
            <div class="modal-body">
                Are you sure you want to close this chat?<br><br>
                <strong>All messages and context in this chat will be permanently deleted.</strong>
            </div>
            <div class="modal-footer">
                <button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>
                <button class="modal-btn modal-btn-delete" id="modalConfirm">Delete Chat</button>
            </div>
        </div>
    </div>

    <!-- Chat Tabs -->
    <div class="chat-tabs" id="chatTabs">
        <div class="chat-tab active" data-session-id="default">
            <span>Chat 1</span>
            <span class="chat-tab-close" style="display: none;">×</span>
        </div>
        <button class="new-chat-btn" id="newChatBtn" title="New Chat">+</button>
    </div>

    <!-- Header with settings -->
    <div class="header" style="display: none;">
        <div class="header-title">
            <span id="headerText">AI Assistant</span>
        </div>
        <div class="header-actions">
            <button class="icon-btn" id="clearBtn" title="Clear Chat"><span class="codicon codicon-trash"></span></button>
            <button class="icon-btn" id="configBtn" title="Settings"><span class="codicon codicon-settings-gear"></span></button>
        </div>
    </div>

    <div class="chat-container" id="chatContainer">
        <div class="welcome">
            <div class="welcome-icon">CL</div>
            <div class="welcome-text">
                <strong>Welcome to CodeLab V2 Chat</strong><br>
                Open files or select context to get started.
            </div>
        </div>
    </div>

    <div class="thinking" id="thinking">
        <div class="thinking-bubble">
            <div class="thinking-dots">
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
            </div>
            <span style="font-size: 12px; opacity: 0.7;">Thinking...</span>
        </div>
    </div>

    <!-- Context Pills Container -->
    <div class="context-pills empty" id="contextPills">
        <!-- Pills will be added dynamically -->
    </div>

    <div class="input-container">
        <!-- Context Menu Dropdown -->
        <div class="context-menu" id="contextMenu">
            <div class="context-menu-search">
                <input type="text" id="contextSearchInput" placeholder="Search for files and context to add to your request" />
            </div>
            <div class="context-menu-section">
                <div class="context-menu-item" data-type="open-editors">
                    <span class="context-menu-icon codicon codicon-file-text"></span>
                    <span class="context-menu-label">Open Editors</span>
                </div>
                <div class="context-menu-item" data-type="files">
                    <span class="context-menu-icon codicon codicon-folder"></span>
                    <span class="context-menu-label">Files & Folders...</span>
                </div>
                <div class="context-menu-item" data-type="codebase">
                    <span class="context-menu-icon codicon codicon-repo"></span>
                    <span class="context-menu-label">Codebase</span>
                </div>
                <div class="context-menu-item" data-type="symbols">
                    <span class="context-menu-icon codicon codicon-symbol-namespace"></span>
                    <span class="context-menu-label">Symbols...</span>
                </div>
            </div>
            <div class="context-menu-section" id="recentFiles">
                <!-- Recent files will be added here -->
            </div>
        </div>

        <!-- Hash Autocomplete Dropdown -->
        <div class="hash-autocomplete" id="hashAutocomplete">
            <!-- Options will be added dynamically -->
        </div>

        <!-- Input Wrapper with Add Context -->
        <div class="input-wrapper">
            <div class="input-top-bar">
                <button class="add-context-btn" id="addContextBtn">
                    <span class="codicon codicon-attach"></span>
                    <span>Add Context</span>
                </button>
            </div>
            <div class="input-text-area">
                <textarea
                    id="messageInput"
                    placeholder="Ask a question... (type # for context)"
                    rows="1"
                ></textarea>
                <button class="send-btn" id="sendBtn"><span class="codicon codicon-send"></span></button>
                <button class="stop-btn hidden" id="stopBtn" title="Stop generation"><span class="codicon codicon-stop"></span></button>
            </div>
        </div>

        <!-- Model Selector Below -->
        <div class="bottom-controls">
            <div class="model-selector-bottom" id="modelSelector">
                <select id="modelSelect" class="model-select-bottom">
                    <option value="">Loading...</option>
                </select>
            </div>
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
        const modelSelector = document.getElementById('modelSelector');
        const modelSelect = document.getElementById('modelSelect');
        const contextPills = document.getElementById('contextPills');
        const hashAutocomplete = document.getElementById('hashAutocomplete');
        const chatTabs = document.getElementById('chatTabs');
        const newChatBtn = document.getElementById('newChatBtn');
        const addContextBtn = document.getElementById('addContextBtn');
        const contextMenu = document.getElementById('contextMenu');
        const contextSearchInput = document.getElementById('contextSearchInput');
        const recentFiles = document.getElementById('recentFiles');
        const confirmModal = document.getElementById('confirmModal');
        const modalCancel = document.getElementById('modalCancel');
        const modalConfirm = document.getElementById('modalConfirm');

        let currentStreamingMessage = null;
        let pendingDeleteSessionId = null;
        let isGenerating = false;
        let hasContext = false;
        let contextItems = [];
        let hashOptions = [];
        let selectedHashIndex = -1;
        let currentModelName = 'Claude 3.5 Sonnet'; // Default model name
        let currentModelConfig = null; // Store full model config for pricing
        let currentInputTokens = 0; // Track input tokens for current message

        // Token counting function
        function countTokens(text) {
            try {
                // Simple approximation: ~1 token per 4 characters
                // For more accurate counting, we'd need to pass through to backend
                const tokens = Math.ceil(text.length / 4);
                return tokens;
            } catch (e) {
                console.error('Error counting tokens:', e);
                return 0;
            }
        }

        // Calculate cost based on token count and model pricing
        function calculateCost(inputTokens, outputTokens, modelConfig) {
            if (!modelConfig?.pricing) {
                return null;
            }

            const inputCost = (inputTokens / 1000000) * modelConfig.pricing.inputCost;
            const outputCost = (outputTokens / 1000000) * modelConfig.pricing.outputCost;
            const totalCost = inputCost + outputCost;

            // Format to reasonable precision
            if (totalCost === 0) {
                return 'Free';
            } else if (totalCost < 0.0001) {
                return '<$0.0001';
            } else if (totalCost < 0.01) {
                return '$' + totalCost.toFixed(4);
            } else {
                return '$' + totalCost.toFixed(3);
            }
        }

        // Get current model name
        function getCurrentModelName() {
            return currentModelName || 'Claude 3.5 Sonnet';
        }

        // Copy message content
        window.copyMessageContent = function(button) {
            const messageDiv = button.closest('.message');
            const contentDiv = messageDiv.querySelector('.message-content');
            if (contentDiv) {
                // Get text content without HTML
                const text = contentDiv.innerText || contentDiv.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    // Show feedback
                    const originalHTML = button.innerHTML;
                    button.innerHTML = '✓';
                    setTimeout(() => {
                        button.innerHTML = originalHTML;
                    }, 1500);
                }).catch(err => {
                    console.error('Failed to copy:', err);
                });
            }
        };

        // Function to update chat tabs
        function updateChatTabs(sessions, activeSessionId) {
            if (!chatTabs) return;

            // Clear existing tabs (except the new chat button)
            const existingTabs = chatTabs.querySelectorAll('.chat-tab');
            existingTabs.forEach(tab => tab.remove());

            // Add tabs for each session
            sessions.forEach((session, index) => {
                const tab = document.createElement('div');
                tab.className = 'chat-tab' + (session.id === activeSessionId ? ' active' : '');
                tab.dataset.sessionId = session.id;

                const nameSpan = document.createElement('span');
                nameSpan.textContent = session.name || \`Chat \${index + 1}\`;
                tab.appendChild(nameSpan);

                // Add close button for non-active tabs or if there's more than one tab
                if (sessions.length > 1) {
                    const closeBtn = document.createElement('span');
                    closeBtn.className = 'chat-tab-close';
                    closeBtn.textContent = '×';
                    closeBtn.onclick = (e) => {
                        e.stopPropagation();
                        // Show custom confirmation modal
                        showDeleteConfirmation(session.id);
                    };
                    tab.appendChild(closeBtn);
                }

                // Click handler to switch sessions
                tab.onclick = () => {
                    if (session.id !== activeSessionId) {
                        vscode.postMessage({ type: 'switchSession', sessionId: session.id });
                    }
                };

                // Insert before the new chat button
                chatTabs.insertBefore(tab, newChatBtn);
            });
        }

        // Function to update context pills display
        function updateContextPills(items) {
            contextItems = items;
            contextPills.innerHTML = '';

            if (items.length === 0) {
                contextPills.classList.add('empty');
                hasContext = false;
                return;
            }

            contextPills.classList.remove('empty');
            hasContext = true;

            items.forEach((item, index) => {
                const pill = document.createElement('div');
                pill.className = 'context-pill' + (item.isImplicit ? ' implicit' : '');
                pill.title = item.isImplicit ? 'Open file (automatically added)' : 'Explicit context';

                pill.innerHTML = \`
                    <span class="context-pill-icon codicon \${item.icon || 'codicon-file'}"></span>
                    <span class="context-pill-name">\${item.name}</span>
                    <span class="context-pill-remove" data-index="\${index}">×</span>
                \`;

                // Add click handler to remove button
                const removeBtn = pill.querySelector('.context-pill-remove');
                if (removeBtn) {
                    removeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const idx = parseInt(removeBtn.getAttribute('data-index'));
                        removeContextItem(idx);
                    });
                }

                contextPills.appendChild(pill);
            });
        }

        // Function to remove a context item
        function removeContextItem(index) {
            if (index >= 0 && index < contextItems.length) {
                const item = contextItems[index];
                vscode.postMessage({
                    type: 'removeContext',
                    uri: item.uri,
                    isImplicit: item.isImplicit
                });
            }
        }

        // Hash autocomplete functionality
        function initHashOptions() {
            return [
                { icon: 'codicon-repo', name: 'codebase', description: 'Searches through the codebase and pulls out relevant information' },
                { icon: 'codicon-edit', name: 'editor', description: 'Current editor content' },
                { icon: 'codicon-file', name: 'file', description: 'Specific file' },
                { icon: 'codicon-selection', name: 'selection', description: 'Current selection' },
                { icon: 'codicon-terminal', name: 'terminalLastCommand', description: 'Last terminal command' },
                { icon: 'codicon-terminal', name: 'terminalSelection', description: 'Terminal selection' },
                { icon: 'codicon-symbol-class', name: 'vscodeAPI', description: 'VS Code API reference' }
            ];
        }

        function showHashAutocomplete(searchTerm = '') {
            hashOptions = initHashOptions();

            // Filter options based on search term
            if (searchTerm) {
                hashOptions = hashOptions.filter(opt =>
                    opt.name.toLowerCase().includes(searchTerm.toLowerCase())
                );
            }

            // Add available files as options
            contextItems.forEach(item => {
                if (!searchTerm || item.name.toLowerCase().includes(searchTerm.toLowerCase())) {
                    hashOptions.push({
                        icon: item.icon || 'codicon-file',
                        name: item.name,
                        description: 'File'
                    });
                }
            });

            if (hashOptions.length === 0) {
                hideHashAutocomplete();
                return;
            }

            // Build dropdown HTML
            hashAutocomplete.innerHTML = '';
            hashOptions.forEach((option, index) => {
                const optionEl = document.createElement('div');
                optionEl.className = 'hash-option' + (index === selectedHashIndex ? ' selected' : '');
                optionEl.innerHTML = \`
                    <span class="hash-option-icon codicon \${option.icon}"></span>
                    <span class="hash-option-name">#\${option.name}</span>
                    <span class="hash-option-description">\${option.description}</span>
                \`;
                optionEl.addEventListener('click', () => selectHashOption(index));
                hashAutocomplete.appendChild(optionEl);
            });

            hashAutocomplete.classList.add('active');
            selectedHashIndex = 0;
            updateHashSelection();

            console.log('Hash autocomplete should be visible now');
        }

        function hideHashAutocomplete() {
            hashAutocomplete.classList.remove('active');
            selectedHashIndex = -1;
        }

        function updateHashSelection() {
            const options = hashAutocomplete.querySelectorAll('.hash-option');
            options.forEach((opt, index) => {
                if (index === selectedHashIndex) {
                    opt.classList.add('selected');
                    opt.scrollIntoView({ block: 'nearest' });
                } else {
                    opt.classList.remove('selected');
                }
            });
        }

        function selectHashOption(index) {
            if (index >= 0 && index < hashOptions.length) {
                const option = hashOptions[index];
                const cursorPos = messageInput.selectionStart;
                const text = messageInput.value;

                // Find the start of the hash mention
                let hashStart = text.lastIndexOf('#', cursorPos - 1);
                if (hashStart === -1) return;

                // Replace the hash mention with the selected option
                const before = text.substring(0, hashStart);
                const after = text.substring(cursorPos);
                messageInput.value = before + '#' + option.name + ' ' + after;

                // Update cursor position
                const newPos = hashStart + option.name.length + 2;
                messageInput.setSelectionRange(newPos, newPos);
                messageInput.focus();

                hideHashAutocomplete();
            }
        }

        // Notify that webview is ready
        vscode.postMessage({ type: 'ready' });

        // Auto-resize textarea and handle hash mentions
        messageInput.addEventListener('input', (e) => {
            messageInput.style.height = 'auto';
            messageInput.style.height = messageInput.scrollHeight + 'px';

            // Check for hash mention
            const text = messageInput.value;
            const cursorPos = messageInput.selectionStart;

            // Look for # before cursor
            const beforeCursor = text.substring(0, cursorPos);
            const hashMatch = beforeCursor.match(/#([a-zA-Z0-9._-]*)$/);

            if (hashMatch) {
                const searchTerm = hashMatch[1];
                showHashAutocomplete(searchTerm);
            } else {
                hideHashAutocomplete();
            }
        });

        // Send message on Enter (Shift+Enter for new line)
        messageInput.addEventListener('keydown', (e) => {
            // Handle hash autocomplete navigation
            if (hashAutocomplete.classList.contains('active')) {
                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        selectedHashIndex = Math.min(selectedHashIndex + 1, hashOptions.length - 1);
                        updateHashSelection();
                        return;
                    case 'ArrowUp':
                        e.preventDefault();
                        selectedHashIndex = Math.max(selectedHashIndex - 1, 0);
                        updateHashSelection();
                        return;
                    case 'Enter':
                    case 'Tab':
                        if (selectedHashIndex >= 0) {
                            e.preventDefault();
                            selectHashOption(selectedHashIndex);
                            return;
                        }
                        break;
                    case 'Escape':
                        e.preventDefault();
                        hideHashAutocomplete();
                        return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendBtn.addEventListener('click', sendMessage);
        stopBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'stopGeneration' });
        });

        // New chat button
        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'newSession' });
        });

        // Clear button (if it exists in header)
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                // You could show a confirmation for clear as well
                const confirmClear = confirm('Are you sure you want to clear all messages in this chat?');
                if (confirmClear) {
                    vscode.postMessage({ type: 'clearChat' });
                }
            });
        }

        // Config button (if it exists)
        if (configBtn) {
            configBtn.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }));
        }

        // Add Context button - opens context menu
        addContextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleContextMenu();
        });

        // Close context menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target) && e.target !== addContextBtn) {
                hideContextMenu();
            }
        });

        // Handle context menu item clicks
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (item) {
                const type = item.dataset.type;
                handleContextMenuSelection(type);
            }
        });

        // Handle context menu search
        if (contextSearchInput) {
            contextSearchInput.addEventListener('input', (e) => {
                filterContextMenu(e.target.value);
            });
        }

        function toggleContextMenu() {
            if (contextMenu.classList.contains('active')) {
                hideContextMenu();
            } else {
                showContextMenu();
            }
        }

        function showContextMenu() {
            contextMenu.classList.add('active');
            if (contextSearchInput) {
                contextSearchInput.focus();
            }
            updateRecentFiles();
        }

        function hideContextMenu() {
            contextMenu.classList.remove('active');
            if (contextSearchInput) {
                contextSearchInput.value = '';
            }
        }

        function handleContextMenuSelection(type) {
            switch(type) {
                case 'open-editors':
                    vscode.postMessage({ type: 'addOpenEditors' });
                    break;
                case 'files':
                    vscode.postMessage({ type: 'selectContext' });
                    break;
                case 'codebase':
                    vscode.postMessage({ type: 'addCodebase' });
                    break;
                case 'symbols':
                    vscode.postMessage({ type: 'selectSymbols' });
                    break;
                default:
                    if (type && type.startsWith('file:')) {
                        const uri = type.substring(5);
                        vscode.postMessage({ type: 'addFile', uri });
                    }
            }
            hideContextMenu();
        }

        function updateRecentFiles() {
            // This will be populated with actual recent files
            recentFiles.innerHTML = '';

            // Add recent files from context items
            contextItems.forEach(item => {
                if (item.type === 'file') {
                    const fileItem = document.createElement('div');
                    fileItem.className = 'context-menu-item';
                    fileItem.dataset.type = 'file:' + item.uri;
                    fileItem.innerHTML = \`
                        <span class="context-menu-icon codicon \${item.icon || 'codicon-file'}"></span>
                        <span class="context-menu-label">\${item.name}</span>
                        <span class="context-menu-description">recently opened</span>
                    \`;
                    recentFiles.appendChild(fileItem);
                }
            });
        }

        function filterContextMenu(searchTerm) {
            const items = contextMenu.querySelectorAll('.context-menu-item');
            items.forEach(item => {
                const label = item.querySelector('.context-menu-label');
                if (label) {
                    const text = label.textContent.toLowerCase();
                    if (text.includes(searchTerm.toLowerCase())) {
                        item.style.display = 'flex';
                    } else {
                        item.style.display = 'none';
                    }
                }
            });
        }

        // Modal handlers
        function showDeleteConfirmation(sessionId) {
            pendingDeleteSessionId = sessionId;
            confirmModal.classList.add('active');
        }

        function hideDeleteConfirmation() {
            pendingDeleteSessionId = null;
            confirmModal.classList.remove('active');
        }

        modalCancel.addEventListener('click', hideDeleteConfirmation);

        modalConfirm.addEventListener('click', () => {
            if (pendingDeleteSessionId) {
                vscode.postMessage({ type: 'deleteSession', sessionId: pendingDeleteSessionId });
                hideDeleteConfirmation();
            }
        });

        // Close modal on overlay click
        confirmModal.addEventListener('click', (e) => {
            if (e.target === confirmModal) {
                hideDeleteConfirmation();
            }
        });

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && confirmModal.classList.contains('active')) {
                hideDeleteConfirmation();
            }
        });

        // Note: Session switching is now handled via tabs

        // Model selector
        modelSelect.addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'switchModel',
                modelName: e.target.value
            });
        });


        function sendMessage() {
            const content = messageInput.value.trim();
            if (!content) return;

            if (!hasContext) {
                // Show inline error instead of alert (sandboxed environment)
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error-message';
                errorDiv.textContent = 'Please select context first by clicking the ⊕ Context button below.';
                chatContainer.appendChild(errorDiv);
                chatContainer.scrollTop = chatContainer.scrollHeight;
                setTimeout(() => errorDiv.remove(), 5000);
                return;
            }

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

            // Render markdown for assistant messages, escape HTML for user messages
            const renderedContent = role === 'assistant'
                ? marked.parse(content)
                : escapeHtml(content);

            // Material design flat icons
            const icon = role === 'user'
                ? '<span class="message-icon">U</span>'
                : '<span class="message-icon">AI</span>';

            const label = role === 'user' ? 'You' : 'Assistant';

            // Calculate token count
            const tokenCount = countTokens(content);
            const modelName = getCurrentModelName();

            // For assistant messages, calculate cost (assume input was previous user message)
            let costEstimate = null;
            if (role === 'assistant') {
                // Get input tokens from previous user message
                const messages = chatContainer.querySelectorAll('.message');
                let inputTokens = 0;
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].classList.contains('user')) {
                        const userContent = messages[i].querySelector('.message-content')?.textContent || '';
                        inputTokens = countTokens(userContent);
                        break;
                    }
                }
                costEstimate = calculateCost(inputTokens, tokenCount, currentModelConfig);
            }

            // Combine tokens and cost for display
            const tokenCostDisplay = tokenCount > 0 ?
                \`\${tokenCount} tokens\${costEstimate ? \` / \${costEstimate}\` : ''}\` : '';

            messageDiv.innerHTML = \`
                <div class="message-header">
                    \${icon} \${label}
                </div>
                <div class="message-content">\${renderedContent}</div>
                \${role === 'assistant' ? \`
                    <div class="message-footer">
                        <div class="message-footer-meta">
                            \${tokenCostDisplay ? \`<span>\${tokenCostDisplay}</span>\` : ''}
                            \${modelName ? \`<span>• \${modelName}</span>\` : ''}
                        </div>
                        <button class="copy-message-btn" onclick="copyMessageContent(this)" title="Copy message">
                            Copy
                        </button>
                    </div>
                \` : ''}
            \`;

            chatContainer.appendChild(messageDiv);

            // Add copy buttons to code blocks in assistant messages
            if (role === 'assistant') {
                addCopyButtonsToCodeBlocks(messageDiv);
            }

            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function addCopyButtonsToCodeBlocks(messageElement) {
            const codeBlocks = messageElement.querySelectorAll('pre');
            codeBlocks.forEach(pre => {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'code-copy-btn';
                copyBtn.textContent = 'Copy';
                copyBtn.onclick = () => {
                    const code = pre.querySelector('code');
                    const text = code ? code.textContent : pre.textContent;
                    navigator.clipboard.writeText(text).then(() => {
                        copyBtn.textContent = 'Copied!';
                        copyBtn.classList.add('copied');
                        setTimeout(() => {
                            copyBtn.textContent = 'Copy';
                            copyBtn.classList.remove('copied');
                        }, 2000);
                    });
                };
                pre.appendChild(copyBtn);
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function renderMarkdown(text) {
            return marked.parse(text);
        }

        function showWelcome() {
            const welcomeMessage = '👋 Hi! I\\'m here to help you with this tutorial. Ask me anything about the content, commands, or concepts covered.';
            chatContainer.innerHTML = \`
                <div class="message assistant">
                    <div class="message-header">Assistant</div>
                    <div class="message-content">\${marked.parse(welcomeMessage)}</div>
                </div>
            \`;
        }

        // Listen for messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.type) {
                case 'noDocument':
                    chatContainer.innerHTML = \`
                        <div class="welcome">
                            <div class="welcome-icon">CL</div>
                            <div class="welcome-text">
                                <strong>Welcome to CodeLab V2 Chat</strong><br>
                                Open files or select context to get started.
                            </div>
                        </div>
                    \`;
                    // Keep input enabled so users can select context
                    messageInput.disabled = false;
                    sendBtn.disabled = false;
                    break;

                case 'documentChanged':
                case 'sessionLoaded':
                    messageInput.disabled = false;
                    sendBtn.disabled = false;
                    if (message.filename) {
                        headerText.textContent = message.filename;
                    }
                    showWelcome();
                    break;

                case 'userMessage':
                    addMessage('user', message.message.content);
                    break;

                case 'thinking':
                    thinking.classList.toggle('active', message.thinking);
                    isGenerating = message.thinking;

                    // Toggle send/stop buttons
                    if (isGenerating) {
                        sendBtn.classList.add('hidden');
                        stopBtn.classList.remove('hidden');

                        // Track input tokens from the user message
                        const lastUserMessage = Array.from(chatContainer.querySelectorAll('.message.user')).pop();
                        if (lastUserMessage) {
                            const userContent = lastUserMessage.querySelector('.message-content')?.textContent || '';
                            currentInputTokens = countTokens(userContent);
                        }

                        currentStreamingMessage = document.createElement('div');
                        currentStreamingMessage.className = 'message assistant';
                        currentStreamingMessage.dataset.inputTokens = currentInputTokens;
                        currentStreamingMessage.innerHTML = \`
                            <div class="message-header">
                                <span class="message-icon">AI</span> Assistant
                            </div>
                            <div class="message-content"></div>
                            <div class="message-footer" style="display: none;">
                                <div class="message-footer-meta">
                                    <span class="token-count"></span>
                                    <span class="model-name"></span>
                                </div>
                                <button class="copy-message-btn" onclick="copyMessageContent(this)" title="Copy message">
                                    Copy
                                </button>
                            </div>
                        \`;
                        chatContainer.appendChild(currentStreamingMessage);
                    } else {
                        sendBtn.classList.remove('hidden');
                        stopBtn.classList.add('hidden');
                    }
                    break;

                case 'streamChunk':
                    if (currentStreamingMessage) {
                        const content = currentStreamingMessage.querySelector('.message-content');
                        // Store plain text during streaming
                        if (!content.dataset.plainText) {
                            content.dataset.plainText = '';
                        }
                        content.dataset.plainText += message.content;

                        // Render markdown in real-time
                        content.innerHTML = marked.parse(content.dataset.plainText);

                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    break;

                case 'assistantMessage':
                    // Final render when streaming is complete (in case of any updates)
                    if (currentStreamingMessage) {
                        const content = currentStreamingMessage.querySelector('.message-content');
                        const plainText = content.dataset.plainText || content.textContent;
                        content.innerHTML = marked.parse(plainText);
                        delete content.dataset.plainText;

                        // Update footer with token count, model and cost
                        const footer = currentStreamingMessage.querySelector('.message-footer');
                        if (footer) {
                            const outputTokens = countTokens(plainText);
                            const inputTokens = parseInt(currentStreamingMessage.dataset.inputTokens || '0');
                            const modelName = getCurrentModelName();
                            const cost = calculateCost(inputTokens, outputTokens, currentModelConfig);

                            const tokenSpan = footer.querySelector('.token-count');
                            const modelSpan = footer.querySelector('.model-name');

                            // Combine tokens and cost in one display
                            if (tokenSpan && outputTokens > 0) {
                                const tokenText = \`\${outputTokens} tokens\`;
                                const costText = cost ? \` / \${cost}\` : '';
                                tokenSpan.textContent = tokenText + costText;
                            }
                            if (modelSpan && modelName) {
                                modelSpan.textContent = modelName;
                            }

                            // Show the footer
                            footer.style.display = 'flex';
                        }

                        // Add copy buttons to code blocks
                        addCopyButtonsToCodeBlocks(currentStreamingMessage);
                    }
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
                    showWelcome();
                    break;

                case 'configError':
                    const infoDiv = document.createElement('div');
                    infoDiv.className = 'info-message';
                    infoDiv.textContent = '⚙️ ' + message.message;
                    chatContainer.insertBefore(infoDiv, chatContainer.firstChild);
                    break;

                case 'configLoaded':
                    // Remove any config error messages
                    const oldInfo = chatContainer.querySelector('.info-message');
                    if (oldInfo) oldInfo.remove();

                    // Populate model dropdown
                    if (message.models && message.models.length > 1) {
                        modelSelector.classList.remove('hidden');
                        modelSelect.innerHTML = message.models.map(m =>
                            \`<option value="\${m.name}" \${m.name === message.currentModel ? 'selected' : ''}>\${m.name}</option>\`
                        ).join('');
                        currentModelName = message.currentModel || message.models[0].name;
                        // Find and store the current model config with pricing
                        currentModelConfig = message.models.find(m => m.name === currentModelName) || message.models[0];
                    } else {
                        modelSelector.classList.add('hidden');
                        currentModelName = message.models[0]?.name || 'Claude';
                        currentModelConfig = message.models?.[0] || null;
                    }
                    break;

                case 'modelSwitched':
                    modelSelect.value = message.modelName;
                    currentModelName = message.modelName;
                    // Find and store the new model config with pricing
                    if (message.models) {
                        currentModelConfig = message.models.find(m => m.name === message.modelName);
                    }
                    break;

                case 'contextUpdated':
                    // Don't show any text for context badge, just update hasContext flag
                    hasContext = message.contextText && message.contextText !== '';
                    break;

                case 'contextItemsUpdated':
                    updateContextPills(message.contextItems || []);
                    break;

                case 'sessionsUpdated':
                    // Update chat tabs
                    updateChatTabs(message.sessions || [], message.activeSessionId);
                    break;

                case 'sessionSwitched':
                    // Reload chat with new session
                    showWelcome();
                    if (message.messages) {
                        message.messages.forEach(msg => {
                            if (msg.role !== 'system') {
                                addMessage(msg.role, msg.content);
                            }
                        });
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
