import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ChatConfig, ModelConfig } from '../types/chat';
import { ConfigLoader } from './configLoader';
import { LLMClient } from './llmClient';

export class ModelConfigPanel {
    public static currentPanel: ModelConfigPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _config: ChatConfig | null = null;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'loadConfig':
                        await this.loadConfig();
                        break;
                    case 'saveConfig':
                        await this.saveConfig(message.config);
                        break;
                    case 'testModel':
                        await this.testModel(message.model);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.ViewColumn.One;

        if (ModelConfigPanel.currentPanel) {
            ModelConfigPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'modelConfig',
            'Model Configuration',
            column,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')]
            }
        );

        ModelConfigPanel.currentPanel = new ModelConfigPanel(panel, extensionUri);
    }

    private async loadConfig() {
        this._config = await ConfigLoader.loadConfig();
        if (this._config) {
            this._panel.webview.postMessage({
                type: 'configLoaded',
                config: this._config
            });
        }
    }

    private async saveConfig(config: ChatConfig) {
        const configPath = ConfigLoader.getConfigPath();
        if (!configPath) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        try {
            const yamlContent = stringifyYaml(config);
            fs.writeFileSync(configPath, yamlContent, 'utf-8');

            vscode.window.showInformationMessage('Model configuration saved successfully');

            // Notify that config changed so other components can reload
            this._panel.webview.postMessage({
                type: 'configSaved'
            });

            // Broadcast config change to all extensions
            vscode.commands.executeCommand('vslabsai.reloadConfig');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async testModel(model: ModelConfig) {
        try {
            const client = new LLMClient(model);
            const success = await client.testConnection();

            this._panel.webview.postMessage({
                type: 'testResult',
                modelName: model.name || model.model,
                success: success,
                message: success ? 'Connection successful!' : 'Connection failed'
            });
        } catch (error) {
            this._panel.webview.postMessage({
                type: 'testResult',
                modelName: model.name || model.model,
                success: false,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    public dispose() {
        ModelConfigPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
        this.loadConfig();
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Model Configuration</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .header h1 {
            font-size: 20px;
            font-weight: 600;
        }

        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
        }

        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-test {
            padding: 6px 12px;
            font-size: 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-danger {
            background-color: #f14c4c;
            color: white;
        }

        .btn-danger:hover {
            background-color: #d43b3b;
        }

        .models-list {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .model-card {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 16px;
            transition: border-color 0.2s;
        }

        .model-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .model-card.disabled {
            opacity: 0.6;
        }

        .model-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .model-name {
            font-size: 16px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .model-actions {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .toggle-switch {
            position: relative;
            width: 44px;
            height: 24px;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 24px;
            transition: 0.3s;
        }

        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 3px;
            bottom: 3px;
            background-color: var(--vscode-input-foreground);
            border-radius: 50%;
            transition: 0.3s;
        }

        input:checked + .toggle-slider {
            background-color: var(--vscode-button-background);
            border-color: var(--vscode-button-background);
        }

        input:checked + .toggle-slider:before {
            transform: translateX(20px);
            background-color: white;
        }

        .model-details {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            font-size: 12px;
        }

        .detail-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .detail-label {
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }

        .detail-value {
            color: var(--vscode-foreground);
            word-break: break-all;
        }

        .detail-value.masked {
            font-family: monospace;
        }

        .test-status {
            margin-top: 12px;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            display: none;
        }

        .test-status.success {
            display: block;
            background-color: rgba(80, 200, 120, 0.2);
            color: #50c878;
            border: 1px solid rgba(80, 200, 120, 0.4);
        }

        .test-status.error {
            display: block;
            background-color: rgba(241, 76, 76, 0.2);
            color: #f14c4c;
            border: 1px solid rgba(241, 76, 76, 0.4);
        }

        .test-status.testing {
            display: block;
            background-color: rgba(100, 150, 255, 0.2);
            color: #6496ff;
            border: 1px solid rgba(100, 150, 255, 0.4);
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }

        .empty-state-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .empty-state-desc {
            font-size: 14px;
            margin-bottom: 20px;
        }

        .form-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .form-overlay.active {
            display: flex;
        }

        .form-modal {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            max-width: 600px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            padding: 24px;
        }

        .form-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .form-title {
            font-size: 18px;
            font-weight: 600;
        }

        .form-group {
            margin-bottom: 16px;
        }

        .form-label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-foreground);
        }

        .form-input {
            width: 100%;
            padding: 8px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
        }

        .form-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .form-input[type="number"] {
            width: auto;
        }

        .form-checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .form-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Model Configuration</h1>
        <button class="btn btn-primary" onclick="showAddModelForm()">+ Add Model</button>
    </div>

    <div id="modelsList" class="models-list">
        <div class="empty-state">
            <div class="empty-state-icon">🤖</div>
            <div class="empty-state-title">No models configured</div>
            <div class="empty-state-desc">Add your first AI model to get started</div>
        </div>
    </div>

    <div id="formOverlay" class="form-overlay">
        <div class="form-modal">
            <div class="form-header">
                <h2 class="form-title" id="formTitle">Add Model</h2>
            </div>

            <form id="modelForm">
                <div class="form-group">
                    <label class="form-label">Model Name</label>
                    <input type="text" class="form-input" id="modelName" placeholder="My GPT-4" required>
                    <div class="form-hint">Friendly name for this model</div>
                </div>

                <div class="form-group">
                    <label class="form-label">Provider</label>
                    <input type="text" class="form-input" id="modelProvider" placeholder="openai" required>
                    <div class="form-hint">openai, deepseek, anthropic, gemini, etc.</div>
                </div>

                <div class="form-group">
                    <label class="form-label">API Base URL</label>
                    <input type="text" class="form-input" id="modelApiBase" placeholder="https://api.openai.com/v1" required>
                </div>

                <div class="form-group">
                    <label class="form-label">API Key</label>
                    <input type="password" class="form-input" id="modelApiKey" placeholder="sk-..." required>
                </div>

                <div class="form-group">
                    <label class="form-label">Model ID</label>
                    <input type="text" class="form-input" id="modelId" placeholder="gpt-4" required>
                    <div class="form-hint">The exact model identifier from the provider</div>
                </div>

                <div class="form-group">
                    <label class="form-label">Temperature</label>
                    <input type="number" class="form-input" id="modelTemperature" placeholder="0.7" min="0" max="2" step="0.1">
                    <div class="form-hint">0 = deterministic, 2 = very creative (default: 0.7)</div>
                </div>

                <div class="form-group">
                    <label class="form-label">Max Tokens</label>
                    <input type="number" class="form-input" id="modelMaxTokens" placeholder="2000" min="100">
                </div>

                <div class="form-group">
                    <label class="form-label">System Prompt (Optional)</label>
                    <textarea class="form-input" id="modelSystemPrompt" rows="3" placeholder="You are a helpful assistant..."></textarea>
                </div>

                <div class="form-group">
                    <div class="form-checkbox-group">
                        <input type="checkbox" id="thinkingEnabled">
                        <label class="form-label" style="margin: 0;">Enable Thinking/Reasoning Mode</label>
                    </div>
                    <div class="form-hint">For models that support extended thinking (DeepSeek R1, Claude 3.7+, Gemini 2.5)</div>
                </div>

                <div class="form-group" id="thinkingBudgetGroup" style="display: none;">
                    <label class="form-label">Thinking Budget (Tokens)</label>
                    <input type="number" class="form-input" id="thinkingBudget" placeholder="4096" min="-1">
                    <div class="form-hint">Token budget for thinking. Use -1 for dynamic (Gemini)</div>
                </div>

                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeForm()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save Model</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentConfig = null;
        let editingIndex = -1;

        // Request config on load
        vscode.postMessage({ type: 'loadConfig' });

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'configLoaded':
                    currentConfig = message.config;
                    renderModels();
                    break;
                case 'configSaved':
                    vscode.postMessage({ type: 'loadConfig' });
                    break;
                case 'testResult':
                    showTestResult(message.modelName, message.success, message.message);
                    break;
            }
        });

        function renderModels() {
            const container = document.getElementById('modelsList');
            const models = currentConfig?.models || [];

            if (models.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🤖</div>
                        <div class="empty-state-title">No models configured</div>
                        <div class="empty-state-desc">Add your first AI model to get started</div>
                    </div>
                \`;
                return;
            }

            container.innerHTML = models.map((model, index) => \`
                <div class="model-card" data-index="\${index}">
                    <div class="model-card-header">
                        <div class="model-name">\${model.name || model.model}</div>
                        <div class="model-actions">
                            <button class="btn btn-test" onclick="testModel(\${index})">Test</button>
                            <button class="btn btn-secondary" onclick="editModel(\${index})">Edit</button>
                            <button class="btn btn-danger" onclick="deleteModel(\${index})">Delete</button>
                        </div>
                    </div>
                    <div class="model-details">
                        <div class="detail-item">
                            <div class="detail-label">Provider</div>
                            <div class="detail-value">\${model.provider}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Model</div>
                            <div class="detail-value">\${model.model}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">API Base</div>
                            <div class="detail-value">\${model.apiBase}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">API Key</div>
                            <div class="detail-value masked">\${maskApiKey(model.apiKey)}</div>
                        </div>
                        \${model.temperature !== undefined ? \`
                        <div class="detail-item">
                            <div class="detail-label">Temperature</div>
                            <div class="detail-value">\${model.temperature}</div>
                        </div>
                        \` : ''}
                        \${model.thinking?.enabled ? \`
                        <div class="detail-item">
                            <div class="detail-label">Thinking Mode</div>
                            <div class="detail-value">✓ Enabled\${model.thinking.budget ? \` (Budget: \${model.thinking.budget})\` : ''}</div>
                        </div>
                        \` : ''}
                    </div>
                    <div class="test-status" id="testStatus\${index}"></div>
                </div>
            \`).join('');
        }

        function maskApiKey(key) {
            if (!key || key.length < 8) return '••••••••';
            return key.substring(0, 7) + '•'.repeat(20);
        }

        function showAddModelForm() {
            editingIndex = -1;
            document.getElementById('formTitle').textContent = 'Add Model';
            document.getElementById('modelForm').reset();
            document.getElementById('formOverlay').classList.add('active');
        }

        function editModel(index) {
            editingIndex = index;
            const model = currentConfig.models[index];

            document.getElementById('formTitle').textContent = 'Edit Model';
            document.getElementById('modelName').value = model.name || '';
            document.getElementById('modelProvider').value = model.provider || '';
            document.getElementById('modelApiBase').value = model.apiBase || '';
            document.getElementById('modelApiKey').value = model.apiKey || '';
            document.getElementById('modelId').value = model.model || '';
            document.getElementById('modelTemperature').value = model.temperature || '';
            document.getElementById('modelMaxTokens').value = model.maxTokens || '';
            document.getElementById('modelSystemPrompt').value = model.systemPrompt || '';
            document.getElementById('thinkingEnabled').checked = model.thinking?.enabled || false;
            document.getElementById('thinkingBudget').value = model.thinking?.budget || '';

            updateThinkingBudgetVisibility();
            document.getElementById('formOverlay').classList.add('active');
        }

        function deleteModel(index) {
            if (confirm('Are you sure you want to delete this model?')) {
                currentConfig.models.splice(index, 1);
                saveConfig();
            }
        }

        function testModel(index) {
            const model = currentConfig.models[index];
            const statusEl = document.getElementById(\`testStatus\${index}\`);
            statusEl.className = 'test-status testing';
            statusEl.textContent = 'Testing connection...';

            vscode.postMessage({
                type: 'testModel',
                model: model
            });
        }

        function showTestResult(modelName, success, message) {
            // Find the model card by name
            const models = currentConfig?.models || [];
            const index = models.findIndex(m => (m.name || m.model) === modelName);
            if (index >= 0) {
                const statusEl = document.getElementById(\`testStatus\${index}\`);
                statusEl.className = \`test-status \${success ? 'success' : 'error'}\`;
                statusEl.textContent = message;

                // Auto-hide after 5 seconds
                setTimeout(() => {
                    statusEl.style.display = 'none';
                }, 5000);
            }
        }

        function closeForm() {
            document.getElementById('formOverlay').classList.remove('active');
        }

        document.getElementById('thinkingEnabled').addEventListener('change', updateThinkingBudgetVisibility);

        function updateThinkingBudgetVisibility() {
            const enabled = document.getElementById('thinkingEnabled').checked;
            document.getElementById('thinkingBudgetGroup').style.display = enabled ? 'block' : 'none';
        }

        document.getElementById('modelForm').addEventListener('submit', (e) => {
            e.preventDefault();

            const model = {
                name: document.getElementById('modelName').value,
                provider: document.getElementById('modelProvider').value,
                apiBase: document.getElementById('modelApiBase').value,
                apiKey: document.getElementById('modelApiKey').value,
                model: document.getElementById('modelId').value,
            };

            const temp = document.getElementById('modelTemperature').value;
            if (temp) model.temperature = parseFloat(temp);

            const maxTokens = document.getElementById('modelMaxTokens').value;
            if (maxTokens) model.maxTokens = parseInt(maxTokens);

            const systemPrompt = document.getElementById('modelSystemPrompt').value;
            if (systemPrompt) model.systemPrompt = systemPrompt;

            const thinkingEnabled = document.getElementById('thinkingEnabled').checked;
            if (thinkingEnabled) {
                model.thinking = { enabled: true };
                const budget = document.getElementById('thinkingBudget').value;
                if (budget) model.thinking.budget = parseInt(budget);
            }

            if (!currentConfig.models) {
                currentConfig.models = [];
            }

            if (editingIndex >= 0) {
                currentConfig.models[editingIndex] = model;
            } else {
                currentConfig.models.push(model);
            }

            saveConfig();
            closeForm();
        });

        function saveConfig() {
            vscode.postMessage({
                type: 'saveConfig',
                config: currentConfig
            });
        }

        // Close form on overlay click
        document.getElementById('formOverlay').addEventListener('click', (e) => {
            if (e.target.id === 'formOverlay') {
                closeForm();
            }
        });
    </script>
</body>
</html>`;
    }
}
