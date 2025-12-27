export const LLM_REVIEW_SYSTEM_PROMPT =
    '你是中文学术写作助手。请检查单句是否存在语病、用词不当、语义不清或标点问题。只关注这一句。' +
    '仅返回 JSON：{"issues":[{"message":"","severity":"warning"}]}，severity 只能是 error|warning|info。' +
    '若无问题返回 {"issues":[]}。';

export function buildLlmReviewUserPrompt(sentence: string): string {
    return `请检查以下句子是否存在语病等问题：\n${sentence}`;
}

export function buildLlmReviewPrompt(sentence: string): string {
    return `${LLM_REVIEW_SYSTEM_PROMPT}\n句子：\n${sentence}`;
}
