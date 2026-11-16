/**
 * 语音输入的测试。
 *
 * 这里只测**纯函数**那一半：拼接规则和错误码文案。真正的录音（麦克风权限、
 * 浏览器把音频送到哪）没法在 Node 里测，也不该用假实现去糊它 ——
 * 那样只会让人以为"语音测过了"。
 *
 * 这两块恰恰是"错了会很难受"的地方：
 *   拼接多一个空格   → 学生口述的句子被空格劈开，读起来别扭
 *   拼接少一个空格   → 英文、公式名连成一串，读起来更糟
 *   把 `aborted` 也当错误提示 → 学生自己按停，却被弹一句"没识别成功"
 */

import { describe, it, assert, assertEquals } from './runner.js';
import { appendTranscript, errorText, speechEngine } from '../public/voice.js';

describe('语音输入 · 识别结果拼接', () => {
  it('空草稿时就是识别结果本身', () => {
    assertEquals(appendTranscript('', '已知质量是两千克'), '已知质量是两千克');
  });

  it('接到已有草稿末尾，中间补一个空格', () => {
    assertEquals(appendTranscript('已知 m = 2 kg', '求加速度'), '已知 m = 2 kg 求加速度');
  });

  it('草稿已经以空白结尾时不再多补空格', () => {
    assertEquals(appendTranscript('已知 m = 2 kg ', '求加速度'), '已知 m = 2 kg 求加速度');
    assertEquals(appendTranscript('line one\n', 'line two'), 'line one\nline two');
  });

  it('识别结果是空的（或只有空白）时草稿一个字都不动', () => {
    assertEquals(appendTranscript('已经写好的题干', ''), '已经写好的题干');
    assertEquals(appendTranscript('已经写好的题干', '   '), '已经写好的题干');
    assertEquals(appendTranscript('已经写好的题干', null), '已经写好的题干');
  });

  it('识别结果两端多余的空格被剪掉', () => {
    assertEquals(appendTranscript('', '  求加速度  '), '求加速度');
  });

  it('null / undefined 草稿不崩', () => {
    assertEquals(appendTranscript(null, '求加速度'), '求加速度');
    assertEquals(appendTranscript(undefined, '求加速度'), '求加速度');
    assertEquals(appendTranscript(null, null), '');
  });

  it('连续口述两次能一路接下去（不乱序、不丢字）', () => {
    let draft = '';
    for (const said of ['已知质量是两千克', '动摩擦因数是零点二', '求加速度']) {
      draft = appendTranscript(draft, said);
    }
    assertEquals(draft, '已知质量是两千克 动摩擦因数是零点二 求加速度');
  });
});

describe('语音输入 · 错误提示', () => {
  it('权限没开要说去开权限，不是"再试一次"', () => {
    for (const code of ['not-allowed', 'service-not-allowed']) {
      assert(errorText(code).includes('权限'), `${code} 应提示权限`);
    }
  });

  it('学生自己按停（aborted）不弹任何提示', () => {
    assertEquals(errorText('aborted'), '');
  });

  it('网络不通时明确让学生改用文字', () => {
    assert(errorText('network').includes('文字'), 'network 应引导改用文字');
  });

  it('没听到声音 / 没有麦克风各自有话说', () => {
    assertEquals(errorText('no-speech'), '没听到声音，再说一次试试');
    assert(errorText('audio-capture').includes('麦克风'));
  });

  it('没见过的错误码也有兜底文案，不会是 undefined', () => {
    for (const code of [undefined, null, '', 'weird-error']) {
      const text = errorText(code);
      assert(typeof text === 'string' && text.length > 0, `${String(code)} 的兜底文案为空`);
    }
  });
});

describe('语音输入 · 能力探测', () => {
  it('Node 里没有 window 时返回 null，而不是抛错', () => {
    assertEquals(speechEngine(), null);
  });
});
