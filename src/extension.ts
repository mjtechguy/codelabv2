import * as vscode from 'vscode';
import { CommandParser, MDCLCommand } from './commandParser';
import { CommandExecutor } from './commandExecutor';
import { MDCLCodeLensProvider } from './codeLensProvider';
import { MDCLPreviewPanel } from './previewPanel';
import { ChatPanel } from './chat/chatPanel';
import { ChatViewProvider } from './chat/chatViewProvider';

let commandExecutor: CommandExecutor;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 VSLabsAI extension is now active!');
    console.log('Extension context:', {
        extensionPath: context.extensionPath,
        globalState: !!context.globalState,
        workspaceState: !!context.workspaceState
    });
    console.log('VS Code version:', vscode.version);

    // Show activation message
    vscode.window.showInformationMessage('VSLabsAI Extension Activated!');

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

    // Auto-open preview for MDCL files when they're first opened
    vscode.workspace.onDidOpenTextDocument(async (document) => {
        console.log('📄 Document opened:', document.uri.toString(), 'Language:', document.languageId);

        const config = vscode.workspace.getConfiguration('mdcl');
        const autoPreview = config.get<boolean>('autoOpenPreview', true);

        if (autoPreview && document.languageId === 'mdcl' && !document.isUntitled) {
            // Small delay to let the editor become active
            setTimeout(() => {
                const editor = vscode.window.activeTextEditor;
                // Only create preview if this document is now the active editor
                // AND we don't already have a preview panel
                if (editor &&
                    editor.document.uri.toString() === document.uri.toString() &&
                    !MDCLPreviewPanel.currentPanel) {
                    console.log('🎭 Creating preview for newly opened MDCL file');
                    MDCLPreviewPanel.createOrShow(
                        context.extensionUri,
                        editor.document,
                        commandExecutor
                    );
                }
            }, 100);
        }
    });

    // Handle preview creation/update when switching to MDCL files
    // This is the ONLY place where auto-preview happens to avoid duplicates
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        console.log('👁️ Active editor changed:', editor ? editor.document.uri.toString() : 'none');

        if (editor && editor.document.languageId === 'mdcl') {
            const config = vscode.workspace.getConfiguration('mdcl');
            const autoPreview = config.get<boolean>('autoOpenPreview', true);
            console.log('🔄 MDCL file active, auto preview:', autoPreview);

            if (autoPreview) {
                console.log('🎭 Creating or updating preview panel');
                MDCLPreviewPanel.createOrShow(
                    context.extensionUri,
                    editor.document,
                    commandExecutor
                );
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