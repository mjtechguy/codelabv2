import * as vscode from 'vscode';
import { CommandParser, MDCLCommand } from './commandParser';

export class MDCLCodeLensProvider implements vscode.CodeLensProvider {
    private parser: CommandParser;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        this.parser = new CommandParser();

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mdcl.enableCodeLens')) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const enabled = vscode.workspace.getConfiguration('mdcl').get<boolean>('enableCodeLens', true);
        if (!enabled) {
            return [];
        }

        const documentText = document.getText();
        const commands = this.parser.parseDocument(documentText);

        const codeLenses: vscode.CodeLens[] = [];

        for (const command of commands) {
            const range = new vscode.Range(
                new vscode.Position(command.line, command.startIndex),
                new vscode.Position(command.line, command.endIndex)
            );

            const title = this.getCodeLensTitle(command);
            const codeLensCommand: vscode.Command = {
                title,
                command: this.getVSCodeCommand(command),
                arguments: [command, document.uri]
            };

            codeLenses.push(new vscode.CodeLens(range, codeLensCommand));
        }

        return codeLenses;
    }

    private getCodeLensTitle(command: MDCLCommand): string {
        switch (command.action) {
            case 'execute':
                if (command.terminal) {
                    return `▶ Run in ${command.terminal}`;
                }
                return command.interrupt ? '▶ Interrupt & Run' : '▶ Run';
            case 'copy':
                return '📋 Copy';
            case 'open':
                return '📂 Open';
            default:
                return 'Execute';
        }
    }

    private getVSCodeCommand(command: MDCLCommand): string {
        switch (command.action) {
            case 'execute':
                return 'mdcl.executeCommand';
            case 'copy':
                return 'mdcl.copyCommand';
            case 'open':
                return 'mdcl.openFile';
            default:
                return 'mdcl.executeCommand';
        }
    }

    public resolveCodeLens(
        codeLens: vscode.CodeLens,
        token: vscode.CancellationToken
    ): vscode.CodeLens | Thenable<vscode.CodeLens> {
        return codeLens;
    }
}