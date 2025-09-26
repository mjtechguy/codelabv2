export interface MDCLCommand {
    line: number;
    startIndex: number;
    endIndex: number;
    command: string;
    action: 'execute' | 'copy' | 'open';
    terminal?: string;
    interrupt?: boolean;
    fullMatch: string;
}

export class CommandParser {
    // Updated regex to handle both quoted and unquoted terminal names and interrupt
    private static readonly COMMAND_REGEX = /`([^`]+)`\s*\{\{\s*(execute|copy|open)(?:\s+(?:'([^']+)'|([^\s}]+)))?(?:\s+(interrupt))?\s*\}\}/g;

    public parseDocument(text: string): MDCLCommand[] {
        const commands: MDCLCommand[] = [];
        const lines = text.split('\n');

        lines.forEach((line, lineIndex) => {
            let match;
            const regex = new RegExp(CommandParser.COMMAND_REGEX.source, 'g');

            while ((match = regex.exec(line)) !== null) {
                const command: MDCLCommand = {
                    line: lineIndex,
                    startIndex: match.index,
                    endIndex: match.index + match[0].length,
                    command: match[1],
                    action: match[2] as 'execute' | 'copy' | 'open',
                    fullMatch: match[0]
                };

                // Handle both quoted (match[3]) and unquoted (match[4]) terminal names
                if (match[3]) {
                    command.terminal = match[3]; // quoted terminal name
                } else if (match[4] && match[4] !== 'interrupt') {
                    command.terminal = match[4]; // unquoted terminal name
                }

                // Check for interrupt flag in match[4] or match[5]
                if (match[4] === 'interrupt' || match[5] === 'interrupt') {
                    command.interrupt = true;
                }

                commands.push(command);
            }
        });

        return commands;
    }

    public parseLine(line: string, lineNumber: number): MDCLCommand | null {
        const regex = new RegExp(CommandParser.COMMAND_REGEX.source, 'g');
        const match = regex.exec(line);

        if (!match) {
            return null;
        }

        const command: MDCLCommand = {
            line: lineNumber,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            command: match[1],
            action: match[2] as 'execute' | 'copy' | 'open',
            fullMatch: match[0]
        };

        // Handle both quoted (match[3]) and unquoted (match[4]) terminal names
        if (match[3]) {
            command.terminal = match[3]; // quoted terminal name
        } else if (match[4] && match[4] !== 'interrupt') {
            command.terminal = match[4]; // unquoted terminal name
        }

        // Check for interrupt flag in match[4] or match[5]
        if (match[4] === 'interrupt' || match[5] === 'interrupt') {
            command.interrupt = true;
        }

        return command;
    }
}