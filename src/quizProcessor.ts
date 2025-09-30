import { QuizQuestion, QuizOption } from './types/quiz';

export class QuizProcessor {
    private quizCounter: number = 0;

    resetCounter(): void {
        this.quizCounter = 0;
    }

    parseQuizBlock(content: string, explicitId?: string, answerKey?: string): QuizQuestion | null {
        const lines = content.trim().split('\n').filter(line => line.trim());

        if (lines.length < 2) return null;

        // Extract question (first line starting with Q: or just the first line)
        let question = lines[0];
        if (question.startsWith('Q:')) {
            question = question.substring(2).trim();
        }

        // Extract options (lines starting with A), B), C), etc.)
        const options: QuizOption[] = [];
        const optionRegex = /^([A-Z])\)\s*(.+)$/;

        for (let i = 1; i < lines.length; i++) {
            const match = lines[i].match(optionRegex);
            if (match) {
                options.push({
                    label: match[1],
                    text: match[2].trim()
                });
            }
        }

        if (options.length < 2) return null;

        // Generate ID
        const id = explicitId || `quiz_${this.quizCounter++}`;

        return {
            id,
            question,
            options,
            type: 'multiple-choice',
            answerKey
        };
    }

    parseInlineQuiz(question: string, explicitId?: string, answerKey?: string): QuizQuestion {
        const id = explicitId || `quiz_${this.quizCounter++}`;

        return {
            id,
            question,
            options: [], // For text input style quiz
            type: 'text',
            answerKey
        };
    }

    generateQuizHTML(quiz: QuizQuestion): string {
        if (quiz.type === 'multiple-choice') {
            return this.generateMultipleChoiceHTML(quiz);
        } else {
            return this.generateTextInputHTML(quiz);
        }
    }

    private generateMultipleChoiceHTML(quiz: QuizQuestion): string {
        const optionsHTML = quiz.options.map(option => `
            <label class="quiz-option">
                <input type="radio" name="${quiz.id}" value="${option.label}" />
                <span class="option-label">${option.label})</span>
                <span class="option-text">${this.escapeHtml(option.text)}</span>
            </label>
        `).join('');

        const answerKeyAttr = quiz.answerKey ? ` data-answer-key="${this.escapeHtml(quiz.answerKey)}"` : '';

        return `
            <div class="quiz-container" data-quiz-id="${quiz.id}"${answerKeyAttr}>
                <div class="quiz-question">
                    <span class="quiz-icon">❔</span>
                    ${this.escapeHtml(quiz.question)}
                </div>
                <div class="quiz-options">
                    ${optionsHTML}
                </div>
                <div class="quiz-actions">
                    <button class="quiz-check-btn" data-quiz-id="${quiz.id}">Check Answer</button>
                    <button class="quiz-show-btn" data-quiz-id="${quiz.id}" style="display:none;">Show Answer</button>
                    <button class="quiz-reset-btn" data-quiz-id="${quiz.id}" style="display:none;">Try Again</button>
                </div>
                <div class="quiz-feedback" id="feedback-${quiz.id}"></div>
            </div>
        `;
    }

    private generateTextInputHTML(quiz: QuizQuestion): string {
        const answerKeyAttr = quiz.answerKey ? ` data-answer-key="${this.escapeHtml(quiz.answerKey)}"` : '';

        return `
            <div class="quiz-container quiz-inline" data-quiz-id="${quiz.id}"${answerKeyAttr}>
                <div class="quiz-question-inline">
                    <span class="quiz-icon">❔</span>
                    ${this.escapeHtml(quiz.question)}
                </div>
                <div class="quiz-input-group">
                    <input type="text"
                           class="quiz-text-input"
                           id="input-${quiz.id}"
                           placeholder="Type your answer..." />
                    <button class="quiz-check-btn quiz-check-inline" data-quiz-id="${quiz.id}">Check</button>
                </div>
                <div class="quiz-feedback-inline" id="feedback-${quiz.id}"></div>
            </div>
        `;
    }

    extractQuizId(htmlBlock: string): string | null {
        const match = htmlBlock.match(/id=["']([^"']+)["']/);
        return match ? match[1] : null;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}