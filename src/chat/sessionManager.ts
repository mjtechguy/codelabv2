import * as vscode from 'vscode';
import { ChatSession, ChatMessage, SessionMetadata } from '../types/chat';
import { SessionStorage } from './sessionStorage';

export class SessionManager {
    private static readonly INDEX_KEY = 'vslabsai.sessionIndex';
    private static readonly ACTIVE_SESSION_KEY = 'vslabsai.activeChatSession';
    private static readonly LEGACY_SESSIONS_KEY = 'vslabsai.chatSessions';

    private storage: SessionStorage | null = null;
    private sessionIndex: Map<string, SessionMetadata> = new Map();
    private sessionCache: Map<string, ChatSession> = new Map(); // LRU cache for loaded sessions
    private activeSessionId: string | null = null;
    private context: vscode.ExtensionContext | null = null;

    /**
     * Initialize the session manager with extension context for persistence
     */
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
        this.storage = new SessionStorage(context);

        // Load session index from globalState
        await this.loadIndex();

        // Migrate legacy sessions if needed
        await this.migrateLegacySessions();

        console.log(`✅ SessionManager initialized with ${this.sessionIndex.size} sessions`);
    }

    /**
     * Load the lightweight session index from globalState
     */
    private async loadIndex(): Promise<void> {
        if (!this.context) return;

        const storedIndex = this.context.globalState.get<SessionMetadata[]>(SessionManager.INDEX_KEY, []);
        const storedActiveId = this.context.globalState.get<string | null>(SessionManager.ACTIVE_SESSION_KEY, null);

        this.sessionIndex.clear();
        for (const metadata of storedIndex) {
            this.sessionIndex.set(metadata.id, metadata);
        }

        this.activeSessionId = storedActiveId;

        // If we have sessions but no active session, set the most recent one as active
        if (this.sessionIndex.size > 0 && !this.activeSessionId) {
            const sorted = Array.from(this.sessionIndex.values())
                .sort((a, b) => b.lastUpdated - a.lastUpdated);
            this.activeSessionId = sorted[0].id;
            await this.saveIndex();
        }
    }

    /**
     * Save the session index to globalState
     */
    private async saveIndex(): Promise<void> {
        if (!this.context) return;

        const indexArray = Array.from(this.sessionIndex.values());
        await this.context.globalState.update(SessionManager.INDEX_KEY, indexArray);
        await this.context.globalState.update(SessionManager.ACTIVE_SESSION_KEY, this.activeSessionId);
    }

    /**
     * Migrate sessions from old globalState storage to file-based storage
     */
    private async migrateLegacySessions(): Promise<void> {
        if (!this.context || !this.storage) return;

        const legacySessions = this.context.globalState.get<ChatSession[]>(SessionManager.LEGACY_SESSIONS_KEY);

        if (!legacySessions || legacySessions.length === 0) {
            return; // No legacy sessions to migrate
        }

        console.log(`🔄 Migrating ${legacySessions.length} legacy sessions to file-based storage...`);

        let migrated = 0;
        for (const session of legacySessions) {
            try {
                // Add metadata fields if missing
                if (!session.lastUpdated) {
                    session.lastUpdated = session.createdAt;
                }
                if (!session.version) {
                    session.version = 1;
                }

                // Save to file
                await this.storage.saveSession(session);

                // Add to index
                const metadata: SessionMetadata = {
                    id: session.id,
                    name: session.name,
                    createdAt: session.createdAt,
                    lastUpdated: session.lastUpdated,
                    messageCount: session.messages.length
                };
                this.sessionIndex.set(session.id, metadata);

                migrated++;
            } catch (error) {
                console.error(`Failed to migrate session ${session.id}:`, error);
            }
        }

        if (migrated > 0) {
            // Save the new index
            await this.saveIndex();

            // Clear legacy storage
            await this.context.globalState.update(SessionManager.LEGACY_SESSIONS_KEY, undefined);

            console.log(`✅ Successfully migrated ${migrated} sessions`);
            vscode.window.showInformationMessage(`Migrated ${migrated} chat sessions to improved storage`);
        }
    }

    /**
     * Create a new chat session
     */
    public async createSession(
        name: string,
        contextType: 'file' | 'folder' | 'workspace' | 'custom',
        contextUris: string[]
    ): Promise<ChatSession> {
        const id = this.generateId();
        const now = Date.now();

        const session: ChatSession = {
            id,
            name,
            contextType,
            contextUris,
            messages: [],
            createdAt: now,
            lastUpdated: now,
            version: 1
        };

        // Save session to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Add to index
        const metadata: SessionMetadata = {
            id,
            name,
            createdAt: now,
            lastUpdated: now,
            messageCount: 0
        };
        this.sessionIndex.set(id, metadata);

        // Add to cache
        this.sessionCache.set(id, session);

        // Set as active
        this.activeSessionId = id;
        await this.saveIndex();

        return session;
    }

    /**
     * Get a session by ID (loads from file if not cached)
     */
    public async getSession(id: string): Promise<ChatSession | undefined> {
        // Check cache first
        if (this.sessionCache.has(id)) {
            return this.sessionCache.get(id);
        }

        // Load from file
        if (!this.storage) return undefined;

        const session = await this.storage.loadSession(id);
        if (session) {
            // Add to cache (LRU-style, limit cache size)
            this.sessionCache.set(id, session);
            if (this.sessionCache.size > 10) {
                // Remove oldest cached session (not active session)
                for (const [cachedId, _] of this.sessionCache) {
                    if (cachedId !== this.activeSessionId) {
                        this.sessionCache.delete(cachedId);
                        break;
                    }
                }
            }
        }

        return session || undefined;
    }

    /**
     * Get the active session
     */
    public async getActiveSession(): Promise<ChatSession | undefined> {
        if (!this.activeSessionId) return undefined;
        return await this.getSession(this.activeSessionId);
    }

    /**
     * Set the active session
     */
    public async setActiveSession(id: string): Promise<ChatSession | undefined> {
        if (this.sessionIndex.has(id)) {
            this.activeSessionId = id;
            await this.saveIndex();
            return await this.getSession(id);
        }
        return undefined;
    }

    /**
     * Get all session metadata (lightweight, no message loading)
     */
    public getAllSessionMetadata(): SessionMetadata[] {
        return Array.from(this.sessionIndex.values())
            .sort((a, b) => b.lastUpdated - a.lastUpdated);
    }

    /**
     * Get all sessions (for compatibility - use getAllSessionMetadata for better performance)
     * Warning: Loads all sessions from disk - can be slow
     */
    public async getAllSessions(): Promise<ChatSession[]> {
        const sessions: ChatSession[] = [];

        for (const metadata of this.sessionIndex.values()) {
            const session = await this.getSession(metadata.id);
            if (session) {
                sessions.push(session);
            }
        }

        return sessions.sort((a, b) => (b.lastUpdated || b.createdAt) - (a.lastUpdated || a.createdAt));
    }

    /**
     * Add a message to a session
     */
    public async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) return;

        session.messages.push(message);
        session.lastUpdated = Date.now();

        // Save to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Update index
        const metadata = this.sessionIndex.get(sessionId);
        if (metadata) {
            metadata.lastUpdated = session.lastUpdated;
            metadata.messageCount = session.messages.length;
            await this.saveIndex();
        }
    }

    /**
     * Delete a session
     */
    public async deleteSession(id: string): Promise<boolean> {
        // Remove from index
        this.sessionIndex.delete(id);

        // Remove from cache
        this.sessionCache.delete(id);

        // Delete file
        let deleted = false;
        if (this.storage) {
            deleted = await this.storage.deleteSession(id);
        }

        // If we deleted the active session, switch to most recent
        if (this.activeSessionId === id) {
            const sessions = this.getAllSessionMetadata();
            this.activeSessionId = sessions.length > 0 ? sessions[0].id : null;
        }

        await this.saveIndex();

        return deleted;
    }

    /**
     * Clear all messages in a session
     */
    public async clearSession(id: string): Promise<void> {
        const session = await this.getSession(id);
        if (!session) return;

        session.messages = [];
        session.lastUpdated = Date.now();

        // Save to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Update index
        const metadata = this.sessionIndex.get(id);
        if (metadata) {
            metadata.lastUpdated = session.lastUpdated;
            metadata.messageCount = 0;
            await this.saveIndex();
        }
    }

    /**
     * Update session context
     */
    public async updateSessionContext(id: string, contextUris: string[], contextType: string): Promise<void> {
        const session = await this.getSession(id);
        if (!session) return;

        session.contextUris = contextUris;
        session.contextType = contextType as any;
        session.lastUpdated = Date.now();

        // Save to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Update index timestamp
        const metadata = this.sessionIndex.get(id);
        if (metadata) {
            metadata.lastUpdated = session.lastUpdated;
            await this.saveIndex();
        }
    }

    /**
     * Update implicit context (open files)
     */
    public async updateImplicitContext(id: string, implicitUris: string[]): Promise<void> {
        const session = await this.getSession(id);
        if (!session) return;

        session.implicitContextUris = implicitUris;
        session.lastUpdated = Date.now();

        // Save to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Update index timestamp
        const metadata = this.sessionIndex.get(id);
        if (metadata) {
            metadata.lastUpdated = session.lastUpdated;
            await this.saveIndex();
        }
    }

    /**
     * Rename a session
     */
    public async renameSession(id: string, newName: string): Promise<void> {
        const session = await this.getSession(id);
        if (!session) return;

        session.name = newName;
        session.lastUpdated = Date.now();

        // Save to file
        if (this.storage) {
            await this.storage.saveSession(session);
        }

        // Update index
        const metadata = this.sessionIndex.get(id);
        if (metadata) {
            metadata.name = newName;
            metadata.lastUpdated = session.lastUpdated;
            await this.saveIndex();
        }
    }

    /**
     * Generate unique session ID
     */
    private generateId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get session count
     */
    public getSessionCount(): number {
        return this.sessionIndex.size;
    }

    /**
     * Get storage directory (for debugging)
     */
    public getStorageDir(): string | null {
        return this.storage?.getStorageDir() || null;
    }
}
