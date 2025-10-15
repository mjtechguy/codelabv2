import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { ChatConfig, ModelConfig } from '../types/chat';

export class ConfigLoader {
    private static readonly CONFIG_DIR = '.codelab';
    private static readonly CONFIG_FILE = 'config.yaml';

    public static async loadConfig(): Promise<ChatConfig | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('No workspace folder found. Please open a workspace to use CodeLab chat.');
            return null;
        }

        const configPath = path.join(
            workspaceFolder.uri.fsPath,
            this.CONFIG_DIR,
            this.CONFIG_FILE
        );

        if (!fs.existsSync(configPath)) {
            await this.promptCreateConfig(workspaceFolder.uri.fsPath);
            return null;
        }

        try {
            const configContent = fs.readFileSync(configPath, 'utf-8');
            const config = parseYaml(configContent) as ChatConfig;

            this.validateConfig(config);
            return config;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load chat config: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private static validateConfig(config: ChatConfig): void {
        if (!config.version) {
            throw new Error('Config version is required');
        }

        // Support both single model and multiple models
        if (!config.model && !config.models) {
            throw new Error('Model configuration is required (either "model" or "models")');
        }

        // Validate models array if present
        if (config.models) {
            if (!Array.isArray(config.models) || config.models.length === 0) {
                throw new Error('Models array must contain at least one model');
            }
            config.models.forEach((model, index) => {
                this.validateModelConfig(model, `Model ${index + 1}`);
            });
        }

        // Validate single model if present
        if (config.model) {
            this.validateModelConfig(config.model, 'Model');
        }
    }

    private static validateModelConfig(model: any, label: string): void {
        if (!model.provider) {
            throw new Error(`${label}: provider is required`);
        }

        if (!model.apiBase) {
            throw new Error(`${label}: apiBase is required`);
        }

        if (!model.apiKey) {
            throw new Error(`${label}: apiKey is required`);
        }

        if (!model.model) {
            throw new Error(`${label}: model name is required`);
        }
    }

    public static getModels(config: ChatConfig): ModelConfig[] {
        // Return models array if present, otherwise wrap single model in array
        if (config.models && config.models.length > 0) {
            return config.models;
        }
        if (config.model) {
            return [config.model];
        }
        return [];
    }

    public static getDefaultModel(config: ChatConfig): ModelConfig | null {
        const models = this.getModels(config);
        if (models.length === 0) {
            return null;
        }

        // If defaultModel is specified, find it by name
        if (config.defaultModel) {
            const found = models.find(m => m.name === config.defaultModel);
            if (found) {
                return found;
            }
        }

        // Otherwise return first model
        return models[0];
    }

    private static async promptCreateConfig(workspacePath: string): Promise<void> {
        const create = await vscode.window.showInformationMessage(
            'CodeLab chat requires configuration. Would you like to create a config file?',
            'Create Config',
            'Cancel'
        );

        if (create === 'Create Config') {
            await this.createDefaultConfig(workspacePath);
        }
    }

    private static async createDefaultConfig(workspacePath: string): Promise<void> {
        const configDir = path.join(workspacePath, this.CONFIG_DIR);
        const configPath = path.join(configDir, this.CONFIG_FILE);

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const defaultConfig = `version: "1.0"
model:
  provider: openai-compatible
  apiBase: https://api.openai.com/v1
  apiKey: YOUR_API_KEY_HERE
  model: gpt-4
  temperature: 0.7
  maxTokens: 2000
  systemPrompt: "You are a helpful tutor. Answer questions about the tutorial content provided as context. Be concise and educational."
`;

        fs.writeFileSync(configPath, defaultConfig, 'utf-8');

        // Add to gitignore
        await this.addToGitignore(workspacePath);

        const edit = await vscode.window.showInformationMessage(
            'Config file created at .codelab/config.yaml. Please add your API key.',
            'Open Config',
            'Close'
        );

        if (edit === 'Open Config') {
            const document = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(document);
        }
    }

    private static async addToGitignore(workspacePath: string): Promise<void> {
        const gitignorePath = path.join(workspacePath, '.gitignore');
        const gitignoreEntry = '\n# CodeLab configuration (contains API keys)\n.codelab/\n';

        try {
            if (fs.existsSync(gitignorePath)) {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                if (!content.includes('.codelab/')) {
                    fs.appendFileSync(gitignorePath, gitignoreEntry);
                }
            } else {
                fs.writeFileSync(gitignorePath, gitignoreEntry.trim() + '\n');
            }
        } catch (error) {
            console.warn('Failed to update .gitignore:', error);
        }
    }

    public static getConfigPath(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }

        return path.join(
            workspaceFolder.uri.fsPath,
            this.CONFIG_DIR,
            this.CONFIG_FILE
        );
    }
}
