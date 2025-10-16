import * as vscode from 'vscode';
import { CommandParser, MDCLCommand } from './commandParser';
import { CommandExecutor } from './commandExecutor';
import { MDCLCodeLensProvider } from './codeLensProvider';
import { MDCLPreviewPanel } from './previewPanel';
import { ChatPanel } from './chat/chatPanel';
import { ChatViewProvider } from './chat/chatViewProvider';

let commandExecutor: CommandExecutor;

export async function activate(context: vscode.ExtensionContext) {
    console.log('🚀 VSLabsAI extension is now active!');
    console.log('Extension context:', {
        extensionPath: context.extensionPath,
        globalState: !!context.globalState,
        workspaceState: !!context.workspaceState
    });
    console.log('VS Code version:', vscode.version);

    // Check if this is first time activation or if user mode is not set
    const config = vscode.workspace.getConfiguration('mdcl');
    const hasSeenModePrompt = context.globalState.get<boolean>('hasSeenModePrompt', false);

    if (!hasSeenModePrompt) {
        // Show user mode selection prompt
        const selection = await vscode.window.showInformationMessage(
            'Welcome to VSLabsAI! Are you a student learning or a training creator?',
            { modal: true, detail: 'Student Mode: View tutorials in preview-only mode\nCreator Mode: Edit and preview tutorials side-by-side' },
            'I am a Student',
            'I am a Training Creator'
        );

        // Set the user mode based on selection (default to student if cancelled)
        const userMode = selection === 'I am a Training Creator' ? 'creator' : 'student';
        await config.update('userMode', userMode, vscode.ConfigurationTarget.Global);
        await context.globalState.update('hasSeenModePrompt', true);

        // Show confirmation message
        const modeLabel = userMode === 'student' ? 'Student' : 'Training Creator';
        vscode.window.showInformationMessage(`VSLabsAI: ${modeLabel} Mode activated! You can change this in settings.`);
    } else {
        // Show activation message
        const userMode = config.get<string>('userMode', 'student');
        const modeLabel = userMode === 'student' ? 'Student' : 'Training Creator';
        vscode.window.showInformationMessage(`VSLabsAI: ${modeLabel} Mode active`);
    }

    // Log all currently open documents
    vscode.workspace.textDocuments.forEach(doc => {
        console.log('📄 Open document:', doc.uri.toString(), 'Language:', doc.languageId);
    });

    commandExecutor = new CommandExecutor(context);
    console.log('✅ CommandExecutor initialized');

    // Register chat sidebar view
    const chatViewProvider = new ChatViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatViewProvider
        )
    );
    console.log('✅ Chat sidebar view registered');

    const codeLensProvider = new MDCLCodeLensProvider();
    console.log('✅ MDCLCodeLensProvider created');

    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { language: 'mdcl', scheme: 'file' },
        codeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);
    console.log('✅ CodeLens provider registered for mdcl language');

    // Force refresh code lenses for any already open MDCL files
    setTimeout(() => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            console.log('🔄 Forcing code lens refresh for active MDCL file');
            codeLensProvider.refresh();
        }
    }, 100);

    const openPreviewCommand = vscode.commands.registerCommand('mdcl.openPreview', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            MDCLPreviewPanel.createOrShow(
                context.extensionUri,
                activeEditor.document,
                commandExecutor
            );
        } else {
            vscode.window.showInformationMessage('Please open an MDCL file to preview it.');
        }
    });
    context.subscriptions.push(openPreviewCommand);

    const openAsPreviewCommand = vscode.commands.registerCommand('mdcl.openAsPreview', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            MDCLPreviewPanel.createOrShow(
                context.extensionUri,
                activeEditor.document,
                commandExecutor
            );
        } else {
            vscode.window.showInformationMessage('Please open an MDCL file to preview it.');
        }
    });
    context.subscriptions.push(openAsPreviewCommand);

    const executeCommand = vscode.commands.registerCommand(
        'mdcl.executeCommand',
        async (command: MDCLCommand, documentUri?: vscode.Uri) => {
            await commandExecutor.execute(command, documentUri);
        }
    );
    context.subscriptions.push(executeCommand);

    const copyCommand = vscode.commands.registerCommand(
        'mdcl.copyCommand',
        async (command: MDCLCommand, documentUri?: vscode.Uri) => {
            await commandExecutor.execute(command, documentUri);
        }
    );
    context.subscriptions.push(copyCommand);

    const openFileCommand = vscode.commands.registerCommand(
        'mdcl.openFile',
        async (command: MDCLCommand, documentUri?: vscode.Uri) => {
            await commandExecutor.execute(command, documentUri);
        }
    );
    context.subscriptions.push(openFileCommand);

    // Add refresh code lenses command
    const refreshCodeLensCommand = vscode.commands.registerCommand(
        'mdcl.refreshCodeLens',
        () => {
            console.log('🔄 Manual code lens refresh triggered');
            codeLensProvider.refresh();
        }
    );
    context.subscriptions.push(refreshCodeLensCommand);

    // Add chat command
    const openChatCommand = vscode.commands.registerCommand('mdcl.openChat', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            ChatPanel.createOrShow(
                context.extensionUri,
                activeEditor.document
            );
        } else {
            vscode.window.showInformationMessage('Please open an MDCL file to use chat.');
        }
    });
    context.subscriptions.push(openChatCommand);

    // Add toggle user mode command
    const toggleUserModeCommand = vscode.commands.registerCommand('mdcl.toggleUserMode', async () => {
        const config = vscode.workspace.getConfiguration('mdcl');
        const currentMode = config.get<string>('userMode', 'student');
        const newMode = currentMode === 'student' ? 'creator' : 'student';

        await config.update('userMode', newMode, vscode.ConfigurationTarget.Global);

        const modeLabel = newMode === 'student' ? 'Student' : 'Training Creator';
        vscode.window.showInformationMessage(`Switched to ${modeLabel} Mode. Reopen MDCL files to apply changes.`);

        // If preview panel is open, dispose it so it will recreate with new settings
        if (MDCLPreviewPanel.currentPanel) {
            MDCLPreviewPanel.currentPanel.dispose();
        }
    });
    context.subscriptions.push(toggleUserModeCommand);

    // Auto-open preview for MDCL files when they're first opened
    vscode.workspace.onDidOpenTextDocument(async (document) => {
        console.log('📄 Document opened:', document.uri.toString(), 'Language:', document.languageId);

        const config = vscode.workspace.getConfiguration('mdcl');
        const autoPreview = config.get<boolean>('autoOpenPreview', true);
        const userMode = config.get<string>('userMode', 'student');

        if (autoPreview && document.languageId === 'mdcl' && !document.isUntitled) {
            // Small delay to let the editor become active
            setTimeout(async () => {
                const editor = vscode.window.activeTextEditor;
                // Only create preview if this document is now the active editor
                // AND we don't already have a preview panel
                if (editor &&
                    editor.document.uri.toString() === document.uri.toString() &&
                    !MDCLPreviewPanel.currentPanel) {
                    console.log('🎭 Creating preview for newly opened MDCL file');

                    if (userMode === 'student') {
                        // Student mode: Show preview only and hide source
                        // Store the document URI before creating preview
                        const documentUri = editor.document.uri;

                        MDCLPreviewPanel.createOrShow(
                            context.extensionUri,
                            editor.document,
                            commandExecutor
                        );

                        // Close the source editor after preview is shown
                        // Find and close the text editor for this document
                        for (const visibleEditor of vscode.window.visibleTextEditors) {
                            if (visibleEditor.document.uri.toString() === documentUri.toString()) {
                                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                                break;
                            }
                        }
                    } else {
                        // Creator mode: Show both source and preview
                        MDCLPreviewPanel.createOrShow(
                            context.extensionUri,
                            editor.document,
                            commandExecutor
                        );
                    }
                }
            }, 100);
        }
    });

    // Handle preview creation/update when switching to MDCL files
    // This is the ONLY place where auto-preview happens to avoid duplicates
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        console.log('👁️ Active editor changed:', editor ? editor.document.uri.toString() : 'none');

        if (editor && editor.document.languageId === 'mdcl') {
            const config = vscode.workspace.getConfiguration('mdcl');
            const autoPreview = config.get<boolean>('autoOpenPreview', true);
            const userMode = config.get<string>('userMode', 'student');
            console.log('🔄 MDCL file active, auto preview:', autoPreview, 'mode:', userMode);

            if (autoPreview) {
                if (userMode === 'student' && !MDCLPreviewPanel.currentPanel) {
                    // Student mode: Create preview and close source
                    // Only do this if preview doesn't exist yet
                    console.log('🎭 Creating preview panel (student mode)');
                    const documentUri = editor.document.uri;

                    MDCLPreviewPanel.createOrShow(
                        context.extensionUri,
                        editor.document,
                        commandExecutor
                    );

                    // Close the source editor after preview is shown
                    setTimeout(async () => {
                        for (const visibleEditor of vscode.window.visibleTextEditors) {
                            if (visibleEditor.document.uri.toString() === documentUri.toString()) {
                                // Close the group containing the source editor
                                await vscode.commands.executeCommand('workbench.action.closeEditorsInGroup');
                                break;
                            }
                        }
                    }, 300);
                } else {
                    // Creator mode: Show both
                    console.log('🎭 Creating or updating preview panel (creator mode)');
                    MDCLPreviewPanel.createOrShow(
                        context.extensionUri,
                        editor.document,
                        commandExecutor
                    );
                }
            }
        }
    });

    // Add text document change listener for code lens refresh
    vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'mdcl') {
            console.log('📝 MDCL document changed, refreshing code lenses');
            codeLensProvider.refresh();
        }
    });

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'mdcl.openPreview';
    statusBarItem.text = '$(open-preview) MDCL Preview';
    statusBarItem.tooltip = 'Open MDCL Preview';

    const updateStatusBarVisibility = () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'mdcl') {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    };

    updateStatusBarVisibility();
    vscode.window.onDidChangeActiveTextEditor(updateStatusBarVisibility);
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(commandExecutor);
}

export function deactivate() {
    if (MDCLPreviewPanel.currentPanel) {
        MDCLPreviewPanel.currentPanel.dispose();
    }
    if (ChatPanel.currentPanel) {
        ChatPanel.currentPanel.dispose();
    }
    if (commandExecutor) {
        commandExecutor.dispose();
    }
}