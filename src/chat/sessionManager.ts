import * as vscode from 'vscode';
import { ChatSession, ChatMessage } from '../types/chat';

export class SessionManager {
    private static readonly STORAGE_KEY = 'vslabsai.chatSessions';
    private static readonly ACTIVE_SESSION_KEY = 'vslabsai.activeChatSession';
    private sessions: Map<string, ChatSession> = new Map();
    private activeSessionId: string | null = null;
    private context: vscode.ExtensionContext | null = null;

    /**
     * Initialize the session manager with extension context for persistence
     */
    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        this.loadSessions();
    }

    /**
     * Load sessions from persistent storage
     */
    private loadSessions(): void {
        if (!this.context) return;

        const storedSessions = this.context.globalState.get<ChatSession[]>(SessionManager.STORAGE_KEY, []);
        const storedActiveId = this.context.globalState.get<string | null>(SessionManager.ACTIVE_SESSION_KEY, null);

        this.sessions.clear();
        for (const session of storedSessions) {
            this.sessions.set(session.id, session);
        }

        this.activeSessionId = storedActiveId;

        // If we have sessions but no active session, set the first one as active
        if (this.sessions.size > 0 && !this.activeSessionId) {
            const firstSession = Array.from(this.sessions.values())[0];
            this.activeSessionId = firstSession.id;
            this.saveSessions();
        }
    }

    /**
     * Save sessions to persistent storage
     */
    private saveSessions(): void {
        if (!this.context) return;

        const sessionsArray = Array.from(this.sessions.values());
        this.context.globalState.update(SessionManager.STORAGE_KEY, sessionsArray);
        this.context.globalState.update(SessionManager.ACTIVE_SESSION_KEY, this.activeSessionId);
    }

    /**
     * Create a new chat session
     */
    public createSession(
        name: string,
        contextType: 'file' | 'folder' | 'workspace' | 'custom',
        contextUris: string[]
    ): ChatSession {
        const id = this.generateId();
        const session: ChatSession = {
            id,
            name,
            contextType,
            contextUris,
            messages: [],
            createdAt: Date.now()
        };

        this.sessions.set(id, session);
        this.activeSessionId = id;
        this.saveSessions(); // Save after creating

        return session;
    }

    /**
     * Get a session by ID
     */
    public getSession(id: string): ChatSession | undefined {
        return this.sessions.get(id);
    }

    /**
     * Get the active session
     */
    public getActiveSession(): ChatSession | undefined {
        return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    }

    /**
     * Set the active session
     */
    public setActiveSession(id: string): ChatSession | undefined {
        if (this.sessions.has(id)) {
            this.activeSessionId = id;
            this.saveSessions(); // Save after changing active session
            return this.sessions.get(id);
        }
        return undefined;
    }

    /**
     * Get all sessions
     */
    public getAllSessions(): ChatSession[] {
        return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Add a message to a session
     */
    public addMessage(sessionId: string, message: ChatMessage): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.messages.push(message);
            this.saveSessions(); // Save after adding message
        }
    }

    /**
     * Delete a session
     */
    public deleteSession(id: string): boolean {
        const deleted = this.sessions.delete(id);

        // If we deleted the active session, switch to most recent
        if (deleted && this.activeSessionId === id) {
            const sessions = this.getAllSessions();
            this.activeSessionId = sessions.length > 0 ? sessions[0].id : null;
        }

        if (deleted) {
            this.saveSessions(); // Save after deleting
        }

        return deleted;
    }

    /**
     * Clear all messages in a session
     */
    public clearSession(id: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.messages = [];
            this.saveSessions(); // Save after clearing
        }
    }

    /**
     * Update session context
     */
    public updateSessionContext(id: string, contextUris: string[], contextType: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.contextUris = contextUris;
            session.contextType = contextType as any;
            this.saveSessions(); // Save after updating context
        }
    }

    /**
     * Update implicit context (open files)
     */
    public updateImplicitContext(id: string, implicitUris: string[]): void {
        const session = this.sessions.get(id);
        if (session) {
            session.implicitContextUris = implicitUris;
            this.saveSessions(); // Save after updating implicit context
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
        return this.sessions.size;
    }
}
