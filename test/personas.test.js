/**
 * 老师人格（派蒙 / 赫敏 / 诸葛亮 / 建华教授）的最小契约。
 *
 * 这一层最容易出的问题不是报错，而是“看起来没变”：
 *   选了赫敏，回复还是通用 AI 腔；或者四个人格拼出来的话一模一样。
 * 所以这里钉三件事：归一化、提示词里确实带了各自声纹、离线语气确实不同。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, assert, assertEquals, assertIncludes } from './runner.js';
import { ROOT } from '../src/core/env.js';
import {
  DEFAULT_PERSONA,
  PERSONAS,
  normalizePersona,
  personaPromptBlock,
  stylePersonaReply,
} from '../src/core/personas.js';

const chars = (text) => [...String(text ?? '').replace(/[\r\n]/g, '')].length;

describe('老师人格 · 归一化', () => {
  it('空值、未知值与中文名都能落到位，默认派蒙', () => {
    assertEquals(normalizePersona(undefined), DEFAULT_PERSONA);
    assertEquals(normalizePersona('不存在的人'), DEFAULT_PERSONA);
    assertEquals(normalizePersona(' 赫敏 '), 'hermione');
    assertEquals(normalizePersona('诸葛亮'), 'zhuge');
    assertEquals(normalizePersona('建华教授'), 'jianhua');
    assertEquals(normalizePersona({ id: 'paimon' }), 'paimon');
    assert(PERSONAS.paimon && PERSONAS.hermione && PERSONAS.zhuge && PERSONAS.jianhua, '四位老师都要有元数据');

    // 前端为了保证开场页在 /api/health 之前就能画出来，保留了一份展示数据。
    // 名字、头像、全身图任意一处漂移，学生就会看到“选的是赫敏、头像是派蒙”。
    const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
    for (const p of Object.values(PERSONAS)) {
      assertIncludes(html, `name: '${p.name}'`, `前端缺少 ${p.name} 的名字`);
      assertIncludes(html, `avatar: '${p.avatar}'`, `前端缺少 ${p.name} 的头像路径`);
      assertIncludes(html, `body: '${p.fullBody}'`, `前端缺少 ${p.name} 的全身图路径`);
      assertIncludes(html, `opening: '${p.opening}'`, `前端缺少 ${p.name} 的开场问句`);
    }
  });
});

describe('老师人格 · 提示词', () => {
  it('每位老师的提示词都带自己的声纹，而不是同一段通用话术', () => {
    const paimon = personaPromptBlock('paimon');
    const hermione = personaPromptBlock('hermione');
    const zhuge = personaPromptBlock('zhuge');
    const jianhua = personaPromptBlock('jianhua');
    assertIncludes(paimon, '自称"派蒙"', '派蒙的自称规范要进提示词');
    assertIncludes(hermione, '毒舌', '赫敏的毒舌边界要进提示词');
    assertIncludes(zhuge, '亮以为', '诸葛亮的惯用语要进提示词');
    assertIncludes(jianhua, '这里我要较个真', '建华教授的较真要进提示词');
    for (const text of [paimon, hermione, zhuge, jianhua]) {
      assertIncludes(text, '不泄露答案', '人格不能覆盖保密边界');
      assertIncludes(text, 'nextAsk 只用于探进度或澄清', '人格要约束 nextAsk，不能变成派任务');
    }
  });
});

describe('老师人格 · 离线语气', () => {
  const input = {
    text: '你打算用的这个规律，它成立需要满足什么前提？',
    nextAsk: '检查这个规律的前提，然后告诉我哪一条最可疑。',
    form: 'condition_question',
    level: 1,
  };

  it('同一句话在四种人格下措辞不同，但核心物理信息不丢', () => {
    const texts = ['paimon', 'hermione', 'zhuge', 'jianhua'].map((id) => stylePersonaReply(id, input).text);
    assertEquals(new Set(texts).size, 4, '四位老师的离线措辞不能完全一样');
    for (const text of texts) assertIncludes(text, '规律', '替换措辞时不能把物理信息删掉');
    assert(/^诶，/.test(texts[0]), '派蒙应当有软萌开场');
    assert(/^啧，/.test(texts[1]), '赫敏应当有毒舌开场');
    assert(/^亮以为，/.test(texts[2]), '诸葛亮应当有丞相腔开场');
    assert(/^嗯。/.test(texts[3]), '建华教授应当有严谨开场');
  });

  it('接近上限的长回复不再追加语气，避免突破 150 字', () => {
    const out = stylePersonaReply('paimon', {
      text: '物'.repeat(120),
      nextAsk: '再说一遍这一步的依据是什么。',
      form: 'direction',
      level: 2,
    });
    const composed = `提示：${out.text}${out.nextAsk ? `试一试：${out.nextAsk}` : ''}`;
    assert(chars(composed) <= 150, `加了人格后仍不能超过 150 字，实际 ${chars(composed)}`);
  });

  it('静默轮也像老师本人，而不是一句通用“我看看”', () => {
    const lines = ['paimon', 'hermione', 'zhuge', 'jianhua'].map(
      (id) => stylePersonaReply(id, { text: '我在旁边看着。', nextAsk: '继续。', form: 'silent', level: 0 }),
    );
    assertEquals(new Set(lines.map((x) => x.text)).size, 4, '四位老师的静默话术不能一样');
    for (const line of lines) assertEquals(line.nextAsk, null, '静默轮不该再派一个任务');
  });
});
