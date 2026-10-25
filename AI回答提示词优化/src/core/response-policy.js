/** 对最终学生可见文本检查，不截断、不删除公式或限定条件。 */
export const REPLY_POLICY = Object.freeze({ targetMin: 60, targetMax: 100, hardMax: 150 });
export const countReplyChars = text => [...String(text).replace(/[\r\n]/g, '')].length;
export function checkReplyFormat(text) {
  const count = countReplyChars(text);
  const violations = [];
  if (!String(text).trim()) violations.push({ kind: 'reply_format', detail: '回复为空' });
  if (count > REPLY_POLICY.hardMax) violations.push({ kind: 'reply_format', detail: `整条回复${count}字，超过150字；请完整重写，不截断` });
  if (String(text).split(/\r?\n/).filter(line => line.trim()).length > 3) violations.push({ kind: 'reply_format', detail: '回复最多三行，请压缩为一个方向和一个任务' });
  if ((String(text).match(/[？?]/g) || []).length > 1) violations.push({ kind: 'reply_format', detail: '只能留一个具体问题；正文给信息，nextAsk给唯一任务' });
  if (/置信度|candidateMisconception|referenceAnswer|我理解你的意思是/.test(text)) violations.push({ kind: 'reply_format', detail: '不要展示内部诊断或长篇复述' });
  return { passed: violations.length === 0, violations, count, outsideTarget: count < 60 || count > 100 };
}
