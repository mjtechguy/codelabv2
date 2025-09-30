export interface QuizQuestion {
    id: string;
    question: string;
    options: QuizOption[];
    type: 'multiple-choice' | 'text';
    multipleAnswers?: boolean;
    answerKey?: string;
}

export interface QuizOption {
    label: string;  // A, B, C, D
    text: string;   // The actual option text
}

export interface Answer {
    correct: string | string[];
    explanation?: string;
    hints?: string[];
    alternatives?: string[];
    caseSensitive?: boolean;
    points?: number;
}

export interface AnswerKey {
    version: string;
    answers: { [questionId: string]: Answer };
    settings?: {
        showExplanations?: boolean;
        allowRetry?: boolean;
        showScore?: boolean;
    };
}

export interface QuizResult {
    questionId: string;
    correct: boolean;
    explanation?: string;
    correctAnswer?: string | string[];
}

export interface QuizState {
    answeredQuestions: Set<string>;
    scores: Map<string, boolean>;
    attempts: Map<string, number>;
}