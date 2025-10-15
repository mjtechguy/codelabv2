import * as vscode from 'vscode';
import { TutorialContext, TutorialSection } from '../types/chat';

export class TutorialContextExtractor {
    public static extractContext(document: vscode.TextDocument): TutorialContext {
        const content = document.getText();
        const lines = content.split('\n');

        const sections = this.extractSections(lines);
        const commands = this.extractCommands(content);
        const quizzes = this.extractQuizzes(content);

        return {
            fullContent: content,
            sections,
            commands,
            quizzes
        };
    }

    private static extractSections(lines: string[]): TutorialSection[] {
        const sections: TutorialSection[] = [];
        let currentSection: TutorialSection | null = null;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

            if (headingMatch) {
                // Save the previous section
                if (currentSection) {
                    currentSection.lineEnd = index - 1;
                    sections.push(currentSection);
                }

                // Start a new section
                const level = headingMatch[1].length;
                const heading = headingMatch[2];

                currentSection = {
                    heading,
                    level,
                    content: '',
                    lineStart: index,
                    lineEnd: index
                };
            } else if (currentSection) {
                // Add content to current section
                currentSection.content += line + '\n';
            }
        }

        // Don't forget the last section
        if (currentSection) {
            currentSection.lineEnd = lines.length - 1;
            sections.push(currentSection);
        }

        return sections;
    }

    private static extractCommands(content: string): string[] {
        const commands: string[] = [];

        // Extract inline commands: `command` {{ execute }}
        const inlineCommandRegex = /`([^`]+)`\s*\{\{\s*(execute|copy|open)(?:\s+[^}]*)?\}\}/g;
        let match;

        while ((match = inlineCommandRegex.exec(content)) !== null) {
            commands.push(match[1]);
        }

        // Extract block commands: ```{{ execute }}
        const blockCommandRegex = /```(?:\w+)?\{\{\s*execute[^}]*\}\}\s*\n([^`]*)```/g;

        while ((match = blockCommandRegex.exec(content)) !== null) {
            const blockContent = match[1].trim();
            const blockCommands = blockContent.split('\n').filter(line => line.trim());
            commands.push(...blockCommands);
        }

        return commands;
    }

    private static extractQuizzes(content: string): string[] {
        const quizzes: string[] = [];

        // Extract block quizzes
        const quizBlockRegex = /```quiz[^`]*\n([^`]*)```/g;
        let match;

        while ((match = quizBlockRegex.exec(content)) !== null) {
            quizzes.push(match[1].trim());
        }

        // Extract inline quizzes
        const inlineQuizRegex = /`([^`]+)`\s*\{\{\s*quiz[^}]*\}\}/g;

        while ((match = inlineQuizRegex.exec(content)) !== null) {
            quizzes.push(match[1]);
        }

        return quizzes;
    }

    public static formatContextForLLM(context: TutorialContext, includeCommands: boolean = true, includeQuizzes: boolean = true): string {
        let formatted = '# Tutorial Content\n\n';
        formatted += context.fullContent;

        if (includeCommands && context.commands.length > 0) {
            formatted += '\n\n## Commands in this tutorial:\n';
            context.commands.forEach((cmd, idx) => {
                formatted += `${idx + 1}. \`${cmd}\`\n`;
            });
        }

        if (includeQuizzes && context.quizzes.length > 0) {
            formatted += '\n\n## Quiz questions in this tutorial:\n';
            context.quizzes.forEach((quiz, idx) => {
                formatted += `${idx + 1}. ${quiz}\n`;
            });
        }

        return formatted;
    }

    public static findSectionByHeading(context: TutorialContext, heading: string): TutorialSection | null {
        const normalized = heading.toLowerCase().trim();
        return context.sections.find(
            section => section.heading.toLowerCase().trim().includes(normalized)
        ) || null;
    }

    public static getSectionContext(section: TutorialSection): string {
        let formatted = `# ${section.heading}\n\n`;
        formatted += section.content;
        return formatted;
    }
}
