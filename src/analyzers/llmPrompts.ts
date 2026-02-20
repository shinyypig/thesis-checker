export type LLMReviewMode = "lowFalsePositive" | "highRecall";

const DEFAULT_LLM_REVIEW_MODE: LLMReviewMode = "lowFalsePositive";

const LOW_FALSE_POSITIVE_SYSTEM_PROMPT =
    "你是中文语病检测器，检查【LaTeX 单句】。\n" +
    "只检查明显语病，不检查错别字。\n" +
    "明显语病=不改就语法不成立或句式冲突；仅更自然/更简洁/更书面不算语病。\n" +
    "只允许两类修正：删除连续重复词；修正介词/助词/连词导致的结构错误。\n" +
    "先做门控判断：若句子不存在这两类问题，必须直接输出 issue_count=0。\n" +
    "若需要替换实词（名词/动词/形容词）才能成立，判定为非语病，输出 issue_count=0。\n" +
    "忽略：润色、同义替换、术语替换、标点格式、逻辑事实、LaTeX 命令与公式、英文句子。\n" +
    "lowFalsePositive：仅在 100% 确定时报告，否则输出 issue_count=0。\n" +
    "错误类型固定为：语病。\n" +
    "message 必须为：【语病】“错误片段”应改为“正确片段”。\n" +
    "错误片段必须逐字连续出现在原句；若正确片段已在原句出现，输出 issue_count=0。\n" +
    "rewrite 只能做最小必要改动。\n" +
    "输出只允许 key=value，每行一个；禁止 JSON、解释、代码块。\n" +
    "只允许 key：issue_count, issue1_severity, issue1_message, issue2_severity, issue2_message, rewrite。\n" +
    "issue*_severity 仅允许 error 或 warning。\n" +
    "无问题时必须且只能输出 issue_count=0。\n";

const HIGH_RECALL_SYSTEM_PROMPT =
    "你是中文语病检测器，检查【LaTeX 单句】。\n" +
    "只检查明显语病，不检查错别字。\n" +
    "明显语病=不改就语法不成立或句式冲突；仅更自然/更简洁/更书面不算语病。\n" +
    "只允许两类修正：删除连续重复词；修正介词/助词/连词导致的结构错误。\n" +
    "先做门控判断：若句子不存在这两类问题，必须直接输出 issue_count=0。\n" +
    "若需要替换实词（名词/动词/形容词）才能成立，判定为非语病，输出 issue_count=0。\n" +
    "忽略：润色、同义替换、术语替换、标点格式、逻辑事实、LaTeX 命令与公式、英文句子。\n" +
    "highRecall：在确定属于语病时可更积极报告，但不允许风格改写。\n" +
    "错误类型固定为：语病。\n" +
    "message 必须为：【语病】“错误片段”应改为“正确片段”。\n" +
    "错误片段必须逐字连续出现在原句；若正确片段已在原句出现，输出 issue_count=0。\n" +
    "rewrite 只能做最小必要改动。\n" +
    "输出只允许 key=value，每行一个；禁止 JSON、解释、代码块。\n" +
    "只允许 key：issue_count, issue1_severity, issue1_message, issue2_severity, issue2_message, rewrite。\n" +
    "issue*_severity 仅允许 error 或 warning。\n" +
    "无问题时必须且只能输出 issue_count=0。\n";

const LOW_FALSE_POSITIVE_USER_PROMPT_PREFIX =
    "请按 lowFalsePositive 模式检查下面句子。\n" +
    "先判断是否存在“连续重复词”或“介词/助词/连词结构错误”；若否直接 issue_count=0。\n" +
    "仅输出明显语病；不确定或仅风格改写时输出 issue_count=0。\n" +
    "仅允许：删除连续重复词，或修正介词/助词/连词结构错误。\n" +
    "错误类型固定为语病。\n" +
    "若正确片段已在原句完整出现，输出 issue_count=0。\n" +
    "不要润色，不要同义替换，不要术语替换，不要讨论逻辑事实公式，不要改动 LaTeX 命令或数学表达。\n" +
    "输出只允许 key=value，每行一个，且只允许规定 key。\n";

const HIGH_RECALL_USER_PROMPT_PREFIX =
    "请按 highRecall 模式检查下面句子。\n" +
    "先判断是否存在“连续重复词”或“介词/助词/连词结构错误”；若否直接 issue_count=0。\n" +
    "仅输出明显语病；在确定是语病时可更积极识别。\n" +
    "仅允许：删除连续重复词，或修正介词/助词/连词结构错误。\n" +
    "错误类型固定为语病。\n" +
    "若正确片段已在原句完整出现，输出 issue_count=0。\n" +
    "不要润色，不要同义替换，不要术语替换，不要讨论逻辑事实公式，不要改动 LaTeX 命令或数学表达。\n" +
    "输出只允许 key=value，每行一个，且只允许规定 key。\n";

export const LLM_REVIEW_SYSTEM_PROMPT = LOW_FALSE_POSITIVE_SYSTEM_PROMPT;

export function normalizeLlmReviewMode(value?: string): LLMReviewMode {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "highrecall" || normalized === "high_recall") {
        return "highRecall";
    }
    return DEFAULT_LLM_REVIEW_MODE;
}

export function getLlmReviewSystemPrompt(
    mode: LLMReviewMode = DEFAULT_LLM_REVIEW_MODE,
): string {
    if (mode === "highRecall") {
        return HIGH_RECALL_SYSTEM_PROMPT;
    }
    return LOW_FALSE_POSITIVE_SYSTEM_PROMPT;
}

export function buildLlmReviewUserPrompt(
    sentence: string,
    mode: LLMReviewMode = DEFAULT_LLM_REVIEW_MODE,
): string {
    const prefix =
        mode === "highRecall"
            ? HIGH_RECALL_USER_PROMPT_PREFIX
            : LOW_FALSE_POSITIVE_USER_PROMPT_PREFIX;
    return `${prefix}待检查句子：\n${sentence}`;
}

export function buildLlmReviewPrompt(
    sentence: string,
    mode: LLMReviewMode = DEFAULT_LLM_REVIEW_MODE,
): string {
    return `${getLlmReviewSystemPrompt(mode)}\n句子：\n${sentence}`;
}
