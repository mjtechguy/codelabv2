import { ModelConfig, LLMRequest, LLMResponse, LLMStreamChunk, ChatMessage } from '../types/chat';

export class LLMClient {
    private config: ModelConfig;

    constructor(config: ModelConfig) {
        this.config = config;
    }

    /**
     * Check if the model is a reasoning model (o1, o3-mini, gpt-5, etc.)
     * These models use max_completion_tokens instead of max_tokens
     */
    private isReasoningModel(modelName: string): boolean {
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

    public async sendMessage(
        messages: ChatMessage[],
        onStream?: (chunk: string) => void,
        abortSignal?: AbortSignal
    ): Promise<string> {
        const isReasoning = this.isReasoningModel(this.config.model);

        const requestBody: LLMRequest = {
            model: this.config.model,
            messages: messages.map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            temperature: this.config.temperature ?? 0.7,
            stream: !!onStream
        };

        // Use max_completion_tokens for reasoning models, max_tokens for others
        if (isReasoning) {
            (requestBody as any).max_completion_tokens = this.config.maxTokens ?? 2000;
        } else {
            requestBody.max_tokens = this.config.maxTokens ?? 2000;
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
            throw new Error('No response from API');
        }

        return data.choices[0].message.content;
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

                            // Skip reasoning tokens - only process actual content
                            // Reasoning tokens come in delta.reasoning_content
                            // We only want delta.content (visible output)
                            if (delta && 'content' in delta && delta.content) {
                                fullContent += delta.content;
                                onStream(delta.content);
                            }
                            // Ignore reasoning_content silently - these are internal thinking tokens
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

                        // Only process visible content, skip reasoning tokens
                        if (delta && 'content' in delta && delta.content) {
                            fullContent += delta.content;
                            onStream(delta.content);
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
