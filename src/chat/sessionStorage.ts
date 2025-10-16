import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatSession } from '../types/chat';

/**
 * Handles persistent file-based storage for chat sessions
 * Uses VS Code's globalStorageUri for reliable, persistent storage
 */
export class SessionStorage {
    private storageDir: string;

    constructor(private context: vscode.ExtensionContext) {
        this.storageDir = context.globalStorageUri.fsPath;
    }

    /**
     * Ensure storage directory exists
     */
    private async ensureStorageDir(): Promise<void> {
        try {
            await fs.mkdir(this.storageDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create storage directory:', error);
            throw new Error(`Storage initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get file path for a session
     */
    private getSessionFilePath(sessionId: string): string {
        return path.join(this.storageDir, `session_${sessionId}.json`);
    }

    /**
     * Save a session to disk using atomic write
     * Writes to temp file first, then renames to prevent corruption
     */
    public async saveSession(session: ChatSession): Promise<void> {
        await this.ensureStorageDir();

        const filePath = this.getSessionFilePath(session.id);
        const tempPath = `${filePath}.tmp`;

        try {
            // Write to temporary file first
            const json = JSON.stringify(session, null, 2);
            await fs.writeFile(tempPath, json, 'utf-8');

            // Atomic rename - prevents corruption if interrupted
            await fs.rename(tempPath, filePath);
        } catch (error) {
            // Clean up temp file if it exists
            try {
                await fs.unlink(tempPath);
            } catch {
                // Ignore cleanup errors
            }

            console.error(`❌ Failed to save session ${session.id}:`, error);
            throw new Error(`Failed to save chat session: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Load a session from disk
     */
    public async loadSession(sessionId: string): Promise<ChatSession | null> {
        const filePath = this.getSessionFilePath(sessionId);

        try {
            const json = await fs.readFile(filePath, 'utf-8');
            const session = JSON.parse(json) as ChatSession;
            return session;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File doesn't exist - not an error
                return null;
            }

            console.error(`❌ Failed to load session ${sessionId}:`, error);
            // Try to return null instead of throwing to allow recovery
            return null;
        }
    }

    /**
     * Delete a session file from disk
     */
    public async deleteSession(sessionId: string): Promise<boolean> {
        const filePath = this.getSessionFilePath(sessionId);

        try {
            await fs.unlink(filePath);
            return true;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File doesn't exist - consider it deleted
                return true;
            }

            console.error(`Failed to delete session ${sessionId}:`, error);
            return false;
        }
    }

    /**
     * Get all session IDs from storage directory
     */
    public async getAllSessionIds(): Promise<string[]> {
        try {
            await this.ensureStorageDir();
            const files = await fs.readdir(this.storageDir);

            const sessionIds: string[] = [];
            for (const file of files) {
                if (file.startsWith('session_') && file.endsWith('.json')) {
                    // Extract session ID from filename
                    const id = file.substring(8, file.length - 5); // Remove "session_" and ".json"
                    sessionIds.push(id);
                }
            }

            return sessionIds;
        } catch (error) {
            console.error('❌ Failed to list sessions:', error);
            return [];
        }
    }

    /**
     * Load all sessions from disk
     * Warning: Can be slow with many sessions - use lazy loading when possible
     */
    public async loadAllSessions(): Promise<ChatSession[]> {
        const sessionIds = await this.getAllSessionIds();
        const sessions: ChatSession[] = [];

        for (const id of sessionIds) {
            const session = await this.loadSession(id);
            if (session) {
                sessions.push(session);
            }
        }

        return sessions;
    }

    /**
     * Check if a session file exists
     */
    public async sessionExists(sessionId: string): Promise<boolean> {
        const filePath = this.getSessionFilePath(sessionId);

        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get storage directory path (for debugging)
     */
    public getStorageDir(): string {
        return this.storageDir;
    }
}
