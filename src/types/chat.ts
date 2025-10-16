export interface ChatConfig {
    version: string;
    model?: ModelConfig;  // Legacy: single model
    models?: ModelConfig[];  // New: multiple models
    defaultModel?: string;  // Name of default model to use
}

export interface ModelConfig {
    name?: string;  // Friendly name for the model
    provider: string;
    apiBase: string;
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    thinking?: {
        enabled: boolean;  // Enable thinking/reasoning mode
        budget?: number;   // Token budget for thinking (provider-specific)
    };
    pricing?: {
        inputCost: number;   // Cost per 1M input tokens in USD
        outputCost: number;  // Cost per 1M output tokens in USD
    };
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

export interface ChatSession {
    id: string;
    name: string;
    contextType: 'file' | 'folder' | 'workspace' | 'custom';
    contextUris: string[];  // Array of file/folder URIs (explicit context)
    implicitContextUris?: string[];  // Array of automatically tracked open files
    messages: ChatMessage[];
    createdAt: number;
    lastUpdated?: number;  // Timestamp of last modification
    version?: number;  // Schema version for future migrations (default: 1)
}

/**
 * Lightweight session metadata for index storage
 * Stored in globalState for fast lookup without loading full session
 */
export interface SessionMetadata {
    id: string;
    name: string;
    createdAt: number;
    lastUpdated: number;
    messageCount: number;  // For sorting/display
}

export interface ContextItem {
    type: 'file' | 'folder' | 'selection' | 'terminal' | 'codebase';
    uri: string;
    name: string;
    content?: string;  // For files
    isImplicit?: boolean;  // Whether this was automatically added
    icon?: string;  // Icon identifier for the context item
}

export interface TutorialContext {
    fullContent: string;
    sections: TutorialSection[];
    commands: string[];
    quizzes: string[];
}

export interface TutorialSection {
    heading: string;
    level: number;
    content: string;
    lineStart: number;
    lineEnd: number;
}

export interface LLMRequest {
    messages: Array<{
        role: string;
        content: string;
    }>;
    model: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
}

export interface LLMResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
}

export interface LLMStreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
            reasoning_content?: string;  // DeepSeek reasoning tokens
            type?: string;  // Anthropic content type
        };
        finish_reason: string | null;
    }>;
}
