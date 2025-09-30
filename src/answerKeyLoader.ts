import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';
import { AnswerKey, Answer } from './types/quiz';

export class AnswerKeyLoader {
    private answerKeys: Map<string, AnswerKey> = new Map();

    async loadAnswerKey(mdclUri: vscode.Uri, customName?: string): Promise<AnswerKey | null> {
        const mdclPath = mdclUri.fsPath;
        const cacheKey = customName ? `${mdclPath}:${customName}` : mdclPath;

        // Check cache first
        if (this.answerKeys.has(cacheKey)) {
            return this.answerKeys.get(cacheKey)!;
        }

        let possiblePaths: string[];

        if (customName) {
            // Use custom answer key filename
            const dir = path.dirname(mdclPath);
            possiblePaths = [
                path.join(dir, `${customName}.yaml`),
                path.join(dir, `${customName}.yml`),
                path.join(dir, customName),
            ];
        } else {
            // Use default answer key locations
            possiblePaths = [
                mdclPath.replace('.mdcl', '.mdclanswer.yaml'),
                mdclPath.replace('.mdcl', '.mdclanswer.yml'),
                mdclPath.replace('.mdcl', '.mdclanswer'),
            ];
        }

        for (const answerPath of possiblePaths) {
            if (fs.existsSync(answerPath)) {
                try {
                    const content = fs.readFileSync(answerPath, 'utf8');
                    const answerKey = this.parseAnswerKey(content, answerPath);

                    if (answerKey) {
                        this.answerKeys.set(cacheKey, answerKey);
                        console.log(`Loaded answer key from: ${answerPath}`);
                        return answerKey;
                    }
                } catch (error) {
                    console.error(`Error loading answer key from ${answerPath}:`, error);
                }
            }
        }

        console.log(`No answer key found for: ${mdclPath}${customName ? ` (custom: ${customName})` : ''}`);
        return null;
    }

    private parseAnswerKey(content: string, filePath: string): AnswerKey | null {
        try {
            // Try parsing as YAML
            if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
                return yaml.parse(content) as AnswerKey;
            }

            // Try parsing as plain YAML without extension
            try {
                return yaml.parse(content) as AnswerKey;
            } catch {
                // If YAML fails, try JSON as fallback
                return JSON.parse(content) as AnswerKey;
            }
        } catch (error) {
            console.error('Error parsing answer key:', error);
            return null;
        }
    }

    validateAnswer(questionId: string, userAnswer: string | string[], answerKey: AnswerKey | null): {
        correct: boolean;
        explanation?: string;
        correctAnswer?: string | string[];
    } {
        if (!answerKey || !answerKey.answers[questionId]) {
            return { correct: false, explanation: 'No answer key found for this question' };
        }

        const answer = answerKey.answers[questionId];
        let correct = false;

        // Normalize answers for comparison
        const normalizeAnswer = (ans: string): string => {
            if (answer.caseSensitive === false) {
                return ans.toLowerCase().trim();
            }
            return ans.trim();
        };

        // Handle single or multiple correct answers
        const correctAnswers = Array.isArray(answer.correct) ? answer.correct : [answer.correct];
        const userAnswers = Array.isArray(userAnswer) ? userAnswer : [userAnswer];

        // Check main correct answers
        if (Array.isArray(answer.correct)) {
            // For multiple correct answers, check if user selected all correct ones
            const normalizedCorrect = correctAnswers.map(normalizeAnswer);
            const normalizedUser = userAnswers.map(normalizeAnswer);
            correct = normalizedCorrect.length === normalizedUser.length &&
                      normalizedCorrect.every(ans => normalizedUser.includes(ans));
        } else {
            // For single answer, check if it matches
            const normalizedUser = normalizeAnswer(userAnswers[0]);
            const normalizedCorrect = normalizeAnswer(answer.correct);
            correct = normalizedUser === normalizedCorrect;

            // Check alternatives if main answer didn't match
            if (!correct && answer.alternatives) {
                const normalizedAlts = answer.alternatives.map(normalizeAnswer);
                correct = normalizedAlts.includes(normalizedUser);
            }
        }

        return {
            correct,
            explanation: answer.explanation,
            correctAnswer: answer.correct
        };
    }

    clearCache(mdclPath?: string): void {
        if (mdclPath) {
            this.answerKeys.delete(mdclPath);
        } else {
            this.answerKeys.clear();
        }
    }
}