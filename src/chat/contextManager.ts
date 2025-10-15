import * as vscode from 'vscode';
import * as path from 'path';
import { ContextItem } from '../types/chat';
import { TutorialContextExtractor } from './tutorialContext';

export class ContextManager {
    // File extensions to treat as text files
    private static readonly TEXT_EXTENSIONS = [
        '.mdcl', '.md', '.txt', '.json', '.yaml', '.yml', '.toml',
        '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
        '.go', '.rs', '.rb', '.php', '.html', '.css', '.scss', '.sql',
        '.sh', '.bash', '.zsh', '.xml', '.csv', '.env', '.config',
        '.dockerfile', '.gitignore', '.editorconfig'
    ];

    /**
     * Check if a file should be treated as text
     */
    private static isTextFile(uri: vscode.Uri): boolean {
        const ext = path.extname(uri.fsPath).toLowerCase();
        return this.TEXT_EXTENSIONS.includes(ext) || ext === '';
    }

    /**
     * Load context from a single file
     */
    public static async loadFileContext(uri: vscode.Uri): Promise<string> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const fileName = path.basename(uri.fsPath);
            const ext = path.extname(uri.fsPath).toLowerCase();

            // For .mdcl and .md files, use the tutorial context extractor
            if (ext === '.mdcl' || ext === '.md') {
                const context = TutorialContextExtractor.extractContext(document);
                return TutorialContextExtractor.formatContextForLLM(context);
            }

            // For other text files, include the raw content
            if (this.isTextFile(uri)) {
                return `File: ${fileName}\n\`\`\`\n${document.getText()}\n\`\`\``;
            }

            // Skip binary files
            return `File: ${fileName} (binary file - skipped)`;
        } catch (error) {
            console.error(`Failed to load file context: ${uri.fsPath}`, error);
            return '';
        }
    }

    /**
     * Load context from multiple files
     */
    public static async loadMultipleFilesContext(uris: vscode.Uri[]): Promise<string> {
        const contexts: string[] = [];

        for (const uri of uris) {
            const fileName = path.basename(uri.fsPath);
            const fileContext = await this.loadFileContext(uri);

            if (fileContext) {
                contexts.push(`\n\n## File: ${fileName}\n\n${fileContext}`);
            }
        }

        return contexts.length > 0
            ? `# Tutorial Context (Multiple Files)\n${contexts.join('\n')}`
            : '';
    }

    /**
     * Load context from all text files in a folder
     * Prioritizes .mdcl and .md files, but includes other text files
     */
    public static async loadFolderContext(folderUri: vscode.Uri): Promise<string> {
        try {
            // Find .mdcl files
            const mdclFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folderUri, '**/*.mdcl'),
                '**/node_modules/**'
            );

            // Find .md files
            const mdFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folderUri, '**/*.md'),
                '**/node_modules/**'
            );

            // Find other common text files
            const otherFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folderUri, '**/*.{txt,json,yaml,yml,js,ts,py,java,go,rs,html,css,sh,sql}'),
                '**/node_modules/**'
            );

            // Combine all files, prioritizing .mdcl and .md
            const allFiles = [...mdclFiles, ...mdFiles, ...otherFiles];

            if (allFiles.length === 0) {
                return `No text files found in folder: ${path.basename(folderUri.fsPath)}`;
            }

            return await this.loadMultipleFilesContext(allFiles);
        } catch (error) {
            console.error(`Failed to load folder context: ${folderUri.fsPath}`, error);
            return '';
        }
    }

    /**
     * Load context from all text files in the workspace
     * Prioritizes .mdcl and .md files, but includes other text files
     */
    public static async loadWorkspaceContext(): Promise<string> {
        try {
            // Find .mdcl files
            const mdclFiles = await vscode.workspace.findFiles(
                '**/*.mdcl',
                '**/node_modules/**'
            );

            // Find .md files
            const mdFiles = await vscode.workspace.findFiles(
                '**/*.md',
                '**/node_modules/**'
            );

            // Find other common text files (limit to prevent overload)
            const otherFiles = await vscode.workspace.findFiles(
                '**/*.{txt,json,yaml,yml,js,ts,py,java,go,rs,html,css,sh,sql}',
                '**/node_modules/**',
                200  // Limit other files to prevent context overload
            );

            // Combine all files, prioritizing .mdcl and .md
            const allFiles = [...mdclFiles, ...mdFiles, ...otherFiles];

            if (allFiles.length === 0) {
                return 'No text files found in workspace';
            }

            return await this.loadMultipleFilesContext(allFiles);
        } catch (error) {
            console.error('Failed to load workspace context', error);
            return '';
        }
    }

    /**
     * Get available context items for selection
     */
    public static async getAvailableContextItems(): Promise<ContextItem[]> {
        const items: ContextItem[] = [];

        // Add workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                items.push({
                    type: 'folder',
                    uri: folder.uri.toString(),
                    name: `📁 Workspace: ${folder.name}`
                });
            }
        }

        // Priority 1: Add .mdcl files (primary tutorial files)
        const mdclFiles = await vscode.workspace.findFiles(
            '**/*.mdcl',
            '**/node_modules/**',
            100
        );

        // Priority 2: Add .md files (markdown documentation)
        const mdFiles = await vscode.workspace.findFiles(
            '**/*.md',
            '**/node_modules/**',
            100
        );

        // Priority 3: Add common text files that might be referenced in tutorials
        const otherFiles = await vscode.workspace.findFiles(
            '**/*.{txt,json,yaml,yml,js,ts,py,java,go,rs,html,css,sh,sql,env,config}',
            '**/node_modules/**',
            200
        );

        // Combine and deduplicate files
        const allFiles = [...mdclFiles, ...mdFiles, ...otherFiles];
        const uniqueFiles = Array.from(new Map(
            allFiles.map(file => [file.toString(), file])
        ).values());

        // Sort files: .mdcl first, then .md, then others
        uniqueFiles.sort((a, b) => {
            const extA = path.extname(a.fsPath).toLowerCase();
            const extB = path.extname(b.fsPath).toLowerCase();

            if (extA === '.mdcl' && extB !== '.mdcl') return -1;
            if (extB === '.mdcl' && extA !== '.mdcl') return 1;
            if (extA === '.md' && extB !== '.md') return -1;
            if (extB === '.md' && extA !== '.md') return 1;

            return a.fsPath.localeCompare(b.fsPath);
        });

        // Add files to items with appropriate icons
        for (const file of uniqueFiles) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
            const relativePath = workspaceFolder
                ? path.relative(workspaceFolder.uri.fsPath, file.fsPath)
                : path.basename(file.fsPath);

            const ext = path.extname(file.fsPath).toLowerCase();
            let prefix = '';

            // Use simple text prefixes for different file types
            if (ext === '.mdcl') prefix = '[mdcl] ';
            else if (ext === '.md') prefix = '[md] ';
            else if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) prefix = '[js] ';
            else if (['.py', '.java', '.go', '.rs'].includes(ext)) prefix = '[code] ';
            else if (['.json', '.yaml', '.yml'].includes(ext)) prefix = '[config] ';
            else if (['.html', '.css', '.scss'].includes(ext)) prefix = '[web] ';

            items.push({
                type: 'file',
                uri: file.toString(),
                name: `${prefix}${relativePath}`
            });
        }

        return items;
    }

    /**
     * Build context string from context URIs
     */
    public static async buildContextFromUris(uris: string[], contextType: string): Promise<string> {
        if (uris.length === 0) {
            return '';
        }

        const vscodeUris = uris.map(u => vscode.Uri.parse(u));

        switch (contextType) {
            case 'file':
                return vscodeUris.length === 1
                    ? await this.loadFileContext(vscodeUris[0])
                    : await this.loadMultipleFilesContext(vscodeUris);

            case 'folder':
                return await this.loadFolderContext(vscodeUris[0]);

            case 'workspace':
                return await this.loadWorkspaceContext();

            default:
                return await this.loadMultipleFilesContext(vscodeUris);
        }
    }
}
