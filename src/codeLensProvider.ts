import * as vscode from 'vscode';
import { CommandParser, MDCLCommand } from './commandParser';

export class MDCLCodeLensProvider implements vscode.CodeLensProvider {
    private parser: CommandParser;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        this.parser = new CommandParser();
        console.log('⚙️ MDCLCodeLensProvider constructor called');

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mdcl.enableCodeLens')) {
                console.log('🔄 CodeLens configuration changed, refreshing...');
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    public refresh(): void {
        console.log('🔄 Manually refreshing code lenses');
        this._onDidChangeCodeLenses.fire();
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        console.log('🔍 Providing code lenses for document:', document.uri.toString());

        const enabled = vscode.workspace.getConfiguration('mdcl').get<boolean>('enableCodeLens', true);
        console.log('⚙️ CodeLens enabled:', enabled);
        if (!enabled) {
            console.log('❌ CodeLens disabled, returning empty array');
            return [];
        }

        const documentText = document.getText();
        console.log('📄 Document text length:', documentText.length);
        console.log('📄 First 200 chars:', documentText.substring(0, 200));

        const commands = this.parser.parseDocument(documentText);
        console.log('🚀 Parsed commands:', commands.length);
        console.log('🚀 Commands details:', commands.map(cmd => ({
            line: cmd.line,
            action: cmd.action,
            command: cmd.command,
            terminal: cmd.terminal,
            interrupt: cmd.interrupt
        })));

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
            console.log('✨ Created code lens:', {
                title,
                range: `${command.line}:${command.startIndex}-${command.endIndex}`,
                command: this.getVSCodeCommand(command)
            });
        }

        console.log('✅ Returning', codeLenses.length, 'code lenses');
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