import * as vscode from 'vscode';
import { ContextManager } from './contextManager';

export class SmartContextManager {
    // Token limits for different scenarios
    private static readonly MAX_TOKENS_OVERVIEW = 8000;  // For "explain project" type queries
    private static readonly MAX_TOKENS_SPECIFIC = 3000;  // For specific questions
    private static readonly CHARS_PER_TOKEN = 4;  // Rough estimate

    /**
     * Detect if the query is asking for a broad overview
     */
    private static isOverviewQuery(query: string): boolean {
        const overviewKeywords = [
            'explain this project',
            'overview',
            'what is this',
            'tell me about',
            'summarize',
            'what does this project do',
            'how does this work',
            'walk me through',
            'describe the project',
            'what are we building',
            'what is the tutorial about'
        ];

        const lowerQuery = query.toLowerCase();
        return overviewKeywords.some(keyword => lowerQuery.includes(keyword));
    }

    /**
     * Detect if the query is asking about a specific topic
     */
    private static extractKeywords(query: string): string[] {
        const words = query.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 3); // Filter short words

        // Remove common stop words
        const stopWords = ['what', 'where', 'when', 'how', 'does', 'this', 'that', 'with', 'from', 'about'];
        return words.filter(word => !stopWords.includes(word));
    }

    /**
     * Build smart context based on query type and available context
     */
    public static async buildSmartContext(
        contextUris: string[],
        contextType: string,
        userQuery?: string
    ): Promise<string> {
        // Load full context first
        const fullContext = await ContextManager.buildContextFromUris(contextUris, contextType);

        if (!fullContext) {
            return '';
        }

        // Calculate approximate token count
        const estimatedTokens = fullContext.length / this.CHARS_PER_TOKEN;

        // Determine if we need to filter based on query and size
        const isOverview = userQuery ? this.isOverviewQuery(userQuery) : false;
        const maxTokens = isOverview ? this.MAX_TOKENS_OVERVIEW : this.MAX_TOKENS_SPECIFIC;

        // If context is small enough, return it all
        if (estimatedTokens <= maxTokens) {
            return fullContext;
        }

        // Context is too large, need to be smart about it
        if (isOverview) {
            return this.buildOverviewContext(fullContext, contextUris, contextType);
        } else if (userQuery) {
            return this.buildFilteredContext(fullContext, userQuery, contextUris);
        } else {
            // No query yet (initial load), provide a summary
            return this.buildInitialContext(fullContext, contextUris);
        }
    }

    /**
     * Build context for overview queries
     * Includes: file list, main sections, key concepts
     */
    private static buildOverviewContext(
        fullContext: string,
        contextUris: string[],
        contextType: string
    ): string {
        const lines = fullContext.split('\n');
        const result: string[] = [];

        // Add header
        result.push(`# Project Overview (${contextUris.length} files)`);
        result.push('');

        // Extract main headings and first paragraph of each section
        let currentSection = '';
        let inSection = false;
        let paragraphCount = 0;

        for (const line of lines) {
            // Capture file names
            if (line.startsWith('## File:')) {
                result.push(line);
                currentSection = line;
                inSection = true;
                paragraphCount = 0;
                continue;
            }

            // Capture main headings (# or ##)
            if (line.match(/^#{1,2}\s/)) {
                result.push(line);
                inSection = true;
                paragraphCount = 0;
                continue;
            }

            // Capture first 2 paragraphs of each section
            if (inSection && line.trim() && !line.startsWith('#')) {
                if (paragraphCount < 2) {
                    result.push(line);
                    if (line.trim().length > 50) {
                        paragraphCount++;
                    }
                }
            }

            // Skip code blocks to save space
            if (line.startsWith('```')) {
                result.push('[Code example omitted for brevity]');
                // Skip until next ```
                let i = lines.indexOf(line) + 1;
                while (i < lines.length && !lines[i].startsWith('```')) {
                    i++;
                }
            }
        }

        result.push('');
        result.push('---');
        result.push('Note: This is a condensed overview. Ask specific questions to see detailed code and sections.');

        return result.join('\n');
    }

    /**
     * Build context for specific queries
     * Searches for relevant sections based on keywords
     */
    private static buildFilteredContext(
        fullContext: string,
        query: string,
        contextUris: string[]
    ): string {
        const keywords = this.extractKeywords(query);
        const lines = fullContext.split('\n');
        const result: string[] = [];

        result.push(`# Relevant Context for: "${query}"`);
        result.push('');

        // Find sections that match keywords
        const sections: string[] = [];
        let currentSection: string[] = [];
        let currentSectionRelevance = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Start new section on headings or file markers
            if (line.match(/^#{1,3}\s/) || line.startsWith('## File:')) {
                // Save previous section if relevant
                if (currentSection.length > 0 && currentSectionRelevance > 0) {
                    sections.push(currentSection.join('\n'));
                }

                currentSection = [line];
                currentSectionRelevance = 0;

                // Check if heading contains keywords
                const lowerLine = line.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerLine.includes(keyword)) {
                        currentSectionRelevance += 2;
                    }
                }
            } else {
                currentSection.push(line);

                // Check if line contains keywords
                const lowerLine = line.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerLine.includes(keyword)) {
                        currentSectionRelevance++;
                    }
                }
            }
        }

        // Don't forget last section
        if (currentSection.length > 0 && currentSectionRelevance > 0) {
            sections.push(currentSection.join('\n'));
        }

        // If we found relevant sections, use them
        if (sections.length > 0) {
            result.push(...sections);
            result.push('');
            result.push('---');
            result.push('Note: Showing relevant sections. Ask for specific files or topics to see more.');
        } else {
            // No specific matches, provide overview
            result.push('No specific matches found. Here\'s a brief overview:');
            result.push('');
            return this.buildOverviewContext(fullContext, contextUris, 'filtered');
        }

        // Limit total size
        const contextText = result.join('\n');
        const maxChars = this.MAX_TOKENS_SPECIFIC * this.CHARS_PER_TOKEN;

        if (contextText.length > maxChars) {
            return contextText.substring(0, maxChars) + '\n\n[Context truncated - ask more specific questions to see additional details]';
        }

        return contextText;
    }

    /**
     * Build initial context (when no query yet)
     * Just show file list and main headings
     */
    private static buildInitialContext(
        fullContext: string,
        contextUris: string[]
    ): string {
        const lines = fullContext.split('\n');
        const result: string[] = [];

        result.push(`# Tutorial Context (${contextUris.length} files loaded)`);
        result.push('');
        result.push('## Files in Context:');

        // Extract file names and main headings only
        for (const line of lines) {
            if (line.startsWith('## File:') || line.match(/^#{1,2}\s/)) {
                result.push(line);
            }
        }

        result.push('');
        result.push('---');
        result.push('Ask me anything about this tutorial! I can:');
        result.push('- Explain the overall project ("explain this project")');
        result.push('- Answer specific questions about sections or concepts');
        result.push('- Help with exercises and code examples');
        result.push('- Clarify commands and their usage');

        return result.join('\n');
    }

    /**
     * Estimate if context will fit within token limits
     */
    public static willContextFit(context: string, maxTokens: number): boolean {
        const estimatedTokens = context.length / this.CHARS_PER_TOKEN;
        return estimatedTokens <= maxTokens;
    }

    /**
     * Get appropriate context for a user message
     */
    public static async getContextForMessage(
        contextUris: string[],
        contextType: string,
        userMessage: string,
        conversationHistory: number
    ): Promise<string> {
        // Adjust max tokens based on conversation history
        const maxTokens = conversationHistory > 5
            ? this.MAX_TOKENS_SPECIFIC
            : this.MAX_TOKENS_OVERVIEW;

        return this.buildSmartContext(contextUris, contextType, userMessage);
    }
}
