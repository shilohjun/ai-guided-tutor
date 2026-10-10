/**
 * 学生可见消息的组装。
 *
 * 为什么把"组装"单独抽出来：
 *   提示文本本身合格，不等于"学生看到的整条消息"合格。
 *   复述、提示、下一步动作三段拼在一起后可能出现
 *   ① 语义重复（复述已经问了问题，提示又问一遍）
 *   ② 语气割裂（复述很长、提示很短）
 *   ③ 隐性泄题（复述里带出了诊断细节，如"你错在没检查前提"——  这等于告诉了他一部分答案）
 *   因此组装层也要做一次约束检查：诊断细节不出现在学生可见文本里。
 */

import { normalize } from './text.js';

/** 诊断内部信息中绝不能出现在学生可见文本里的措辞 */
const INTERNAL_LEAK_MARKERS = [
  '错因',
  'misconception',
  '卡点性质',
  'confidence',
  '置信',
  '定位到第',
  '路径图谱',
  'precondition_gap',
  'direction_lost',
  'execution_error',
  'knowledge_gap',
];

/**
 * @param {import('./types.js').Diagnosis} diagnosis
 * @param {import('./types.js').Hint} hint
 * @returns {string} 学生可见的完整消息
 */
export function composeStudentMessage(diagnosis, hint) {
  const segments = [];

  const restatement = safeRestatement(diagnosis.restatement, hint);
  if (restatement) segments.push(restatement);

  segments.push(hint.text.trim());

  const nextAsk = hint.nextAsk?.trim();
  if (nextAsk && !isRedundant(nextAsk, segments)) {
    segments.push(`👉 ${nextAsk}`);
  }

  const message = segments.join('\n\n');
  return sanitizeVisible(message);
}

function safeRestatement(restatement, hint) {
  if (!restatement) return null;
  let r = restatement.trim();

  // 复述与提示高度重合 ⇒ 丢掉复述，避免"问了两次同样的问题"
  if (isRedundant(r, [hint.text])) return null;

  // 复述里若含内部术语，直接丢弃（宁可少说，不可泄题/暴露诊断）
  if (INTERNAL_LEAK_MARKERS.some((m) => r.toLowerCase().includes(m.toLowerCase()))) {
    r = r.replace(/我感觉问题可能不在算，而在某个规律的前提条件上。?/g, '');
  }
  return r.trim() || null;
}

/** 粗略判重：字符集合重合率 > 0.6 视为重复 */
function isRedundant(candidate, existing) {
  const set = new Set(normalize(candidate).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').split(''));
  if (set.size < 8) return false;
  return existing.some((text) => {
    const other = new Set(normalize(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').split(''));
    if (other.size < 8) return false;
    let inter = 0;
    for (const c of set) if (other.has(c)) inter += 1;
    return inter / Math.min(set.size, other.size) > 0.6;
  });
}

/** 出口清洗：防止内部标记意外进入学生可见文本 */
export function sanitizeVisible(text) {
  let out = String(text);
  for (const marker of INTERNAL_LEAK_MARKERS) {
    // 只在标记出现在"括号内说明"时清理，避免误伤正常用词（如"错因"一般不会出现在提示里）
    out = out.replace(new RegExp(`（[^）]*${escapeRe(marker)}[^）]*）`, 'g'), '');
    out = out.replace(new RegExp(`\\([^)]*${escapeRe(marker)}[^)]*\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prompt 规范的可读导出 —— 供 docs 生成与教研评审使用。
 * 放在代码里而不是文档里，是为了防止"文档与实现漂移"。
 */
export { OBSERVE_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT } from './llm.js';
