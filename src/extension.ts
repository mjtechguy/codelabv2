import * as vscode from 'vscode';
import { CommandParser, MDCLCommand } from './commandParser';
import { CommandExecutor } from './commandExecutor';
import { MDCLCodeLensProvider } from './codeLensProvider';
import { MDCLPreviewPanel } from './previewPanel';

let commandExecutor: CommandExecutor;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 CodeLab extension is now active!');
    console.log('Extension context:', {
        extensionPath: context.extensionPath,
        globalState: !!context.globalState,
        workspaceState: !!context.workspaceState
    });
    console.log('VS Code version:', vscode.version);

    // Log all currently open documents
    vscode.workspace.textDocuments.forEach(doc => {
        console.log('📄 Open document:', doc.uri.toString(), 'Language:', doc.languageId);
    });

    commandExecutor = new CommandExecutor(context);
    console.log('✅ CommandExecutor initialized');

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

    // Auto-open preview for MDCL files
    vscode.workspace.onDidOpenTextDocument(async (document) => {
        console.log('📄 Document opened:', document.uri.toString(), 'Language:', document.languageId);

        const config = vscode.workspace.getConfiguration('mdcl');
        const autoPreview = config.get<boolean>('autoOpenPreview', true);
        console.log('⚙️ Auto preview setting:', autoPreview);

        if (autoPreview && document.languageId === 'mdcl' && !document.isUntitled) {
            console.log('🔄 Scheduling auto-preview for MDCL file');
            // Increased delay to ensure editor and code lenses are ready
            setTimeout(() => {
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.toString() === document.uri.toString()
                );
                if (editor && !MDCLPreviewPanel.currentPanel) {
                    console.log('🎭 Creating preview panel for MDCL file');
                    MDCLPreviewPanel.createOrShow(
                        context.extensionUri,
                        document,
                        commandExecutor
                    );
                } else {
                    console.log('❌ Preview panel not created:', {
                        editorFound: !!editor,
                        panelExists: !!MDCLPreviewPanel.currentPanel
                    });
                }
            }, 750); // Increased delay for VS Code 1.104.1
        }
    });

    // Also handle when switching to an MDCL file that's already open
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        console.log('👁️ Active editor changed:', editor ? editor.document.uri.toString() : 'none');
        if (editor) {
            console.log('📄 New active document language:', editor.document.languageId);
        }

        if (editor && editor.document.languageId === 'mdcl') {
            const config = vscode.workspace.getConfiguration('mdcl');
            const autoPreview = config.get<boolean>('autoOpenPreview', true);
            console.log('🔄 Switching to MDCL file, auto preview:', autoPreview);

            if (autoPreview && !MDCLPreviewPanel.currentPanel) {
                console.log('🎭 Creating preview panel for switched MDCL file');
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
    if (commandExecutor) {
        commandExecutor.dispose();
    }
}