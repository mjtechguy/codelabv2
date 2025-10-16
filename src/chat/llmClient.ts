import { ModelConfig, LLMRequest, LLMResponse, LLMStreamChunk, ChatMessage, ExtendedLLMRequest } from '../types/chat';

export class LLMClient {
    private config: ModelConfig;

    constructor(config: ModelConfig) {
        this.config = config;
    }

    /**
     * Detect the provider type based on model name or provider field
     */
    private getModelProvider(modelName: string, providerField?: string): 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'unknown' {
        const lower = modelName.toLowerCase();
        const provider = providerField?.toLowerCase() || '';

        // Check provider field first
        if (provider.includes('deepseek')) return 'deepseek';
        if (provider.includes('anthropic')) return 'anthropic';
        if (provider.includes('google') || provider.includes('gemini')) return 'gemini';
        if (provider.includes('openai')) return 'openai';

        // Check model name
        if (lower.includes('deepseek') || lower.includes('r1')) return 'deepseek';
        if (lower.includes('claude')) return 'anthropic';
        if (lower.includes('gemini')) return 'gemini';
        if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai';

        return 'unknown';
    }

    /**
     * Check if the model is an OpenAI reasoning model (o1, o3-mini, gpt-5, etc.)
     * These models use max_completion_tokens instead of max_tokens
     */
    private isOpenAIReasoningModel(modelName: string): boolean {
        const reasoningModels = [
            'o1',
            'o3-mini',
            'gpt-5',
            'gpt-4-5',
            'o1-mini',
            'o1-preview'
        ];
        return reasoningModels.some(prefix => modelName.toLowerCase().includes(prefix));
    }

    /**
     * Check if any thinking/reasoning mode should be enabled
     */
    private isThinkingEnabled(): boolean {
        return this.config.thinking?.enabled ?? false;
    }

    public async sendMessage(
        messages: ChatMessage[],
        onStream?: (chunk: string) => void,
        abortSignal?: AbortSignal
    ): Promise<string> {
        const provider = this.getModelProvider(this.config.model, this.config.provider);
        const isOpenAIReasoning = this.isOpenAIReasoningModel(this.config.model);
        const thinkingEnabled = this.isThinkingEnabled();

        const requestBody: ExtendedLLMRequest = {
            model: this.config.model,
            messages: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            temperature: this.config.temperature ?? 0.7,
            stream: !!onStream
        };

        // Provider-specific parameter handling
        if (isOpenAIReasoning) {
            // OpenAI reasoning models use max_completion_tokens
            requestBody.max_completion_tokens = this.config.maxTokens ?? 2000;
            // OpenAI reasoning models only support temperature = 1
            // Override user config - force temperature to 1
            requestBody.temperature = 1;
        } else {
            // Standard max_tokens for other models
            requestBody.max_tokens = this.config.maxTokens ?? 2000;
            // Temperature already set from config above
        }

        // Add thinking/reasoning parameters based on provider
        if (thinkingEnabled && this.config.thinking) {
            const budget = this.config.thinking.budget;

            switch (provider) {
                case 'deepseek':
                    // DeepSeek uses thinking_budget parameter
                    if (budget) {
                        requestBody.thinking_budget = budget;
                    }
                    break;

                case 'anthropic':
                    // Anthropic uses thinking object with type and budget_tokens
                    requestBody.thinking = {
                        type: 'enabled',
                        budget_tokens: Math.max(1024, budget ?? 1024) // Min 1024 tokens
                    };
                    // Add beta header for extended thinking
                    break;

                case 'gemini':
                    // Gemini uses thinkingBudget parameter
                    // -1 = dynamic, or specific token count
                    requestBody.thinkingBudget = budget ?? -1;
                    break;

                // OpenAI reasoning models don't need extra params - automatic
            }
        }

        try {
            const response = await fetch(`${this.config.apiBase}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: abortSignal // Add abort signal to fetch
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            if (onStream) {
                return await this.handleStreamResponse(response, onStream, abortSignal);
            } else {
                return await this.handleResponse(response);
            }
        } catch (error) {
            // Handle abort specifically
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Request was aborted');
            }
            throw new Error(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleResponse(response: Response): Promise<string> {
        const data: LLMResponse = await response.json();

        if (!data.choices || data.choices.length === 0) {
            throw new Error('No response from API - the model returned an empty response');
        }

        const content = data.choices[0].message.content;

        if (!content || content.trim() === '') {
            throw new Error('Empty response from API - the model did not generate any content. This may indicate rate limiting, token exhaustion, or model configuration issues.');
        }

        return content;
    }

    private async handleStreamResponse(
        response: Response,
        onStream: (chunk: string) => void,
        abortSignal?: AbortSignal
    ): Promise<string> {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = ''; // Buffer to handle partial lines

        try {
            while (true) {
                // Check if aborted before reading
                if (abortSignal?.aborted) {
                    throw new Error('Stream reading aborted');
                }

                const { done, value } = await reader.read();
                if (done) break;

                // Decode the chunk and add to buffer
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Split by newlines but keep the last partial line in buffer
                const lines = buffer.split('\n');
                // Keep the last line in buffer if it doesn't end with newline
                buffer = lines.pop() || '';

                for (const line of lines) {
                    // Skip empty lines
                    if (line.trim() === '') continue;

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();

                        if (data === '[DONE]') {
                            continue;
                        }

                        // Skip empty data
                        if (!data) continue;

                        try {
                            const parsed: LLMStreamChunk = JSON.parse(data);
                            const delta = parsed.choices[0]?.delta;

                            if (!delta) continue;

                            // Universal thinking token filter for all providers
                            // Skip reasoning/thinking tokens, only process visible content

                            // 1. DeepSeek: Has separate reasoning_content field
                            if ('reasoning_content' in delta && delta.reasoning_content) {
                                // Skip - this is internal thinking
                                continue;
                            }

                            // 2. Anthropic: Content blocks may have type="thinking"
                            if (delta.type === 'thinking') {
                                // Skip - this is thinking content
                                continue;
                            }

                            // 3. Process visible content (works for all providers)
                            if ('content' in delta && delta.content) {
                                fullContent += delta.content;
                                onStream(delta.content);
                            }
                        } catch (parseError) {
                            // Log more detailed error info for debugging
                            console.warn('Failed to parse stream chunk:', {
                                error: parseError,
                                data: data.substring(0, 200), // First 200 chars for debugging
                                dataLength: data.length
                            });
                        }
                    }
                }
            }

            // Process any remaining data in buffer
            if (buffer.trim() && buffer.startsWith('data: ')) {
                const data = buffer.slice(6).trim();
                if (data && data !== '[DONE]') {
                    try {
                        const parsed: LLMStreamChunk = JSON.parse(data);
                        const delta = parsed.choices[0]?.delta;

                        if (delta) {
                            // Universal thinking token filter
                            // Skip DeepSeek reasoning_content
                            if ('reasoning_content' in delta && delta.reasoning_content) {
                                return fullContent;
                            }

                            // Skip Anthropic thinking type
                            if (delta.type === 'thinking') {
                                return fullContent;
                            }

                            // Process visible content
                            if ('content' in delta && delta.content) {
                                fullContent += delta.content;
                                onStream(delta.content);
                            }
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse final buffer chunk:', {
                            error: parseError,
                            data: data.substring(0, 200)
                        });
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        // Validate that we received some content
        if (!fullContent || fullContent.trim() === '') {
            throw new Error('Empty response from streaming API - the model did not generate any content. This may indicate rate limiting, token exhaustion, or model configuration issues.');
        }

        return fullContent;
    }

    public async testConnection(): Promise<boolean> {
        try {
            await this.sendMessage([
                {
                    role: 'user',
                    content: 'Hello',
                    timestamp: Date.now()
                }
            ]);
            return true;
        } catch (error) {
            console.error('Connection test failed:', error);
            return false;
        }
    }
}
