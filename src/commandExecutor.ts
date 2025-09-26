import * as vscode from 'vscode';
import * as path from 'path';
import { MDCLCommand } from './commandParser';

export class CommandExecutor {
    private terminals: Map<string, vscode.Terminal> = new Map();

    constructor(private context: vscode.ExtensionContext) {}

    public async execute(command: MDCLCommand, documentUri?: vscode.Uri): Promise<void> {
        switch (command.action) {
            case 'execute':
                await this.executeInTerminal(command);
                break;
            case 'copy':
                await this.copyToClipboard(command);
                break;
            case 'open':
                await this.openFile(command, documentUri);
                break;
        }
    }

    private async executeInTerminal(command: MDCLCommand): Promise<void> {
        const terminalName = command.terminal || 'main';
        let terminal = this.terminals.get(terminalName);

        if (!terminal || terminal.exitStatus !== undefined) {
            terminal = vscode.window.createTerminal(`CodeLab - ${terminalName}`);
            this.terminals.set(terminalName, terminal);
        }

        terminal.show();

        if (command.interrupt) {
            const interruptDelay = vscode.workspace.getConfiguration('mdcl').get<number>('interruptDelay', 200);

            terminal.sendText('\u0003', false);

            await new Promise(resolve => setTimeout(resolve, interruptDelay));
        }

        // Escape exclamation marks for bash history expansion
        // This prevents issues with commands like: echo "Hello!"
        const escapedCommand = command.command.replace(/!/g, '\\!');
        terminal.sendText(escapedCommand, true);
    }

    private async copyToClipboard(command: MDCLCommand): Promise<void> {
        await vscode.env.clipboard.writeText(command.command);
        vscode.window.showInformationMessage('Copied to clipboard!');
    }

    private async openFile(command: MDCLCommand, documentUri?: vscode.Uri): Promise<void> {
        let filePath = command.command;

        const openRelative = vscode.workspace.getConfiguration('mdcl').get<string>('openRelative', 'File');

        if (!path.isAbsolute(filePath)) {
            if (openRelative === 'File' && documentUri) {
                const dirPath = path.dirname(documentUri.fsPath);
                filePath = path.join(dirPath, filePath);
            } else if (openRelative === 'Workspace') {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    filePath = path.join(workspaceFolder.uri.fsPath, filePath);
                }
            }
        }

        try {
            const fileUri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
    }

    public dispose(): void {
        for (const terminal of this.terminals.values()) {
            terminal.dispose();
        }
        this.terminals.clear();
    }
}