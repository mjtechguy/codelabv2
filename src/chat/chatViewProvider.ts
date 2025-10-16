import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { encode } from 'gpt-tokenizer';
import { ConfigLoader } from './configLoader';
import { LLMClient } from './llmClient';
import { TutorialContextExtractor } from './tutorialContext';
import { ContextManager } from './contextManager';
import { SessionManager } from './sessionManager';
import { SmartContextManager } from './smartContextManager';
import { ChatMessage, ChatSession, ChatConfig, ModelConfig, ContextItem, FileTreeItem } from '../types/chat';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vslabsai.chatView';
    public static currentProvider: ChatViewProvider | undefined;
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
        ChatViewProvider.currentProvider = this;
        this._sessionManager = new SessionManager();
        // Note: initialization happens in initialize() method, called when webview is ready

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
            }
        });
    }

    /**
     * Update implicit context based on open files
     */
    private async updateImplicitContext(): Promise<void> {
        const session = await this._sessionManager.getActiveSession();
        if (!session) return;

        // Convert open documents to array
        const implicitUris = Array.from(this._openDocuments);

        // Update session with implicit context
        await this._sessionManager.updateImplicitContext(session.id, implicitUris);

        // Update UI
        await this.updateContextDisplay();
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
                case 'clearAllSessions':
                    await this.clearAllSessions();
                    break;
                case 'renameSession':
                    await this.renameSession(data.sessionId);
                    break;
                case 'renameSessionInline':
                    this.renameSessionInline(data.sessionId, data.newName);
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
                case 'addFiles':
                    await this.addFilesToContext(data.uris);
                    break;
                case 'getWorkspaceFiles':
                    await this.sendWorkspaceFiles();
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
        const session = await this._sessionManager.getActiveSession();
        if (!session) return;

        const openDocs = Array.from(this._openDocuments);
        if (openDocs.length === 0) {
            vscode.window.showInformationMessage('No open editors to add');
            return;
        }

        // Add all open documents to explicit context
        const updatedUris = [...new Set([...session.contextUris, ...openDocs])];
        await this._sessionManager.updateSessionContext(session.id, updatedUris, 'custom');

        await this.updateContextDisplay();
        await this.updateContextBadge();
    }

    /**
     * Add entire codebase to context
     */
    private async addCodebaseToContext(): Promise<void> {
        const session = await this._sessionManager.getActiveSession();
        if (!session) return;

        // Set context type to workspace
        await this._sessionManager.updateSessionContext(session.id, [], 'workspace');

        await this.updateContextDisplay();
        await this.updateContextBadge();

        vscode.window.showInformationMessage('Entire codebase added to context');
    }

    private async addFilesToContext(uris: string[]) {
        const session = await this._sessionManager.getActiveSession();
        if (!session) return;

        // Add multiple files to context, validating each one
        const newUris = [...session.contextUris];
        for (const uri of uris) {
            // Skip empty or invalid URIs
            if (!uri || uri.trim() === '') {
                continue;
            }

            // Validate URI before adding
            try {
                const parsedUri = vscode.Uri.parse(uri);
                if (!parsedUri.fsPath || parsedUri.fsPath === '') {
                    console.error(`Invalid file URI: ${uri}`);
                    continue;
                }

                if (!newUris.includes(uri)) {
                    newUris.push(uri);
                }
            } catch (error) {
                console.error(`Failed to parse URI: ${uri}`, error);
                continue;
            }
        }

        await this._sessionManager.updateSessionContext(session.id, newUris, 'custom');
        await this.updateContextBadge();
        await this.updateContextDisplay();
    }

    private async sendWorkspaceFiles() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this._view?.webview.postMessage({
                type: 'workspaceFiles',
                files: []
            });
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const fileTree = await this.buildFileTree(rootPath);

        this._view?.webview.postMessage({
            type: 'workspaceFiles',
            files: fileTree
        });
    }

    private async buildFileTree(dirPath: string, depth: number = 0): Promise<FileTreeItem[]> {
        // Limit recursion depth to avoid performance issues
        if (depth > 3) return [];

        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const files: FileTreeItem[] = [];

            // Filter out common directories to ignore
            const ignorePatterns = ['node_modules', '.git', 'dist', 'build', 'out', '.vscode', '.DS_Store'];

            for (const item of items) {
                if (ignorePatterns.some(pattern => item.name.includes(pattern))) {
                    continue;
                }

                const fullPath = path.join(dirPath, item.name);
                const uri = vscode.Uri.file(fullPath).toString();

                if (item.isDirectory()) {
                    const children = depth < 2 ? await this.buildFileTree(fullPath, depth + 1) : [];
                    files.push({
                        name: item.name,
                        uri: uri,
                        type: 'folder',
                        children: children
                    });
                } else {
                    files.push({
                        name: item.name,
                        uri: uri,
                        type: 'file'
                    });
                }
            }

            // Sort: folders first, then files, both alphabetically
            files.sort((a, b) => {
                if (a.type === b.type) {
                    return a.name.localeCompare(b.name);
                }
                return a.type === 'folder' ? -1 : 1;
            });

            return files;
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error);
            return [];
        }
    }

    /**
     * Add a specific file to context
     */
    private async addFileToContext(uri: string): Promise<void> {
        const session = await this._sessionManager.getActiveSession();
        if (!session || !uri || uri.trim() === '') return;

        // Validate URI before adding
        try {
            const parsedUri = vscode.Uri.parse(uri);
            if (!parsedUri.fsPath || parsedUri.fsPath === '') {
                console.error(`Invalid file URI: ${uri}`);
                return;
            }
        } catch (error) {
            console.error(`Failed to parse URI: ${uri}`, error);
            return;
        }

        // Add file to explicit context if not already there
        if (!session.contextUris.includes(uri)) {
            const updatedUris = [...session.contextUris, uri];
            await this._sessionManager.updateSessionContext(session.id, updatedUris, 'custom');

            await this.updateContextDisplay();
            await this.updateContextBadge();
        }
    }

    private async initialize() {
        // Initialize session manager with context
        await this._sessionManager.initialize(this._context);

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

    public async reloadConfig(): Promise<void> {
        this._config = await ConfigLoader.loadConfig();

        if (this._config) {
            this._availableModels = ConfigLoader.getModels(this._config);
            this._currentModel = ConfigLoader.getDefaultModel(this._config);

            if (this._currentModel) {
                this._llmClient = new LLMClient(this._currentModel);
            }

            // Send message to webview to update the model dropdown
            this._view?.webview.postMessage({
                type: 'modelsUpdated',
                models: this._availableModels,
                currentModel: this._currentModel
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
        let session = await this._sessionManager.getActiveSession();

        if (!session) {
            // Create default session with empty explicit context
            // (implicit context from open files will be added separately)
            const contextUris: string[] = [];
            const name = 'Chat 1';
            session = await this._sessionManager.createSession(name, 'custom', contextUris);
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
        await this.updateSessionsUI();
        await this.updateContextBadge();
        await this.updateContextDisplay();  // Update context pills

        // Send session data including messages to webview for restoration
        const displayMessages = session.messages.filter(m => m.role !== 'system');

        this._view?.webview.postMessage({
            type: 'sessionLoaded',
            filename: 'CODELAB: AI LEARNING ASSISTANT',
            messages: displayMessages  // Send message history for restoration
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

        const session = await this._sessionManager.getActiveSession();
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
        await this._sessionManager.addMessage(session.id, userMessage);

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

            await this._sessionManager.addMessage(session.id, assistantMessage);

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
        const session = await this._sessionManager.getActiveSession();
        if (session) {
            await this._sessionManager.clearSession(session.id);
            await this.loadSession();
        }
        this._view?.webview.postMessage({
            type: 'chatCleared'
        });
    }

    private async openConfig() {
        // Open the visual model configuration UI
        vscode.commands.executeCommand('vslabsai.openModelConfig');
    }

    private async createNewSession() {
        // Create session with auto-generated name
        const name = `Chat ${this._sessionManager.getSessionCount() + 1}`;

        // Create session with current document as default context
        const contextUris = this._currentDocument ? [this._currentDocument.uri.toString()] : [];
        const session = await this._sessionManager.createSession(name, 'file', contextUris);

        // Update UI
        await this.updateSessionsUI();
        await this.updateContextBadge();

        // Reload session
        await this.loadSession();
    }

    private async switchSession(sessionId?: string) {
        // If no sessionId provided, show picker
        if (!sessionId) {
            const sessions = await this._sessionManager.getAllSessions();
            const activeSession = await this._sessionManager.getActiveSession();

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

        const session = await this._sessionManager.setActiveSession(sessionId);
        if (!session) {
            return;
        }

        // Update UI
        await this.updateSessionsUI();
        await this.updateContextBadge();

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

        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems;
            if (selected.length === 0) {
                quickPick.hide();
                return;
            }

            // Determine context type
            const hasFolder = selected.some(item => item.detail === 'folder');
            const contextType = hasFolder ? 'folder' : selected.length === 1 ? 'file' : 'custom';

            // Update active session context
            const activeSession = await this._sessionManager.getActiveSession();
            if (activeSession) {
                const uris = selected.map(item => item.description || '');
                await this._sessionManager.updateSessionContext(activeSession.id, uris, contextType);

                // Update UI without reloading the entire session
                await this.updateContextBadge();
                await this.updateContextDisplay();
            }

            quickPick.hide();
        });

        quickPick.show();
    }

    private async renameSession(sessionId: string) {
        const sessions = await this._sessionManager.getAllSessions();
        const session = sessions.find(s => s.id === sessionId);
        if (!session) return;

        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name for the chat session',
            placeHolder: 'e.g., "Tutorial Part 1"',
            value: session.name
        });

        if (newName && newName.trim()) {
            await this._sessionManager.renameSession(sessionId, newName.trim());
            await this.updateSessionsUI();
        }
    }

    private async renameSessionInline(sessionId: string, newName: string) {
        if (newName && newName.trim()) {
            await this._sessionManager.renameSession(sessionId, newName.trim());
            await this.updateSessionsUI();
        }
    }

    private async deleteSession(sessionId: string) {
        const deleted = await this._sessionManager.deleteSession(sessionId);
        if (deleted) {
            // Check if there are any sessions left
            const sessions = await this._sessionManager.getAllSessions();

            if (sessions.length === 0) {
                // Create a new default session if all were deleted
                await this.createNewSession();
            } else {
                // Just update UI and load the active session
                await this.updateSessionsUI();
                await this.loadSession();
            }
        }
    }

    private async clearAllSessions() {
        const answer = await vscode.window.showWarningMessage(
            'Delete all chat sessions? This action cannot be undone.',
            { modal: true },
            'Delete All'
        );

        if (answer === 'Delete All') {
            // Delete all sessions
            const sessions = await this._sessionManager.getAllSessions();
            for (const session of sessions) {
                await this._sessionManager.deleteSession(session.id);
            }

            // Create a fresh default session
            await this.createNewSession();

            vscode.window.showInformationMessage('All chat sessions have been cleared');
        }
    }

    /**
     * Remove a context item from the session
     */
    private async removeContextItem(uri: string, isImplicit: boolean): Promise<void> {
        const session = await this._sessionManager.getActiveSession();
        if (!session) return;

        // Handle removing the entire codebase context
        if (uri === 'workspace://entire-codebase') {
            await this._sessionManager.updateSessionContext(
                session.id,
                [],
                'custom'
            );
            await this.updateContextBadge();
            await this.updateContextDisplay();
            return;
        }

        if (isImplicit) {
            // For implicit context, we just remove it from tracking
            this._openDocuments.delete(uri);
            await this.updateImplicitContext();
        } else {
            // For explicit context, remove from session's context URIs
            const newContextUris = session.contextUris.filter(u => u !== uri);
            await this._sessionManager.updateSessionContext(
                session.id,
                newContextUris,
                newContextUris.length === 0 ? 'custom' : session.contextType
            );
            await this.updateContextBadge();
            await this.updateContextDisplay();
        }
    }

    private async updateSessionsUI() {
        const sessions = await this._sessionManager.getAllSessions();
        const activeSession = await this._sessionManager.getActiveSession();

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

    private async updateContextBadge() {
        const activeSession = await this._sessionManager.getActiveSession();
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
        const activeSession = await this._sessionManager.getActiveSession();
        if (!activeSession) {
            return;
        }

        const contextItems: ContextItem[] = [];

        // Check if entire codebase/workspace is added
        if (activeSession.contextType === 'workspace') {
            contextItems.push({
                type: 'codebase' as any,
                uri: 'workspace://entire-codebase',
                name: 'Entire Codebase',
                icon: 'codicon-repo',
                isImplicit: false
            });
        }

        // Add explicit context items
        for (const uriStr of activeSession.contextUris) {
            // Skip empty or invalid URIs
            if (!uriStr || uriStr.trim() === '') {
                continue;
            }

            try {
                const uri = vscode.Uri.parse(uriStr);
                // Use path.basename for cross-platform compatibility
                let name = path.basename(uri.fsPath);

                // If basename returns empty, try to get more context
                if (!name || name === '') {
                    // Try to get the last two path segments for better context
                    const segments = uri.fsPath.split(path.sep).filter(s => s);
                    if (segments.length > 1) {
                        name = segments.slice(-2).join('/');
                    } else if (segments.length === 1) {
                        name = segments[0];
                    } else {
                        // Skip this invalid entry
                        continue;
                    }
                }

                // Skip displaying "input" as a context pill - it's likely a special context
                // that shouldn't be shown in the UI
                if (name === 'input') {
                    continue;
                }

                const ext = path.extname(name).slice(1).toLowerCase() || '';

                contextItems.push({
                    type: 'file',
                    uri: uriStr,
                    name,
                    icon: this.getFileIcon(ext),
                    isImplicit: false
                });
            } catch (error) {
                // Skip invalid URIs
                console.error(`Invalid URI in context: ${uriStr}`, error);
                continue;
            }
        }

        // Add implicit context items (open files)
        if (activeSession.implicitContextUris) {
            for (const uriStr of activeSession.implicitContextUris) {
                // Skip if already in explicit context or invalid
                if (activeSession.contextUris.includes(uriStr) || !uriStr || uriStr.trim() === '') {
                    continue;
                }

                try {
                    const uri = vscode.Uri.parse(uriStr);
                    // Use path.basename for cross-platform compatibility
                    const name = path.basename(uri.fsPath);

                    // Skip if no valid name
                    if (!name || name === '') {
                        continue;
                    }

                    const ext = path.extname(name).slice(1).toLowerCase() || '';

                    contextItems.push({
                        type: 'file',
                        uri: uriStr,
                        name,
                        icon: this.getFileIcon(ext),
                        isImplicit: true
                    });
                } catch (error) {
                    // Skip invalid URIs
                    console.error(`Invalid implicit URI in context: ${uriStr}`, error);
                    continue;
                }
            }
        }

        // Send context items to webview
        this._view?.webview.postMessage({
            type: 'contextItemsUpdated',
            contextItems
        });
    }

    /**
     * Load local library script content
     */
    private getLocalLibraryScript(libName: string): string {
        try {
            if (libName === 'marked') {
                // Use the minified version of marked
                const extensionPath = this._extensionUri.fsPath;
                const scriptPath = path.join(extensionPath, 'node_modules', 'marked', 'marked.min.js');
                if (fs.existsSync(scriptPath)) {
                    return fs.readFileSync(scriptPath, 'utf8');
                }
            } else if (libName === 'highlight.js') {
                // Since highlight.js npm package doesn't include browser build,
                // we'll provide a minimal fallback for offline use
                return this.getHighlightJsFallback();
            }
            return '';
        } catch (error) {
            console.error(`Error loading local library ${libName}:`, error);
            return '';
        }
    }

    /**
     * Provide a minimal highlight.js fallback for offline use
     */
    private getHighlightJsFallback(): string {
        // This provides basic syntax highlighting functionality
        // without external dependencies for offline use
        return `
            // Minimal highlight.js fallback for offline use
            window.hljs = {
                highlightElement: function(element) {
                    // Basic syntax highlighting - just escape HTML
                    if (element.textContent) {
                        // Keep the content as-is but ensure it's properly escaped
                        element.innerHTML = element.textContent
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                    }
                },
                highlightAll: function() {
                    document.querySelectorAll('pre code').forEach(function(element) {
                        window.hljs.highlightElement(element);
                    });
                },
                getLanguage: function(lang) {
                    // Return true for any language to enable basic highlighting
                    return true;
                },
                highlight: function(code, lang) {
                    // Basic HTML escaping
                    return {
                        value: code
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                    };
                }
            };
        `;
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
        // Get the proper URI for the codicon font from bundled assets
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'fonts', 'codicon.ttf'));

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
            src: url('${codiconUri}') format('truetype');
        }

        .codicon {
            font-family: 'codicon' !important;
            font-weight: normal !important;
            font-style: normal !important;
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

        /* Icon codes - synced with @vscode/codicons v0.0.41 */
        .codicon-file:before { content: '\\ea7b' }
        .codicon-folder:before { content: '\\ea83' }
        .codicon-symbol-class:before { content: '\\eb5b' }
        .codicon-code:before { content: '\\eac4' }
        .codicon-terminal:before { content: '\\ea85' }
        .codicon-edit:before { content: '\\ea73' }
        .codicon-selection:before { content: '\\eb85' }
        .codicon-repo:before { content: '\\ea62' }
        .codicon-add:before { content: '\\ea60' }
        .codicon-close:before { content: '\\ea76' }
        .codicon-warning:before { content: '\\ea6c' }
        .codicon-trash:before { content: '\\ea81' }
        .codicon-gear:before { content: '\\eaf8' }
        .codicon-settings-gear:before { content: '\\eb51' }
        .codicon-attach:before { content: '\\ec34' }
        .codicon-link:before { content: '\\eb15' }
        .codicon-arrow-right:before { content: '\\ea9c' }
        .codicon-play-circle:before { content: '\\eba6' }
        .codicon-send:before { content: '\\ec0f' }
        .codicon-stop:before { content: '\\ea87' }
        .codicon-file-text:before { content: '\\ea7b' }
        .codicon-markdown:before { content: '\\eb1d' }
        .codicon-json:before { content: '\\eb0f' }
        .codicon-source-control:before { content: '\\ea68' }
        .codicon-database:before { content: '\\eace' }
        .codicon-tools:before { content: '\\eb6d' }
        .codicon-symbol-namespace:before { content: '\\ea8b' }

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
            overflow-y: visible;
            flex-shrink: 0;
            position: relative;
            z-index: 9999;
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

        .chat-tab-menu {
            margin-left: auto;
            opacity: 0;
            font-size: 14px;
            line-height: 1;
            padding: 0 4px;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .chat-tab:hover .chat-tab-menu {
            opacity: 0.7;
        }

        .chat-tab-menu:hover {
            opacity: 1 !important;
        }

        .tab-menu-dropdown {
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            display: none;
            z-index: 999999;
            min-width: 120px;
        }

        .tab-menu-dropdown.active {
            display: block;
        }

        .tab-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            color: var(--vscode-foreground);
            transition: background-color 0.1s;
        }

        .tab-menu-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .chat-tab-wrapper {
            position: relative;
            display: flex;
        }

        .chat-tab-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .chat-tab-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-focusBorder);
            border-radius: 3px;
            padding: 2px 4px;
            font-size: 12px;
            outline: none;
            min-width: 60px;
            max-width: 130px;
        }

        .chat-tab-input:focus {
            border-color: var(--vscode-focusBorder);
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

        .config-btn {
            padding: 4px 8px;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 16px;
            border-radius: 4px;
            opacity: 0.7;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 28px;
            margin-left: 4px;
        }

        .config-btn:hover {
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
            gap: 8px;
            padding: 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .message-footer-meta {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .message-footer-meta span {
            padding: 3px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            font-size: 10px;
            font-weight: 400;
            white-space: nowrap;
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
            background: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-button-border, transparent);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            padding: 3px 10px;
            border-radius: 4px;
            transition: all 0.2s;
            font-size: 10px;
            font-weight: 400;
            margin-left: auto;
            white-space: nowrap;
        }

        .copy-message-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
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
            gap: 6px;
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
            padding: 4px 8px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            font-weight: 400;
            cursor: default;
            transition: all 0.15s ease;
            max-width: 250px;
            opacity: 0.9;
        }

        .context-pill.implicit {
            opacity: 0.6;
            border-style: dashed;
        }

        .context-pill.codebase {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            border-color: var(--vscode-focusBorder);
            font-weight: 500;
        }

        .context-pill:hover {
            opacity: 1;
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .context-pill-icon {
            display: none; /* Hide icons for cleaner look */
        }

        .context-pill-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--vscode-font-family);
        }

        .context-pill-remove {
            margin-left: 4px;
            opacity: 0.5;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            flex-shrink: 0;
            transition: opacity 0.15s ease;
        }

        .context-pill-remove:hover {
            opacity: 1;
            color: var(--vscode-errorForeground);
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
        .input-top-bar {
            position: relative;
        }

        /* Context Menu Modal - Centered like VS Code Quick Open */
        .context-menu-backdrop {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.4);
            z-index: 999999;
            align-items: flex-start;
            justify-content: center;
            padding-top: 15vh;
        }

        .context-menu-backdrop.active {
            display: flex;
        }

        .context-menu {
            width: 500px;
            max-width: 90vw;
            background-color: var(--vscode-quickInput-background);
            border: 1px solid var(--vscode-quickInput-border, var(--vscode-widget-border));
            border-radius: 8px;
            max-height: 60vh;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            display: flex;
            flex-direction: column;
            animation: modalSlideIn 0.15s ease-out;
        }

        @keyframes modalSlideIn {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .context-menu-search {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
            flex-shrink: 0;
        }

        .context-menu-search input {
            width: 100%;
            padding: 8px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
            outline: none;
        }

        .context-menu-search input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .context-menu-content {
            overflow-y: auto;
            flex: 1;
            min-height: 0;
        }

        .context-menu-section {
            padding: 4px 0;
        }

        .context-menu-item {
            padding: 8px 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
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

        /* File Browser View Styles */
        .file-browser-view {
            display: none;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }

        .file-browser-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .file-browser-back {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.15s;
        }

        .file-browser-back:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .file-browser-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .file-browser-search {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .file-browser-search input {
            width: 100%;
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
            outline: none;
        }

        .file-browser-search input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .file-browser-tree {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
            min-height: 0;
        }

        .file-tree-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 13px;
            user-select: none;
            transition: background-color 0.1s;
        }

        .file-tree-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .file-tree-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .file-tree-item .codicon {
            flex-shrink: 0;
        }

        .file-tree-item.folder {
            font-weight: 500;
        }

        .file-tree-item.folder > .codicon-chevron-right {
            transition: transform 0.2s;
        }

        .file-tree-item.folder.expanded > .codicon-chevron-right {
            transform: rotate(90deg);
        }

        .file-tree-children {
            padding-left: 20px;
            display: none;
        }

        .file-tree-children.expanded {
            display: block;
        }

        .file-browser-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding: 12px 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .btn-primary, .btn-secondary {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            font-weight: 500;
            transition: background-color 0.15s;
        }

        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .file-tree-checkbox {
            width: 16px;
            height: 16px;
            margin-right: 4px;
        }

        /* Old bottom controls - hidden since model selector is now inline */
        .bottom-controls,
        .model-selector-bottom,
        .model-select-bottom {
            display: none !important;
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
            padding: 4px 8px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-weight: 400;
            transition: all 0.15s ease;
            border-radius: 4px;
            opacity: 0.9;
        }

        .add-context-btn:hover {
            opacity: 1;
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .add-context-btn .codicon {
            font-size: 12px;
        }

        .input-text-area {
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .input-bottom-controls {
            display: flex;
            gap: 8px;
            align-items: center;
            justify-content: flex-end;
            padding: 0;
        }

        .model-select-inline {
            padding: 4px 8px;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            outline: none;
            min-width: 120px;
            max-width: 200px;
        }

        .model-select-inline:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .model-select-inline:focus {
            border-color: var(--vscode-focusBorder);
        }

        .config-btn-inline {
            padding: 4px;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 16px;
            font-family: 'codicon';
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: opacity 0.2s;
            width: 24px;
            height: 24px;
        }

        .config-btn-inline .codicon {
            font-family: 'codicon' !important;
            font-size: 16px;
        }

        .config-btn-inline:hover {
            opacity: 1;
            color: var(--vscode-focusBorder);
        }

        textarea {
            width: 100%;
            padding: 0;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            outline: none;
            min-height: 48px;
            max-height: 120px;
            line-height: 1.5;
        }

        textarea:focus {
            outline: none;
        }

        button.send-btn {
            padding: 4px;
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            font-family: 'codicon';
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: opacity 0.2s;
            width: 24px;
            height: 24px;
        }

        button.send-btn:hover {
            opacity: 1;
        }

        button.send-btn .codicon {
            font-family: 'codicon' !important;
            font-size: 16px;
        }

        button.stop-btn {
            padding: 6px;
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            width: 32px;
            height: 32px;
        }

        button.stop-btn {
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }

        button.stop-btn:hover {
            background-color: var(--vscode-inputValidation-errorBorder);
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
    <script>${this.getLocalLibraryScript('marked')}</script>
    <script>${this.getLocalLibraryScript('highlight.js')}</script>
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
        <button class="new-chat-btn" id="newChatBtn" title="New Chat">+</button>
    </div>

    <!-- Header with settings -->
    <div class="header" style="display: none;">
        <div class="header-title">
            <span id="headerText">AI Assistant</span>
        </div>
        <div class="header-actions">
            <button class="icon-btn" id="clearBtn" title="Clear Chat"><span class="codicon codicon-trash"></span></button>
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
        <!-- Hash Autocomplete Dropdown -->
        <div class="hash-autocomplete" id="hashAutocomplete">
            <!-- Options will be added dynamically -->
        </div>

        <!-- Context Menu Modal - Centered and Decoupled -->
        <div class="context-menu-backdrop" id="contextMenuBackdrop">
            <div class="context-menu" id="contextMenu">
                <div class="context-menu-search">
                    <input type="text" id="contextSearchInput" placeholder="Search files and context..." />
                </div>
                <div class="context-menu-content">
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
                <div class="file-browser-view" id="fileBrowserView" style="display: none;">
                    <div class="file-browser-header">
                        <button class="file-browser-back" id="fileBrowserBack">
                            <span class="codicon codicon-arrow-left"></span>
                            Back
                        </button>
                        <div class="file-browser-title">Select Files & Folders</div>
                    </div>
                    <div class="file-browser-search">
                        <input type="text" id="fileBrowserSearch" placeholder="Search files..." />
                    </div>
                    <div class="file-browser-tree" id="fileBrowserTree">
                        <!-- File tree will be populated here -->
                    </div>
                    <div class="file-browser-footer">
                        <button class="btn-secondary" id="fileBrowserCancel">Cancel</button>
                        <button class="btn-primary" id="fileBrowserConfirm">Add Selected</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Input Wrapper with Add Context -->
        <div class="input-wrapper">
            <div class="input-top-bar">
                <button class="add-context-btn" id="addContextBtn">
                    <span class="codicon codicon-link"></span>
                    <span>Add Context</span>
                </button>
            </div>
            <div class="input-text-area">
                <textarea
                    id="messageInput"
                    placeholder="Ask a question... (type # for context)"
                    rows="2"
                ></textarea>
                <div class="input-bottom-controls">
                    <select id="modelSelect" class="model-select-inline" title="Select Model">
                        <option value="">Loading...</option>
                    </select>
                    <button class="config-btn-inline" id="configBtn" title="Model Configuration">
                        <span class="codicon codicon-gear"></span>
                    </button>
                    <button class="send-btn" id="sendBtn" title="Send Message">
                        <span class="codicon codicon-play-circle"></span>
                    </button>
                    <button class="stop-btn hidden" id="stopBtn" title="Stop generation">
                        <span class="codicon codicon-stop"></span>
                    </button>
                </div>
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
        const modelSelect = document.getElementById('modelSelect');
        const contextPills = document.getElementById('contextPills');
        const hashAutocomplete = document.getElementById('hashAutocomplete');
        const chatTabs = document.getElementById('chatTabs');
        const newChatBtn = document.getElementById('newChatBtn');
        const addContextBtn = document.getElementById('addContextBtn');
        const contextMenuBackdrop = document.getElementById('contextMenuBackdrop');
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

        // Function to start inline rename
        function startInlineRename(sessionId, nameSpan) {
            // Don't start rename if already in edit mode
            if (nameSpan.querySelector('.chat-tab-input')) {
                return;
            }

            const currentName = nameSpan.textContent;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'chat-tab-input';
            input.value = currentName;

            // Replace the text with the input
            nameSpan.textContent = '';
            nameSpan.appendChild(input);

            // Focus and select all text
            input.focus();
            input.select();

            // Handle blur (clicking away)
            const finishRename = () => {
                const newName = input.value.trim();
                if (newName && newName !== currentName) {
                    vscode.postMessage({
                        type: 'renameSessionInline',
                        sessionId: sessionId,
                        newName: newName
                    });
                    nameSpan.textContent = newName;
                } else {
                    nameSpan.textContent = currentName;
                }
            };

            input.addEventListener('blur', finishRename);

            // Handle Enter key
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    nameSpan.textContent = currentName;
                }
            });

            // Stop clicks on input from bubbling to tab
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        // Function to show tab menu
        function showTabMenu(sessionId, menuBtn) {
            // Remove any existing menu
            const existingMenu = document.querySelector('.tab-menu-dropdown');
            if (existingMenu) {
                existingMenu.remove();
            }

            // Create dropdown menu
            const dropdown = document.createElement('div');
            dropdown.className = 'tab-menu-dropdown active';

            // Rename option
            const renameItem = document.createElement('div');
            renameItem.className = 'tab-menu-item';
            renameItem.textContent = 'Rename';
            renameItem.onclick = () => {
                dropdown.remove();
                // Find the tab and start inline rename
                const tab = document.querySelector(\`.chat-tab[data-session-id="\${sessionId}"]\`);
                if (tab) {
                    const nameSpan = tab.querySelector('.chat-tab-name');
                    if (nameSpan) {
                        startInlineRename(sessionId, nameSpan);
                    }
                }
            };
            dropdown.appendChild(renameItem);

            // Delete option (always available now)
            const deleteItem = document.createElement('div');
            deleteItem.className = 'tab-menu-item';
            deleteItem.textContent = 'Delete';
            deleteItem.onclick = () => {
                dropdown.remove();
                showDeleteConfirmation(sessionId);
            };
            dropdown.appendChild(deleteItem);

            // Position the dropdown relative to the menu button
            // Append to body to avoid clipping issues
            document.body.appendChild(dropdown);

            // Calculate position - show to the right of the kebab menu
            const rect = menuBtn.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.top = rect.top + 'px';
            dropdown.style.left = (rect.right + 4) + 'px';
            dropdown.style.right = 'auto';

            // Close menu when clicking elsewhere
            setTimeout(() => {
                document.addEventListener('click', function closeMenu(e) {
                    if (!dropdown.contains(e.target)) {
                        dropdown.remove();
                        document.removeEventListener('click', closeMenu);
                    }
                });
            }, 0);
        }

        // Function to update chat tabs
        function updateChatTabs(sessions, activeSessionId) {
            if (!chatTabs) return;

            // Clear existing tabs (except the new chat button)
            const existingTabs = chatTabs.querySelectorAll('.chat-tab-wrapper');
            existingTabs.forEach(tab => tab.remove());

            // Add tabs for each session
            sessions.forEach((session, index) => {
                const wrapper = document.createElement('div');
                wrapper.className = 'chat-tab-wrapper';

                const tab = document.createElement('div');
                tab.className = 'chat-tab' + (session.id === activeSessionId ? ' active' : '');
                tab.dataset.sessionId = session.id;

                const nameSpan = document.createElement('span');
                nameSpan.className = 'chat-tab-name';
                nameSpan.textContent = session.name || \`Chat \${index + 1}\`;

                // Double-click to rename
                nameSpan.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    startInlineRename(session.id, nameSpan);
                });

                tab.appendChild(nameSpan);

                // Add three-dot menu
                const menuBtn = document.createElement('span');
                menuBtn.className = 'chat-tab-menu';
                menuBtn.innerHTML = '⋮';
                menuBtn.onclick = (e) => {
                    e.stopPropagation();
                    showTabMenu(session.id, menuBtn);
                };
                tab.appendChild(menuBtn);

                // Removed close button - delete is now in kebab menu only

                // Click handler to switch sessions
                tab.onclick = () => {
                    if (session.id !== activeSessionId) {
                        vscode.postMessage({ type: 'switchSession', sessionId: session.id });
                    }
                };

                wrapper.appendChild(tab);
                // Insert before the new chat button
                chatTabs.insertBefore(wrapper, newChatBtn);
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
                let pillClass = 'context-pill';
                if (item.isImplicit) {
                    pillClass += ' implicit';
                }
                if (item.type === 'codebase') {
                    pillClass += ' codebase';
                }
                pill.className = pillClass;
                pill.title = item.type === 'codebase' ? 'Entire codebase context' :
                            (item.isImplicit ? 'Open file (automatically added)' : 'Explicit context');

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

        // New chat button - show menu on click
        newChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNewChatMenu();
        });

        function showNewChatMenu() {
            // Remove any existing menu
            const existingMenu = document.querySelector('.new-chat-menu');
            if (existingMenu) {
                existingMenu.remove();
                return; // Toggle off if already open
            }

            // Create dropdown menu
            const dropdown = document.createElement('div');
            dropdown.className = 'tab-menu-dropdown new-chat-menu active';

            // New Chat option
            const newChatItem = document.createElement('div');
            newChatItem.className = 'tab-menu-item';
            newChatItem.textContent = 'New Chat';
            newChatItem.onclick = () => {
                dropdown.remove();
                vscode.postMessage({ type: 'newSession' });
            };
            dropdown.appendChild(newChatItem);

            // Clear All Chats option
            const clearAllItem = document.createElement('div');
            clearAllItem.className = 'tab-menu-item';
            clearAllItem.style.color = 'var(--vscode-errorForeground)';
            clearAllItem.textContent = 'Clear All Chats...';
            clearAllItem.onclick = () => {
                dropdown.remove();
                vscode.postMessage({ type: 'clearAllSessions' });
            };
            dropdown.appendChild(clearAllItem);

            // Position the dropdown
            document.body.appendChild(dropdown);
            const rect = newChatBtn.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = rect.left + 'px';

            // Close on click outside
            setTimeout(() => {
                document.addEventListener('click', function closeMenu(e) {
                    if (!dropdown.contains(e.target)) {
                        dropdown.remove();
                        document.removeEventListener('click', closeMenu);
                    }
                });
            }, 0);
        }

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
        if (addContextBtn) {
            addContextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleContextMenu();
            });
        }

        // Close context menu when clicking on backdrop
        if (contextMenuBackdrop) {
            contextMenuBackdrop.addEventListener('click', (e) => {
                // Only close if clicking the backdrop itself, not the menu
                if (e.target === contextMenuBackdrop) {
                    hideContextMenu();
                }
            });
        }

        // Handle context menu item clicks
        if (contextMenu) {
            contextMenu.addEventListener('click', (e) => {
                const item = e.target.closest('.context-menu-item');
                if (item) {
                    const type = item.dataset.type;
                    handleContextMenuSelection(type);
                }
            });
        }

        // ESC key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && contextMenuBackdrop && contextMenuBackdrop.classList.contains('active')) {
                hideContextMenu();
            }
        });

        // Handle context menu search
        if (contextSearchInput) {
            contextSearchInput.addEventListener('input', (e) => {
                filterContextMenu(e.target.value);
            });
        }

        function toggleContextMenu() {
            if (!contextMenuBackdrop) return;
            if (contextMenuBackdrop.classList.contains('active')) {
                hideContextMenu();
            } else {
                showContextMenu();
            }
        }

        function showContextMenu() {
            if (!contextMenuBackdrop) return;
            contextMenuBackdrop.classList.add('active');
            if (contextSearchInput) {
                // Focus input after animation starts
                setTimeout(() => contextSearchInput.focus(), 50);
            }
            updateRecentFiles();
        }

        function hideContextMenu() {
            if (!contextMenuBackdrop) return;
            contextMenuBackdrop.classList.remove('active');
            if (contextSearchInput) {
                contextSearchInput.value = '';
            }
        }

        let selectedFiles = new Set();

        function showFileBrowser() {
            const mainView = document.getElementById('contextMenu').querySelector('.context-menu-content');
            const fileBrowserView = document.getElementById('fileBrowserView');
            if (mainView) mainView.style.display = 'none';
            if (fileBrowserView) fileBrowserView.style.display = 'flex';

            // Request file tree from extension
            vscode.postMessage({ type: 'getWorkspaceFiles' });
        }

        function hideFileBrowser() {
            const mainView = document.getElementById('contextMenu').querySelector('.context-menu-content');
            const fileBrowserView = document.getElementById('fileBrowserView');
            if (mainView) mainView.style.display = 'block';
            if (fileBrowserView) fileBrowserView.style.display = 'none';
            selectedFiles.clear();
        }

        function renderFileTree(files) {
            const tree = document.getElementById('fileBrowserTree');
            if (!tree) return;

            tree.innerHTML = '';

            if (!files || files.length === 0) {
                tree.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No files found in workspace</div>';
                return;
            }

            files.forEach(file => {
                const item = createFileTreeItem(file, 0);
                tree.appendChild(item);
            });
        }

        function createFileTreeItem(file, level) {
            const container = document.createElement('div');

            const item = document.createElement('div');
            item.className = 'file-tree-item';
            item.style.paddingLeft = (level * 16 + 8) + 'px';

            if (file.type === 'folder') {
                item.classList.add('folder');

                // Chevron for folders
                const chevron = document.createElement('span');
                chevron.className = 'codicon codicon-chevron-right';
                item.appendChild(chevron);

                // Folder icon
                const icon = document.createElement('span');
                icon.className = 'codicon codicon-folder';
                item.appendChild(icon);

                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'file-tree-checkbox';
                checkbox.dataset.uri = file.uri;
                checkbox.dataset.type = 'folder';
                item.appendChild(checkbox);

                // Folder name
                const name = document.createElement('span');
                name.textContent = file.name;
                item.appendChild(name);

                // Toggle folder on click
                item.addEventListener('click', (e) => {
                    if (e.target === checkbox) return; // Don't toggle on checkbox click

                    item.classList.toggle('expanded');
                    const children = container.querySelector('.file-tree-children');
                    if (children) {
                        children.classList.toggle('expanded');
                    }
                });

                // Handle checkbox
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (checkbox.checked) {
                        selectedFiles.add(file.uri);
                        // Select all children
                        const children = container.querySelectorAll('.file-tree-checkbox');
                        children.forEach(child => {
                            child.checked = true;
                            selectedFiles.add(child.dataset.uri);
                        });
                    } else {
                        selectedFiles.delete(file.uri);
                        // Deselect all children
                        const children = container.querySelectorAll('.file-tree-checkbox');
                        children.forEach(child => {
                            child.checked = false;
                            selectedFiles.delete(child.dataset.uri);
                        });
                    }
                    updateFileBrowserSelection();
                });

                container.appendChild(item);

                // Add children
                if (file.children && file.children.length > 0) {
                    const childrenContainer = document.createElement('div');
                    childrenContainer.className = 'file-tree-children';

                    file.children.forEach(child => {
                        const childItem = createFileTreeItem(child, level + 1);
                        childrenContainer.appendChild(childItem);
                    });

                    container.appendChild(childrenContainer);
                }
            } else {
                // File icon
                const icon = document.createElement('span');
                icon.className = 'codicon codicon-file';
                item.appendChild(icon);

                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'file-tree-checkbox';
                checkbox.dataset.uri = file.uri;
                checkbox.dataset.type = 'file';
                item.appendChild(checkbox);

                // File name
                const name = document.createElement('span');
                name.textContent = file.name;
                item.appendChild(name);

                // Handle checkbox
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (checkbox.checked) {
                        selectedFiles.add(file.uri);
                    } else {
                        selectedFiles.delete(file.uri);
                    }
                    updateFileBrowserSelection();
                });

                container.appendChild(item);
            }

            return container;
        }

        function updateFileBrowserSelection() {
            const confirmBtn = document.getElementById('fileBrowserConfirm');
            if (confirmBtn) {
                confirmBtn.textContent = selectedFiles.size > 0
                    ? 'Add Selected (' + selectedFiles.size + ')'
                    : 'Add Selected';
                confirmBtn.disabled = selectedFiles.size === 0;
            }
        }

        function handleContextMenuSelection(type) {
            switch(type) {
                case 'open-editors':
                    vscode.postMessage({ type: 'addOpenEditors' });
                    hideContextMenu();
                    break;
                case 'files':
                    showFileBrowser();
                    // Don't hide context menu, just switch views
                    break;
                case 'codebase':
                    vscode.postMessage({ type: 'addCodebase' });
                    hideContextMenu();
                    break;
                case 'symbols':
                    vscode.postMessage({ type: 'selectSymbols' });
                    hideContextMenu();
                    break;
                default:
                    if (type && type.startsWith('file:')) {
                        const uri = type.substring(5);
                        vscode.postMessage({ type: 'addFile', uri });
                    }
                    hideContextMenu();
            }
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

        // File browser event listeners
        const fileBrowserBack = document.getElementById('fileBrowserBack');
        const fileBrowserCancel = document.getElementById('fileBrowserCancel');
        const fileBrowserConfirm = document.getElementById('fileBrowserConfirm');
        const fileBrowserSearch = document.getElementById('fileBrowserSearch');

        if (fileBrowserBack) {
            fileBrowserBack.addEventListener('click', hideFileBrowser);
        }

        if (fileBrowserCancel) {
            fileBrowserCancel.addEventListener('click', () => {
                hideFileBrowser();
                hideContextMenu();
            });
        }

        if (fileBrowserConfirm) {
            fileBrowserConfirm.addEventListener('click', () => {
                if (selectedFiles.size > 0) {
                    vscode.postMessage({
                        type: 'addFiles',
                        uris: Array.from(selectedFiles)
                    });
                    hideFileBrowser();
                    hideContextMenu();
                }
            });
        }

        if (fileBrowserSearch) {
            fileBrowserSearch.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase();
                const items = document.querySelectorAll('.file-tree-item');
                items.forEach(item => {
                    const text = item.textContent.toLowerCase();
                    const container = item.parentElement;
                    if (text.includes(searchTerm)) {
                        container.style.display = 'block';
                    } else {
                        container.style.display = 'none';
                    }
                });
            });
        }


        function sendMessage() {
            const content = messageInput.value.trim();
            if (!content) return;

            // Check if we have context by checking both the flag and the actual context items array
            if (!hasContext && contextItems.length === 0) {
                // Show inline error instead of alert (sandboxed environment)
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error-message';
                errorDiv.textContent = 'Please select context first by typing # or clicking "Add Context" below.';
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
                            \${modelName ? \`<span>\${modelName}</span>\` : ''}
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
                    // Restore message history from session
                    if (message.messages && message.messages.length > 0) {
                        message.messages.forEach(msg => {
                            if (msg.role !== 'system') {
                                addMessage(msg.role, msg.content);
                            }
                        });
                    }
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
                    if (message.models && message.models.length > 0) {
                        modelSelect.innerHTML = message.models.map(m =>
                            \`<option value="\${m.name}" \${m.name === message.currentModel ? 'selected' : ''}>\${m.name}</option>\`
                        ).join('');
                        currentModelName = message.currentModel || message.models[0].name;
                        // Find and store the current model config with pricing
                        currentModelConfig = message.models.find(m => m.name === currentModelName) || message.models[0];

                        // Show/hide the model selector based on number of models
                        if (message.models.length === 1) {
                            modelSelect.style.display = 'none';
                        } else {
                            modelSelect.style.display = '';
                        }
                    } else {
                        currentModelName = 'Claude';
                        currentModelConfig = null;
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

                case 'modelsUpdated':
                    // Config was reloaded - update model dropdown
                    if (message.models && message.models.length > 0) {
                        modelSelect.innerHTML = message.models.map(m =>
                            \`<option value="\${m.name}" \${m.name === (message.currentModel?.name || message.models[0].name) ? 'selected' : ''}>\${m.name}</option>\`
                        ).join('');
                        currentModelName = message.currentModel?.name || message.models[0].name;
                        currentModelConfig = message.currentModel || message.models[0];

                        // Show/hide the model selector based on number of models
                        if (message.models.length === 1) {
                            modelSelect.style.display = 'none';
                        } else {
                            modelSelect.style.display = '';
                        }
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

                case 'workspaceFiles':
                    renderFileTree(message.files);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
